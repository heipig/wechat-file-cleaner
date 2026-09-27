/**
 * NTFS MFT reader.
 *
 * Opens a raw NTFS volume read-only, parses the boot sector, follows the $MFT
 * file's $DATA data runs, and streams every in-use FILE record to extract a
 * name, real size, and timestamps. This is the same trick Everything uses: no
 * directory traversal, so a multi-million-file volume enumerates in seconds.
 *
 * Requires an elevated process (Administrator) to open \\.\X:.
 *
 * References:
 *   - Linux-NTFS project documentation (boot sector, FILE record, attributes)
 *   - Microsoft [MS-FSCC] / [MS-NTFS] open specifications
 *
 * All reads are positional and read-only; nothing is ever written to the volume.
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

/** Attribute type codes we care about. */
const ATTR_STANDARD_INFORMATION = 0x10;
const ATTR_ATTRIBUTE_LIST = 0x20;
const ATTR_FILE_NAME = 0x30;
const ATTR_DATA = 0x80;
const ATTR_END = 0xffffffff;

/** FILE record flags. */
const RECORD_IN_USE = 0x0001;
const RECORD_IS_DIRECTORY = 0x0002;

/** $FILE_NAME namespace values. */
const NS_POSIX = 0;
const NS_WIN32 = 1;
const NS_DOS = 2;
const NS_WIN32_AND_DOS = 3;

const FILE_SIGNATURE = 0x454c4946; // "FILE" little-endian

/** FILETIME epoch (1601-01-01) to Unix epoch, in milliseconds. */
const FILETIME_EPOCH_DELTA_MS = 11644473600000;

/**
 * Convert a Windows FILETIME (100ns ticks since 1601-01-01 UTC) to Unix ms.
 * Values of 0 (unset) and absurd values are clamped to 0 so callers never see NaN.
 * @param {bigint} ticks
 * @returns {number} Unix epoch milliseconds, or 0 when unset/unrepresentable.
 */
export function filetimeToUnixMs(ticks) {
  if (ticks <= 0n) return 0;
  const ms = Number(ticks / 10000n) - FILETIME_EPOCH_DELTA_MS;
  if (!Number.isFinite(ms) || ms < 0 || ms > 8640000000000000) return 0;
  return ms;
}

/**
 * Open a raw volume handle for reading.
 * @param {string} driveLetter Single letter such as "D" or "D:".
 * @returns {number} file descriptor; caller must close it.
 */
export function openVolume(driveLetter) {
  const letter = String(driveLetter).replace(/[\\:]/g, '').slice(0, 1).toUpperCase();
  if (!/^[A-Z]$/.test(letter)) throw new Error(`invalid drive letter: ${driveLetter}`);
  // Node's fs layer passes the path straight to CreateFileW. \\.\X: is the
  // device namespace spelling that yields a raw volume handle.
  return openSync(`\\\\.\\${letter}:`, 'r');
}

/**
 * Read exactly `length` bytes at `offset`, looping because a single pread on a
 * raw device may return short.
 * @param {number} fd
 * @param {Buffer} buffer Destination buffer.
 * @param {number} offset Absolute byte offset on the volume.
 * @param {number} length Bytes to read.
 * @param {number} [positionInBuffer] Where in `buffer` to start writing.
 */
export function readExact(fd, buffer, offset, length, positionInBuffer = 0) {
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, positionInBuffer + done, length - done, offset + done);
    if (n <= 0) throw new Error(`short read at volume offset ${offset + done} (${done}/${length} bytes)`);
    done += n;
  }
  return done;
}

/**
 * Parse an NTFS boot sector ($Boot).
 * @param {Buffer} boot At least 512 bytes starting at volume offset 0.
 * @param {string} [drive] Drive label used only in error messages.
 * @returns {{bytesPerSector:number, sectorsPerCluster:number, clusterSize:number,
 *   totalSectors:number, volumeSerial:bigint, mftCluster:number, mftMirrorCluster:number,
 *   recordSize:number, indexBufferSize:number, oem:string}}
 */
