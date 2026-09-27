/**
 * Unit tests for the NTFS MFT parser.
 *
 * These build synthetic FILE records on the heap so the binary parsing
 * (update-sequence fixup, attribute walking, namespace selection, data run
 * decoding) is verified without needing an elevated process or a real volume.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeDataRuns,
  applyFixup,
  parseRecord,
  pickBestName,
  filetimeToUnixMs,
  parseBootSector,
  assignRecordIndices,
  FIXUP_STRIDE,
  NTFS,
} from '../src/mft/ntfs.js';

const RECORD_SIZE = 1024;
// NTFS repairs records in fixed 512-byte blocks, NOT volume sectors. The
// synthetic records below therefore use 512 as their stride regardless of the
// sector size the fake boot sector advertises.
const SECTOR_SIZE = FIXUP_STRIDE;

/** FILETIME ticks for a given Unix ms. */
function unixMsToFiletime(ms) {
  return BigInt(Math.round(ms + 11644473600000)) * 10000n;
}

/** Build one synthetic FILE record exercising the attributes the parser reads. */
function buildRecord({
  name = 'report.pdf',
  parent = 5,
  size = 4096,
  modifiedMs = Date.UTC(2022, 8, 26, 8, 13, 32),
  createdMs = Date.UTC(2022, 8, 26, 8, 13, 32),
  isDirectory = false,
  namespace = NTFS.NS_WIN32_AND_DOS,
  extraNames = [],
  inUse = true,
  corruptFixup = false,
  sequence = 1,
} = {}) {
  const buf = Buffer.alloc(RECORD_SIZE);

  buf.write('FILE', 0, 'latin1');
  buf.writeUInt16LE(48, 4);           // USA offset
  buf.writeUInt16LE(3, 6);            // USA count = sectors + 1
  buf.writeUInt16LE(sequence, 16);
  buf.writeUInt16LE(1, 18);           // hard link count
  buf.writeUInt16LE(56, 20);          // first attribute offset
  buf.writeUInt16LE((inUse ? 1 : 0) | (isDirectory ? 2 : 0), 22);
  buf.writeUInt32LE(0, 32);           // base record ref = 0 (a base record)

  let p = 56;

  // $STANDARD_INFORMATION (resident, 0x48 bytes of content)
  {
    const contentLen = 72;
    const attrLen = 24 + contentLen;
    buf.writeUInt32LE(NTFS.ATTR_STANDARD_INFORMATION, p);
    buf.writeUInt32LE(attrLen, p + 4);
    buf[p + 8] = 0;                   // resident
    buf.writeUInt16LE(24, p + 20);    // content offset
    buf.writeUInt32LE(contentLen, p + 16);
    const c = p + 24;
    buf.writeBigUInt64LE(unixMsToFiletime(createdMs), c);
    buf.writeBigUInt64LE(unixMsToFiletime(modifiedMs), c + 8);
    buf.writeBigUInt64LE(unixMsToFiletime(modifiedMs), c + 16);
    buf.writeBigUInt64LE(unixMsToFiletime(modifiedMs), c + 24);
    buf.writeUInt32LE(0x20, c + 32);  // FILE_ATTRIBUTE_ARCHIVE
    p += attrLen;
  }

  // One or more $FILE_NAME attributes
  const names = [{ name, namespace }, ...extraNames];
  for (const entry of names) {
    const nameBuf = Buffer.from(entry.name, 'utf16le');
    const contentLen = 66 + nameBuf.length;
    const attrLen = Math.ceil((24 + contentLen) / 8) * 8;
    buf.writeUInt32LE(NTFS.ATTR_FILE_NAME, p);
    buf.writeUInt32LE(attrLen, p + 4);
    buf[p + 8] = 0;
    buf.writeUInt16LE(24, p + 20);
    buf.writeUInt32LE(contentLen, p + 16);
    const c = p + 24;
    buf.writeBigUInt64LE(BigInt(parent), c);
    buf.writeBigUInt64LE(unixMsToFiletime(createdMs), c + 8);
    buf.writeBigUInt64LE(unixMsToFiletime(modifiedMs), c + 16);
    buf.writeBigUInt64LE(unixMsToFiletime(modifiedMs), c + 24);
    buf.writeBigUInt64LE(unixMsToFiletime(modifiedMs), c + 32);
    buf.writeBigInt64LE(BigInt(Math.ceil(size / 4096) * 4096), c + 40); // allocated
    buf.writeBigInt64LE(BigInt(size), c + 48);
    buf[c + 64] = entry.name.length;
    buf[c + 65] = entry.namespace;
    nameBuf.copy(buf, c + 66);
    p += attrLen;
  }

  // Unnamed $DATA (resident) carrying the real size
  {
    const contentLen = Math.min(size, 64);
    const attrLen = Math.ceil((24 + contentLen) / 8) * 8;
    buf.writeUInt32LE(NTFS.ATTR_DATA, p);
    buf.writeUInt32LE(attrLen, p + 4);
    buf[p + 8] = 0;
    buf.writeUInt16LE(24, p + 20);
    buf.writeUInt32LE(contentLen, p + 16);
    p += attrLen;
  }

  buf.writeUInt32LE(0xffffffff, p);   // attribute end marker
  const usedSize = p + 8;
  buf.writeUInt32LE(usedSize, 24);
  buf.writeUInt32LE(RECORD_SIZE, 28);

  // Write the USA trailer values, then stash the originals in the fixup array.
  const usn = 0x0001;
  buf.writeUInt16LE(usn, 48);
  for (let s = 0; s < RECORD_SIZE / SECTOR_SIZE; s++) {
    const trailer = (s + 1) * SECTOR_SIZE - 2;
    const original = buf.readUInt16LE(trailer);
    buf.writeUInt16LE(original, 48 + 2 * (s + 1));
    buf.writeUInt16LE(corruptFixup && s === 0 ? 0xdead : usn, trailer);
  }
  return buf;
}