export function parseBootSector(boot, drive = '?') {
  if (boot.length < 512) throw new Error('boot sector buffer shorter than 512 bytes');
  const oem = boot.toString('latin1', 3, 11);
  if (oem !== 'NTFS    ') throw new Error(`${drive} is not NTFS (OEM id "${oem}")`);

  const bytesPerSector = boot.readUInt16LE(11);
  const sectorsPerCluster = boot[13];
  if (!bytesPerSector || !sectorsPerCluster) throw new Error('boot sector reports a zero sector/cluster size');

  const totalSectors = Number(boot.readBigInt64LE(40));
  const mftCluster = Number(boot.readBigInt64LE(48));
  const mftMirrorCluster = Number(boot.readBigInt64LE(56));
  const volumeSerial = boot.readBigUInt64LE(72);

  // Signed: a positive value is a count of clusters, a negative value means
  // 2^-n bytes. e.g. -10 -> 1024 bytes, 1 -> 1 cluster.
  const mftRecordSizeRaw = boot.readInt8(64);
  const recordSize = mftRecordSizeRaw > 0
    ? mftRecordSizeRaw * bytesPerSector * sectorsPerCluster
    : 2 ** -mftRecordSizeRaw;

  const indexBufferSizeRaw = boot.readInt8(68);
  const indexBufferSize = indexBufferSizeRaw > 0
    ? indexBufferSizeRaw * bytesPerSector * sectorsPerCluster
    : 2 ** -indexBufferSizeRaw;

  if (recordSize < 512 || recordSize > 65536 || (recordSize & (recordSize - 1)) !== 0) {
    throw new Error(`implausible MFT record size ${recordSize} (raw field ${mftRecordSizeRaw})`);
  }

  return {
    oem,
    bytesPerSector,
    sectorsPerCluster,
    clusterSize: bytesPerSector * sectorsPerCluster,
    totalSectors,
    volumeSerial,
    mftCluster,
    mftMirrorCluster,
    recordSize,
    indexBufferSize,
  };
}

/**
 * Decode an NTFS data run list into cluster extents.
 *
 * Each run starts with a header byte whose low nibble is the byte width of the
 * run length and whose high nibble is the byte width of the (signed) offset
 * delta relative to the previous run's LCN. An offset width of 0 marks a sparse
 * run. A header byte of 0 terminates the list.
 *
 * @param {Buffer} runs Raw run list bytes.
 * @returns {Array<{lcn:number, clusters:number, sparse:boolean}>}
 */
export function decodeDataRuns(runs) {
  const extents = [];
  let i = 0;
  let lcn = 0;
  while (i < runs.length) {
    const header = runs[i++];
    if (header === 0) break;
    const lengthWidth = header & 0x0f;
    const offsetWidth = (header >> 4) & 0x0f;
    if (lengthWidth === 0 || i + lengthWidth + offsetWidth > runs.length) break;

    let clusters = 0;
    for (let k = 0; k < lengthWidth; k++) clusters += runs[i + k] * 2 ** (8 * k);
    i += lengthWidth;

    if (offsetWidth === 0) {
      extents.push({ lcn, clusters, sparse: true });
      continue;
    }

    // Signed little-endian delta, sign-extended from offsetWidth bytes.
    let delta = 0;
    for (let k = 0; k < offsetWidth; k++) delta += runs[i + k] * 2 ** (8 * k);
    const signBit = 2 ** (8 * offsetWidth - 1);
    if (delta >= signBit) delta -= 2 ** (8 * offsetWidth);
    i += offsetWidth;

    lcn += delta;
    if (lcn < 0) throw new Error('data run decode walked to a negative LCN');
    extents.push({ lcn, clusters, sparse: false });
  }
  return extents;
}

/** NTFS's fixed update-sequence stride, independent of the volume sector size. */
export const FIXUP_STRIDE = 512;

/**
 * Apply the NTFS update sequence array (fixup) to a raw FILE record in place.
 *
 * NTFS stores the real last two bytes of each 512-byte block in a fixup array
 * and puts the update sequence number there instead. A torn write is detectable
 * because those trailer bytes stop matching. Restoring them is mandatory before
 * reading any structure that spans a block boundary.
 *
 * The stride is the hardcoded NTFS_BLOCK_SIZE (512), NOT the volume's
 * bytes-per-sector: a 1024-byte record always has usa_count 3 with repair sites
 * at 510 and 1022, even on a 4Kn (4096-byte sector) volume. Using the sector
 * size here silently fails to parse every record on such a volume.
 *
 * NOT idempotent: it overwrites each trailer with the saved word, so calling it
 * twice on the same buffer fails the second time (the USN is no longer there to
 * match). Apply it exactly once per record.
 *
 * @param {Buffer} buf Buffer holding the record (modified in place).
 * @param {number} base Offset of the record inside `buf`.
 * @param {number} recordSize Size of the record.
 * @returns {boolean} true when the fixup applied cleanly.
 */