test('decodeDataRuns handles positive and negative LCN deltas', () => {
  // run 1: header 0x21 -> 1 length byte, 2 offset bytes; len=0x20, offset=0x1000
  // run 2: header 0x11 -> 1 length byte, 1 offset byte; len=0x10, offset=+0x20
  // run 3: header 0x01 -> sparse, len=0x08
  // terminator 0x00
  const runs = Buffer.from([0x21, 0x20, 0x00, 0x10, 0x11, 0x10, 0x20, 0x01, 0x08, 0x00]);
  const extents = decodeDataRuns(runs);
  assert.equal(extents.length, 3);
  assert.deepEqual(
    extents.map((e) => ({ lcn: e.lcn, clusters: e.clusters, sparse: e.sparse })),
    [
      { lcn: 0x1000, clusters: 0x20, sparse: false },
      { lcn: 0x1020, clusters: 0x10, sparse: false },
      { lcn: 0x1020, clusters: 0x08, sparse: true },
    ],
  );
});

test('decodeDataRuns sign-extends a negative delta', () => {
  // First run: 2-byte offset 0x1000, 0x10 clusters.
  // Second run: 1-byte offset 0xF0 must sign-extend to -16, so LCN goes 0x1000 -> 0x0FF0.
  const runs = Buffer.from([0x21, 0x10, 0x00, 0x10, 0x11, 0x08, 0xf0, 0x00]);
  const extents = decodeDataRuns(runs);
  assert.equal(extents.length, 2);
  assert.equal(extents[0].lcn, 0x1000);
  assert.equal(extents[1].lcn, 0x0ff0);
  assert.equal(extents[1].clusters, 0x08);
});

test('decodeDataRuns refuses to produce a negative LCN', () => {
  // A 1-byte signed offset of -16 applied from LCN 0 is corrupt data.
  assert.throws(() => decodeDataRuns(Buffer.from([0x11, 0x08, 0xf0, 0x00])), /negative LCN/);
});

test('decodeDataRuns stops at the terminating zero byte', () => {
  const runs = Buffer.from([0x11, 0x08, 0x40, 0x00, 0x11, 0x08, 0x40]);
  const extents = decodeDataRuns(runs);
  assert.equal(extents.length, 1);
  assert.equal(extents[0].lcn, 0x40);
});

test('applyFixup restores the real trailer bytes', () => {
  const buf = buildRecord();
  const trailerBefore = buf.readUInt16LE(SECTOR_SIZE - 2);
  assert.equal(trailerBefore, 0x0001, 'fixup should have stamped the USN at the sector end');
  assert.equal(applyFixup(buf, 0, RECORD_SIZE), true);
  assert.notEqual(buf.readUInt16LE(SECTOR_SIZE - 2), 0x0001, 'trailer should be restored');
});