export function applyFixup(buf, base, recordSize) {
  if (base + 8 > buf.length) return false;
  const usaOffset = buf.readUInt16LE(base + 4);
  const usaCount = buf.readUInt16LE(base + 6);

  // Reject malformed fixup metadata rather than repairing a corrupt record.
  if (usaOffset % 2 !== 0) return false;
  if (usaCount !== recordSize / FIXUP_STRIDE + 1) return false;
  // The array must live inside the record's first block.
  if (usaOffset + usaCount * 2 > FIXUP_STRIDE) return false;
  if (usaCount <= 1) return true; // nothing to restore
  if (base + usaOffset + usaCount * 2 > buf.length) return false;

  const blocksInRecord = recordSize / FIXUP_STRIDE;
  const usn = buf.readUInt16LE(base + usaOffset);
  for (let b = 0; b < blocksInRecord; b++) {
    const trailer = base + (b + 1) * FIXUP_STRIDE - 2;
    if (trailer + 2 > buf.length) return false;
    if (buf.readUInt16LE(trailer) !== usn) return false; // torn/corrupt record
    buf.writeUInt16LE(buf.readUInt16LE(base + usaOffset + 2 * (b + 1)), trailer);
  }
  return true;
}

/**
 * Pick the best name from the $FILE_NAME attributes of one record.
 *
 * A record can carry several names: a POSIX name, a long Win32 name, an 8.3 DOS
 * alias, or a combined Win32&DOS name. Emitting all of them would double-count
 * files, so prefer namespace 3, then 1, then 0, and ignore 2 unless it is all
 * we have.
 *
 * @param {Array<{namespace:number, name:string}>} candidates
 * @returns {{namespace:number, name:string}|null}
 */
export function pickBestName(candidates) {
  if (!candidates.length) return null;
  const rank = (ns) => (ns === NS_WIN32_AND_DOS ? 0 : ns === NS_WIN32 ? 1 : ns === NS_POSIX ? 2 : 3);
  let best = candidates[0];
  for (const c of candidates) if (rank(c.namespace) < rank(best.namespace)) best = c;
  return best;
}

/**
 * Parse one FILE record.
 *
 * `recordNumber` is passed in rather than derived from the buffer: the correct
 * value is the record's absolute index in the $MFT (the byte offset divided by
 * the record size), which callers know and the record body cannot reliably
 * supply.
 *
 * @param {Buffer} buf Buffer holding the record at `base`.
 * @param {number} base Offset of the record inside `buf`.
 * @param {number} recordSize Record size in bytes.
 * @param {number} recordNumber Absolute MFT record index.
 * @returns {null|object} Parsed record, or null when it is free/corrupt/unusable.
 */
export function parseRecord(buf, base, recordSize, recordNumber) {
  if (base + recordSize > buf.length) return null;
  if (buf.readUInt32LE(base) !== FILE_SIGNATURE) return null;
  if (!applyFixup(buf, base, recordSize)) return null;

  const flags = buf.readUInt16LE(base + 22);
  const inUse = (flags & RECORD_IN_USE) !== 0;
  if (!inUse) return null;

  const usedSize = buf.readUInt32LE(base + 24);
  const baseRef = buf.readBigUInt64LE(base + 32);
  const headerSize = buf.readUInt16LE(base + 20);

  const out = {
    recordNumber,
    baseRecord: baseRef === 0n ? 0 : Number(baseRef & 0xffffffffffffn),
    sequence: buf.readUInt16LE(base + 16),
    isDirectory: (flags & RECORD_IS_DIRECTORY) !== 0,
    names: [],
    si: null,
    dataSize: -1,
    hasAttributeList: false,
  };

  const end = Math.min(base + usedSize, base + recordSize);
  let p = base + headerSize;
  let guard = 0;

  while (p + 8 <= end && guard++ < 4096) {
    const type = buf.readUInt32LE(p);
    if (type === ATTR_END) break;
    const length = buf.readUInt32LE(p + 4);
    if (length < 16 || p + length > end) break;
    const nonResident = buf[p + 8];
    const nameLength = buf[p + 9];
    const nameOffset = buf.readUInt16LE(p + 10);
    void nameOffset;

    if (type === ATTR_ATTRIBUTE_LIST) out.hasAttributeList = true;

    // Skip named attributes for $FILE_NAME/$DATA: the unnamed ones are the
    // real file, named ones are alternate data streams.
    const isUnnamed = nameLength === 0;
    void nameOffset;

    if (type === ATTR_STANDARD_INFORMATION && nonResident === 0 && !out.si) {
      const contentOffset = buf.readUInt16LE(p + 20);
      const c = p + contentOffset;
      if (c + 36 <= p + length) {
        out.si = {
          createdMs: filetimeToUnixMs(buf.readBigUInt64LE(c)),
          modifiedMs: filetimeToUnixMs(buf.readBigUInt64LE(c + 8)),
          mftChangedMs: filetimeToUnixMs(buf.readBigUInt64LE(c + 16)),
          accessedMs: filetimeToUnixMs(buf.readBigUInt64LE(c + 24)),
          attributes: buf.readUInt32LE(c + 32),
        };
      }
    } else if (type === ATTR_FILE_NAME && nonResident === 0) {
      const contentOffset = buf.readUInt16LE(p + 20);
      const c = p + contentOffset;
      if (c + 66 <= p + length) {
        const parentRef = buf.readBigUInt64LE(c);
        const nameLen = buf[c + 64];
        const namespace = buf[c + 65];
        const nameEnd = c + 66 + nameLen * 2;
        if (nameLen > 0 && nameEnd <= p + length) {
          out.names.push({
            parent: Number(parentRef & 0xffffffffffffn),
            parentSequence: Number(parentRef >> 48n),
            createdMs: filetimeToUnixMs(buf.readBigUInt64LE(c + 8)),
            modifiedMs: filetimeToUnixMs(buf.readBigUInt64LE(c + 16)),
            mftChangedMs: filetimeToUnixMs(buf.readBigUInt64LE(c + 24)),
            accessedMs: filetimeToUnixMs(buf.readBigUInt64LE(c + 32)),
            allocatedSize: Number(buf.readBigInt64LE(c + 40)),
            realSize: Number(buf.readBigInt64LE(c + 48)),
            name: buf.toString('utf16le', c + 66, nameEnd),
            namespace,
          });
        }
      }
    } else if (type === ATTR_DATA && isUnnamed) {
      if (nonResident === 0) {
        const contentSize = buf.readUInt32LE(p + 16);
        if (contentSize >= 0) out.dataSize = contentSize;
      } else {
        const realSize = Number(buf.readBigInt64LE(p + 48));
        if (Number.isFinite(realSize) && realSize >= 0) out.dataSize = realSize;
      }
    }

    p += length;
  }

  if (!out.names.length) return null;
  const best = pickBestName(out.names);
  out.name = best.name;
  out.namespace = best.namespace;
  out.parent = best.parent;
  out.realSize = best.realSize;
  out.fileNameTimes = {
    createdMs: best.createdMs,
    modifiedMs: best.modifiedMs,
    mftChangedMs: best.mftChangedMs,
    accessedMs: best.accessedMs,
  };

  // $STANDARD_INFORMATION times are the ones Explorer shows and the ones that
  // survive a file being copied. Fall back to $FILE_NAME when SI is absent.
  out.createdMs = out.si ? out.si.createdMs : best.createdMs;
  out.modifiedMs = out.si ? out.si.modifiedMs : best.modifiedMs;
  out.accessedMs = out.si ? out.si.accessedMs : best.accessedMs;
  out.attributes = out.si ? out.si.attributes : 0;

  return out;
}

/**
 * Read the $MFT file's own $DATA attribute (record 0) to learn where the MFT lives.
 *
 * The boot sector only supplies the first LCN; a fragmented $MFT describes the
 * rest of itself in this run list, so this must be decoded rather than assumed.
 *
 * @param {number} fd Open raw volume descriptor.
 * @param {object} boot Parsed boot sector.
 * @returns {{extents:Array, allocatedSize:number, realSize:number, initializedSize:number}}
 */