test('applyFixup rejects a record with a torn sector trailer', () => {
  const buf = buildRecord({ corruptFixup: true });
  assert.equal(applyFixup(buf, 0, RECORD_SIZE), false);
});

/**
 * Build a wide record (e.g. 4096 bytes) whose fixup uses 9 USA entries. This is
 * the shape a big-record volume uses, and it is where a parser that confuses the
 * fixup stride with the volume sector size goes wrong.
 */
function buildWideRecord({ recordSize = 4096, name = 'wide.bin', size = 123, parent = 5 } = {}) {
  const blocks = recordSize / FIXUP_STRIDE;
  const usaCount = blocks + 1;
  const buf = Buffer.alloc(recordSize);

  buf.write('FILE', 0, 'latin1');
  const usaOffset = 48;
  buf.writeUInt16LE(usaOffset, 4);
  buf.writeUInt16LE(usaCount, 6);
  buf.writeUInt16LE(1, 16);
  buf.writeUInt16LE(1, 18);
  const attrStart = 48 + usaCount * 2;
  buf.writeUInt16LE(attrStart, 20);
  buf.writeUInt16LE(1, 22);

  let p = attrStart;
  // $FILE_NAME only: enough to exercise the parser across block boundaries.
  const nameBuf = Buffer.from(name, 'utf16le');
  const contentLen = 66 + nameBuf.length;
  const attrLen = Math.ceil((24 + contentLen) / 8) * 8;
  buf.writeUInt32LE(NTFS.ATTR_FILE_NAME, p);
  buf.writeUInt32LE(attrLen, p + 4);
  buf[p + 8] = 0;
  buf.writeUInt16LE(24, p + 20);
  buf.writeUInt32LE(contentLen, p + 16);
  const c = p + 24;
  buf.writeBigUInt64LE(BigInt(parent), c);
  const ticks = unixMsToFiletime(Date.UTC(2022, 8, 26));
  for (const off of [8, 16, 24, 32]) buf.writeBigUInt64LE(ticks, c + off);
  buf.writeBigInt64LE(BigInt(size), c + 48);
  buf[c + 64] = name.length;
  buf[c + 65] = NTFS.NS_WIN32_AND_DOS;
  nameBuf.copy(buf, c + 66);
  p += attrLen;
  buf.writeUInt32LE(0xffffffff, p);
  buf.writeUInt32LE(p + 8, 24);
  buf.writeUInt32LE(recordSize, 28);

  const usn = 0x00ab;
  buf.writeUInt16LE(usn, usaOffset);
  for (let b = 0; b < blocks; b++) {
    const trailer = (b + 1) * FIXUP_STRIDE - 2;
    buf.writeUInt16LE(buf.readUInt16LE(trailer), usaOffset + 2 * (b + 1));
    buf.writeUInt16LE(usn, trailer);
  }
  return buf;
}

test('fixup walks 512-byte blocks on a 4096-byte record', () => {
  const buf = buildWideRecord();
  // Nine entries: one USN plus one saved word per 512-byte block.
  assert.equal(buf.readUInt16LE(6), 9);

  // Note: applyFixup rewrites the trailers, so it is not idempotent. Assert on
  // parseRecord (which applies it once) rather than calling it twice here.
  const rec = parseRecord(buf, 0, 4096, 11);
  assert.ok(rec, 'wide record should parse');
  assert.equal(rec.name, 'wide.bin');
  assert.equal(rec.realSize, 123);
  assert.equal(rec.recordNumber, 11);

  // Every trailer must have been restored away from the USN.
  for (let b = 0; b < 8; b++) {
    const trailer = (b + 1) * FIXUP_STRIDE - 2;
    assert.notEqual(buf.readUInt16LE(trailer), 0x00ab, `block ${b} trailer not restored`);
  }
});

test('applyFixup rejects fixup metadata that cannot describe the record', () => {
  // usa_count wrong for the record size: a 1024-byte record needs exactly 3.
  const bad = buildRecord();
  bad.writeUInt16LE(4, 6);
  assert.equal(applyFixup(bad, 0, RECORD_SIZE), false);

  // Odd USA offset is illegal.
  const odd = buildRecord();
  odd.writeUInt16LE(49, 4);
  assert.equal(applyFixup(odd, 0, RECORD_SIZE), false);

  // The array must fit inside the first 512-byte block.
  const far = buildRecord();
  far.writeUInt16LE(510, 4);
  assert.equal(applyFixup(far, 0, RECORD_SIZE), false);
});