export function readMftExtents(fd, boot) {
  const record0Offset = boot.mftCluster * boot.clusterSize;
  const rec = Buffer.alloc(boot.recordSize);
  readExact(fd, rec, record0Offset, boot.recordSize);
  if (!applyFixup(rec, 0, boot.recordSize)) {
    throw new Error('$MFT record 0 failed its update sequence check');
  }
  if (rec.readUInt32LE(0) !== FILE_SIGNATURE) throw new Error('$MFT record 0 has no FILE signature');

  const usedSize = rec.readUInt32LE(24);
  const headerSize = rec.readUInt16LE(20);
  let p = headerSize;
  const end = Math.min(usedSize, boot.recordSize);
  while (p + 8 <= end) {
    const type = rec.readUInt32LE(p);
    if (type === ATTR_END) break;
    const length = rec.readUInt32LE(p + 4);
    if (length < 16 || p + length > end) break;
    const nonResident = rec[p + 8];
    const nameLength = rec[p + 9];
    if (type === ATTR_DATA && nonResident === 1 && nameLength === 0) {
      const runOffset = rec.readUInt16LE(p + 32);
      const allocatedSize = Number(rec.readBigInt64LE(p + 40));
      const realSize = Number(rec.readBigInt64LE(p + 48));
      // initialised size: how far the MFT has actually been written. NTFS refuses
      // reads past it, so it bounds the scan better than the allocated size.
      const initializedSize = length >= 56 ? Number(rec.readBigInt64LE(p + 56)) : realSize;
      const runBytes = rec.subarray(p + runOffset, p + length);
      return { extents: decodeDataRuns(runBytes), allocatedSize, realSize, initializedSize };
    }
    p += length;
  }
  throw new Error('could not locate a non-resident $DATA attribute on $MFT record 0');
}

/**
 * Assign absolute MFT record indices to a $MFT data run list.
 *
 * The index of a record is its position within the $MFT DATA STREAM, which is
 * simply the running total of records in the preceding extents. It is emphatically
 * NOT derived from an extent's LCN: the LCN is where the extent sits on the
 * volume, and on a typical system the $MFT begins hundreds of megabytes into the
 * disk, so `lcn * clusterSize / recordSize` produces an index in the millions for
 * what is actually record 0.
 *
 * Getting this wrong is silent: every record then fails the bounds check against
 * the $MFT's initialised size and the index comes back empty, so "no backups were
 * found" for every file.
 *
 * @param {Array<{lcn:number, clusters:number, sparse:boolean}>} extents
 * @param {number} clusterSize Bytes per cluster.
 * @param {number} recordSize Bytes per MFT record.
 * @returns {Array<{lcn:number, clusters:number, sparse:boolean, startRecord:number, recordCount:number}>}
 */
export function assignRecordIndices(extents, clusterSize, recordSize) {
  const out = [];
  let nextRecord = 0;
  for (const extent of extents) {
    const recordCount = extent.sparse || extent.clusters <= 0
      ? 0
      : Math.floor((extent.clusters * clusterSize) / recordSize);
    out.push({ ...extent, startRecord: nextRecord, recordCount });
    nextRecord += recordCount;
  }
  return out;
}

/**
 * Enumerate every in-use file record on a volume, invoking `onBatch` per chunk.
 *
 * Records are streamed in sequential chunks across the $MFT extents so peak
 * memory stays bounded regardless of how many files the volume holds.
 *
 * The scan is bounded by the $MFT's initialised size: NTFS refuses reads past it,
 * and the tail of an allocated but unwritten MFT holds no live records.
 *
 * @param {string} driveLetter
 * @param {(records: object[], progress: {recordsRead:number, totalRecords:number}) => void} onBatch
 * @param {{chunkRecords?: number, shouldStop?: () => boolean}} [options]
 * @returns {{boot:object, recordsEmitted:number, elapsedMs:number, mftBytes:number}}
 */