test('a record whose bytes-per-sector is 4096 still fixes up on a 512 stride', () => {
  // This is the 4Kn case: the volume advertises 4096-byte sectors, but NTFS
  // still repairs the 1024-byte record in two 512-byte blocks. A parser that
  // used the sector size as the stride would look for trailers at 4094 and fail.
  const boot = Buffer.alloc(512);
  boot.write('NTFS    ', 3, 'latin1');
  boot.writeUInt16LE(4096, 11);   // bytes per sector = 4096 (4Kn)
  boot[13] = 1;                   // 1 sector per cluster => 4096-byte clusters
  boot.writeBigInt64LE(1000n, 40);
  boot.writeBigInt64LE(4n, 48);
  boot.writeBigInt64LE(8n, 56);
  boot.writeInt8(-10, 64);        // 1024-byte records
  const parsed = parseBootSector(boot, 'D:');
  assert.equal(parsed.bytesPerSector, 4096);
  assert.equal(parsed.recordSize, 1024);

  // Parsing succeeds without the parser ever being told the sector size.
  const rec = parseRecord(buildRecord({ name: 'four-kn.txt' }), 0, parsed.recordSize, 2);
  assert.ok(rec, '4Kn record should parse');
  assert.equal(rec.name, 'four-kn.txt');
});

test('parseRecord extracts name, size, parent and timestamps', () => {
  const modifiedMs = Date.UTC(2022, 5, 29, 2, 0, 0); // 2022-06-29
  const buf = buildRecord({ name: '镜湖站联络线三角区结构图(1).dwg', size: 4003552, modifiedMs, parent: 42 });
  const rec = parseRecord(buf, 0, RECORD_SIZE, 7);

  assert.ok(rec, 'record should parse');
  assert.equal(rec.name, '镜湖站联络线三角区结构图(1).dwg');
  assert.equal(rec.realSize, 4003552);
  assert.equal(rec.dataSize, 64); // resident $DATA content length
  assert.equal(rec.parent, 42);
  assert.equal(rec.recordNumber, 7);
  assert.equal(rec.isDirectory, false);
  assert.equal(new Date(rec.modifiedMs).toISOString(), new Date(modifiedMs).toISOString());
});

test('parseRecord rejects corrupt-fixup and free records', () => {
  assert.equal(parseRecord(buildRecord({ corruptFixup: true }), 0, RECORD_SIZE, 0), null);
  assert.equal(parseRecord(buildRecord({ inUse: false }), 0, RECORD_SIZE, 0), null);
  const zeroed = Buffer.alloc(RECORD_SIZE);
  assert.equal(parseRecord(zeroed, 0, RECORD_SIZE, 0), null);
});

test('parseRecord flags directories', () => {
  const rec = parseRecord(buildRecord({ name: '2022-09', isDirectory: true }), 0, RECORD_SIZE, 3);
  assert.ok(rec);
  assert.equal(rec.isDirectory, true);
});

test('pickBestName prefers Win32&DOS and ignores the 8.3 alias', () => {
  const best = pickBestName([
    { namespace: NTFS.NS_WIN32_AND_DOS, name: '季度报告 2022.docx' },
    { namespace: NTFS.NS_DOS, name: 'QUARTE~1.DOC' },
  ]);
  assert.equal(best.name, '季度报告 2022.docx');
});

test('pickBestName falls back through namespaces in priority order', () => {
  assert.equal(pickBestName([{ namespace: NTFS.NS_WIN32, name: 'a.txt' }, { namespace: NTFS.NS_POSIX, name: 'b.txt' }]).name, 'a.txt');
  assert.equal(pickBestName([{ namespace: NTFS.NS_DOS, name: 'SHORT~1.TXT' }, { namespace: NTFS.NS_POSIX, name: 'long name.txt' }]).name, 'long name.txt');
  assert.equal(pickBestName([{ namespace: NTFS.NS_DOS, name: 'SHORT~1.TXT' }]).name, 'SHORT~1.TXT');
  assert.equal(pickBestName([]), null);
});