export function enumerateMft(driveLetter, onBatch, options = {}) {
  const chunkRecords = options.chunkRecords ?? 8192;
  const started = Date.now();
  const fd = openVolume(driveLetter);
  let recordsEmitted = 0;
  try {
    const bootBuf = Buffer.alloc(512);
    readExact(fd, bootBuf, 0, 512);
    const boot = parseBootSector(bootBuf, driveLetter);

    const mft = readMftExtents(fd, boot);
    const allocatedBytes = mft.extents.reduce((sum, e) => sum + e.clusters * boot.clusterSize, 0);
    const mftBytes = allocatedBytes;
    // Prefer the initialised size when it is sane; fall back to the allocation.
    const scanBytes = Number.isFinite(mft.initializedSize) && mft.initializedSize > 0
      ? Math.min(mft.initializedSize, allocatedBytes)
      : allocatedBytes;
    const totalRecords = Math.floor(allocatedBytes / boot.recordSize);

    const positioned = assignRecordIndices(mft.extents, boot.clusterSize, boot.recordSize);
    const recordsPerChunk = Math.max(1, Math.floor(chunkRecords / boot.recordSize)) * boot.recordSize;
    const buf = Buffer.alloc(Math.max(recordsPerChunk, boot.recordSize));
    let recordsRead = 0;

    for (const extent of positioned) {
      if (extent.sparse || extent.clusters <= 0) continue;
      const extentBytes = extent.clusters * boot.clusterSize;
      let recordIndex = extent.startRecord;
      let consumed = 0;
      while (consumed < extentBytes) {
        if (options.shouldStop?.()) {
          return { boot, recordsEmitted, elapsedMs: Date.now() - started, mftBytes, stopped: true };
        }
        const want = Math.min(buf.length, extentBytes - consumed);
        readExact(fd, buf, extent.lcn * boot.clusterSize + consumed, want);
        const wholeRecords = Math.floor(want / boot.recordSize);

        const batch = [];
        for (let r = 0; r < wholeRecords; r++) {
          const base = r * boot.recordSize;
          const index = recordIndex + r;
          recordsRead++;
          // Skip free records and anything past the initialised region of $MFT.
          if (buf.readUInt32LE(base) !== FILE_SIGNATURE) continue;
          if (index * boot.recordSize >= scanBytes) continue;
          const rec = parseRecord(buf, base, boot.recordSize, index);
          if (rec) batch.push(rec);
        }
        if (batch.length) {
          recordsEmitted += batch.length;
          onBatch(batch, { recordsRead, totalRecords });
        }
        consumed += wholeRecords * boot.recordSize;
        recordIndex += wholeRecords;
        if (wholeRecords === 0) break; // defensive: avoid an infinite loop on odd sizes
      }
    }
    return { boot, recordsEmitted, elapsedMs: Date.now() - started, mftBytes };
  } finally {
    closeSync(fd);
  }
}

/** Expose constants for tests and callers. */
export const NTFS = {
  ATTR_STANDARD_INFORMATION,
  ATTR_ATTRIBUTE_LIST,
  ATTR_FILE_NAME,
  ATTR_DATA,
  NS_POSIX,
  NS_WIN32,
  NS_DOS,
  NS_WIN32_AND_DOS,
  RECORD_IN_USE,
  RECORD_IS_DIRECTORY,
};

/**
 * Can this process read the raw volume?
 *
 * Opening the device and reading the boot sector is the cheapest operation that
 * fails with ERROR_ACCESS_DENIED when unelevated, so it is the right gate for
 * "should this app offer MFT indexing". The result is cached per drive because
 * elevation cannot change within a process lifetime.
 *
 * @param {string} driveLetter
 * @returns {{ok:boolean, error?:string, boot?:object}}
 */
const elevationProbeCache = new Map();
export function probeVolumeAccess(driveLetter) {
  const key = String(driveLetter).slice(0, 1).toUpperCase();
  if (elevationProbeCache.has(key)) return elevationProbeCache.get(key);
  let fd;
  let result;
  try {
    fd = openVolume(key);
    const boot = Buffer.alloc(512);
    readExact(fd, boot, 0, 512);
    result = { ok: true, boot: parseBootSector(boot, key) };
  } catch (err) {
    result = { ok: false, error: err.message, code: err.code };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
  elevationProbeCache.set(key, result);
  return result;
}