test('parseRecord picks the long name when an 8.3 alias is also present', () => {
  const buf = buildRecord({
    name: '工程例会纪要（2022-9-29）.docx',
    namespace: NTFS.NS_WIN32_AND_DOS,
    extraNames: [{ name: '工程~1.DOC', namespace: NTFS.NS_DOS }],
  });
  const rec = parseRecord(buf, 0, RECORD_SIZE, 1);
  assert.equal(rec.name, '工程例会纪要（2022-9-29）.docx');
});

test('filetimeToUnixMs converts and guards unset values', () => {
  assert.equal(filetimeToUnixMs(0n), 0);
  assert.equal(filetimeToUnixMs(unixMsToFiletime(Date.UTC(2022, 0, 1))), Date.UTC(2022, 0, 1));
});

test('assignRecordIndices numbers records from the start of the $MFT stream', () => {
  // The real geometry measured on a 464 GB volume: a 2-run $MFT whose first run
  // sits 3 GB into the disk. Record 0 must come out as 0, NOT as
  // lcn*clusterSize/recordSize == 3145728.
  const extents = [
    { lcn: 786432, clusters: 51264, sparse: false },
    { lcn: 33018253, clusters: 8064, sparse: false },
  ];
  const positioned = assignRecordIndices(extents, 4096, 1024);

  assert.equal(positioned[0].startRecord, 0);
  assert.equal(positioned[0].recordCount, Math.floor((51264 * 4096) / 1024));
  assert.equal(positioned[1].startRecord, positioned[0].recordCount);
  assert.equal(positioned[1].recordCount, 32256);

  // Guard against the specific regression: an index derived from the LCN.
  const lcnDerived = Math.floor((786432 * 4096) / 1024);
  assert.equal(lcnDerived, 3145728);
  assert.notEqual(positioned[0].startRecord, lcnDerived);
});

test('assignRecordIndices keeps numbering contiguous across a sparse extent', () => {
  const positioned = assignRecordIndices([
    { lcn: 10, clusters: 8, sparse: false },   // 8*4096/1024 = 32 records
    { lcn: 999, clusters: 4, sparse: true },   // sparse: contributes nothing
    { lcn: 20, clusters: 2, sparse: false },   // 8 records
  ], 4096, 1024);

  assert.equal(positioned[0].startRecord, 0);
  assert.equal(positioned[1].startRecord, 32);
  assert.equal(positioned[1].recordCount, 0);
  assert.equal(positioned[2].startRecord, 32, 'a sparse run must not advance the numbering');
  assert.equal(positioned[2].recordCount, 8);
});

test('assignRecordIndices yields a single run covering all records for a contiguous $MFT', () => {
  const positioned = assignRecordIndices([{ lcn: 4, clusters: 250, sparse: false }], 4096, 1024);
  assert.equal(positioned.length, 1);
  assert.equal(positioned[0].startRecord, 0);
  assert.equal(positioned[0].recordCount, 1000);
});

test('parseBootSector decodes the signed record-size field', () => {
  const boot = Buffer.alloc(512);
  boot.write('NTFS    ', 3, 'latin1');
  boot.writeUInt16LE(512, 11);
  boot[13] = 8;                        // 4096-byte clusters
  boot.writeBigInt64LE(1000n, 40);
  boot.writeBigInt64LE(4n, 48);
  boot.writeBigInt64LE(8n, 56);
  boot.writeInt8(-10, 64);             // 2^10 = 1024
  boot.writeInt8(1, 68);               // 1 cluster = 4096
  boot.writeBigUInt64LE(0x1122334455667788n, 72);

  const parsed = parseBootSector(boot, 'D:');
  assert.equal(parsed.clusterSize, 4096);
  assert.equal(parsed.recordSize, 1024);
  assert.equal(parsed.indexBufferSize, 4096);
  assert.equal(parsed.mftCluster, 4);
  assert.equal(parsed.volumeSerial, 0x1122334455667788n);

  boot.writeInt8(2, 64);               // positive: 2 clusters = 8192 bytes
  assert.equal(parseBootSector(boot, 'D:').recordSize, 8192);

  boot.write('FAT32   ', 3, 'latin1');
  assert.throws(() => parseBootSector(boot, 'D:'), /not NTFS/);
});
