/**
 * Elevated, end-to-end verification harness.
 *
 * Unlike the unit tests, this exercises the real pipeline against the actual
 * disk: it parses the live NTFS MFT of the requested volumes and scans the real
 * WeChat folder, then prints counts, timings, and a sample of inferred sent
 * files so the classification can be eyeballed against reality.
 *
 * Usage (must be run elevated):
 *   node tools/selftest.mjs --volumes D --wechat "D:\xwechat_files\...\msg\file"
 *
 * Writes tools/selftest-report.json so the results can be read back without a
 * console attached.
 */
import { writeFileSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateMft, probeVolumeAccess } from '../src/mft/ntfs.js';
import { scanWeChatFolder, formatSize } from '../src/core/wechat-scan.js';
import { buildVolumeIndex, matchBackups } from '../src/mft/mft-index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal argv parser: --key value, repeated keys collect into arrays. */
function parseArgs(argv) {
  const out = { volumes: [], wechat: [], verify: true, recursive: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1]?.startsWith('--') ? 'true' : argv[++i];
    if (key === 'volumes') out.volumes.push(value);
    else if (key === 'wechat') out.wechat.push(value);
    else if (key === 'no-verify') out.verify = false;
    else if (key === 'no-recursive') out.recursive = false;
  }
  if (!out.volumes.length) out.volumes.push('D');
  return out;
}

/** Cheap gate: can this process open a raw volume at all? */
function checkElevation(driveLetter) {
  const probe = probeVolumeAccess(driveLetter);
  return probe.ok ? true : probe.error;
}

function log(...args) {
  process.stdout.write(`${args.join(' ')}\n`);
}

const args = parseArgs(process.argv.slice(2));
const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  args,
  elevation: null,
  mft: [],
  scan: null,
  match: null,
  samples: [],
  errors: [],
};

log('=== WeChat cleaner: end-to-end self test ===');
log('node', process.version);
log('volumes:', args.volumes.join(', '));
log('wechat :', args.wechat.join(', ') || '(none)');

  report.elevation = checkElevation(args.volumes[0]);
  log('elevated:', report.elevation === true ? 'yes' : `NO -> ${report.elevation}`);
  if (report.elevation !== true) {
    log('!! Not elevated: MFT indexing cannot work. Re-run from an Administrator terminal.');
  }

  // --- 1. RAW MFT ENUMERATION -------------------------------------------------
  for (const volume of args.volumes) {
    log(`\n--- MFT enumeration on ${volume}: ---`);
    const started = Date.now();
    let records = 0;
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    const extensionCounts = new Map();
    let boot = null;
    let mftBytes = 0;
    let lastLog = 0;

    try {
      const summary = enumerateMft(volume, (batch, progress) => {
        for (const rec of batch) {
          records++;
          if (rec.isDirectory) { dirs++; continue; }
          files++;
          bytes += rec.dataSize >= 0 ? rec.dataSize : rec.realSize;
          const dot = rec.name.lastIndexOf('.');
          const ext = dot > 0 ? rec.name.slice(dot).toLowerCase() : '(none)';
          extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
        }
        if (Date.now() - lastLog > 4000) {
          lastLog = Date.now();
          log(`  ... ${progress.recordsRead} / ${progress.totalRecords} records, ${files} files, ${((Date.now() - started) / 1000).toFixed(1)}s`);
        }
      }, { chunkRecords: 65536 });
      boot = summary.boot;
      mftBytes = summary.mftBytes;

      const elapsedMs = Date.now() - started;
      log(`  records parsed : ${records}`);
      log(`  files          : ${files}  (${formatSize(bytes)})`);
      log(`  directories    : ${dirs}`);
      log(`  MFT size       : ${formatSize(mftBytes)}`);
      log(`  elapsed        : ${(elapsedMs / 1000).toFixed(2)}s  (${Math.round(files / (elapsedMs / 1000))} files/s)`);
      log(`  geometry       : sector=${boot.bytesPerSector} cluster=${boot.clusterSize} record=${boot.recordSize}`);

      const top = [...extensionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      log(`  top extensions : ${top.map(([e, c]) => `${e}:${c}`).join('  ')}`);

      report.mft.push({
        volume,
        records,
        files,
        dirs,
        bytes,
        mftBytes,
        elapsedMs,
        geometry: {
          // volumeSerial is a BigInt, which JSON.stringify refuses to serialise.
          ...boot,
          volumeSerial: boot.volumeSerial?.toString?.() ?? String(boot.volumeSerial),
        },
        topExtensions: top,
      });
    } catch (err) {
      log(`  FAILED: ${err.message}`);
      report.mft.push({ volume, error: err.message });
    }
  }

  // --- 2. WECHAT FOLDER SCAN --------------------------------------------------
  for (const folder of args.wechat) {
    log(`\n--- WeChat scan: ${folder} ---`);
    let scan;
    try {
      scan = await scanWeChatFolder(folder, {
        recursive: args.recursive,
        onProgress: (p) => {
          if (p.dirsSeen % 200 === 0) log(`  ... ${p.dirsSeen} dirs, ${p.files} files`);
        },
      });
    } catch (err) {
      log(`  FAILED: ${err.message}`);
      report.errors.push({ stage: 'scan', folder, error: err.message });
      continue;
    }
    const sent = scan.files.filter((f) => f.classification === 'sent');
    const received = scan.files.filter((f) => f.classification === 'received');
    const unknown = scan.files.filter((f) => f.classification === 'unknown');
    const totalBytes = scan.files.reduce((sum, f) => sum + f.size, 0);

    log(`  files      : ${scan.files.length}  (${formatSize(totalBytes)})`);
    log(`  months     : ${scan.months.join(', ') || '(none matched)'}`);
    log(`  sent       : ${sent.length}  (${formatSize(sent.reduce((s, f) => s + f.size, 0))})`);
    log(`  received   : ${received.length}`);
    log(`  unknown    : ${unknown.length}`);

    const byMonth = new Map();
    for (const f of scan.files) {
      const key = f.month ?? '(none)';
      const bucket = byMonth.get(key) ?? { total: 0, sent: 0, bytes: 0, sentBytes: 0 };
      bucket.total++;
      bucket.bytes += f.size;
      if (f.classification === 'sent') { bucket.sent++; bucket.sentBytes += f.size; }
      byMonth.set(key, bucket);
    }
    for (const [month, b] of [...byMonth.entries()].sort()) {
      log(`    ${month}: ${b.total} files, ${b.sent} sent (${formatSize(b.sentBytes)} of ${formatSize(b.bytes)})`);
    }

    report.scan = {
      folder,
      files: scan.files.length,
      bytes: totalBytes,
      months: scan.months,
      sent: sent.length,
      received: received.length,
      unknown: unknown.length,
      byMonth: [...byMonth.entries()].map(([month, b]) => ({ month, ...b })),
    };

    // --- 3. BACKUP MATCHING ---------------------------------------------------
    if (args.volumes.length && report.mft.some((m) => !m.error)) {
      log('\n--- Building volume index ---');
      const index = await buildVolumeIndex(args.volumes, {
        onProgress: (p) => {
          if (p.phase === 'enumerate' && p.recordsRead % 500000 < 65536) {
            log(`  ... ${p.volume}: ${p.recordsRead} / ${p.totalRecords} records, index ${p.kept} files`);
          }
        },
      });
      const stats = index.stats();
      log(`  indexed files : ${stats.files}`);
      log(`  buckets       : ${stats.buckets}`);
      for (const v of stats.volumes) {
        log(`  ${v.volume}: ${v.files} files in ${(v.elapsedMs / 1000).toFixed(2)}s${v.error ? ` ERROR ${v.error}` : ''}`);
      }

      log('\n--- index sanity check (MFT index vs the files just scanned) ---');
      let indexHits = 0;
      let indexMisses = 0;
      const missSamples = [];
      for (const file of scan.files) {
        const hits = index.lookup(file.name, file.size);
        if (hits && hits.length) {
          indexHits++;
        } else {
          indexMisses++;
          if (missSamples.length < 10) missSamples.push({ name: file.name, size: file.size });
        }
      }
      log(`  looked up ${scan.files.length} scanned files inside the MFT index:`);
      log(`    found   : ${indexHits}   (expected: all of them — the source itself is on the volume)`);
      log(`    missing : ${indexMisses}`);
      for (const m of missSamples) log(`      MISSING ${formatSize(m.size).padStart(9)}  ${m.name}`);
      if (indexMisses) {
        log('  !! A MISS here means the index stores a different name or size than the filesystem.');
      }
      report.indexSanity = { looked: scan.files.length, hits: indexHits, misses: indexMisses, missSamples };

      log('\n--- Matching backups ---');
      const matchStarted = Date.now();
      const matchResult = await matchBackups(scan.files, index, {
        verify: args.verify,
        scanRoot: folder,
        onProgress: (p) => {
          if (p.done % 500 === 0) log(`  ... ${p.done} / ${p.total} checked, ${p.verified} hashed`);
        },
      });
      const withBackup = scan.files.filter((f) => (f.backupCount ?? 0) > 0);
      const backedBytes = withBackup.reduce((s, f) => s + f.size, 0);
      log(`  matched files : ${withBackup.length} / ${scan.files.length}  (${formatSize(backedBytes)})`);
      log(`  hashes taken  : ${matchResult.verified}, rejected on content: ${matchResult.cleared}`);
      log(`  elapsed       : ${((Date.now() - matchStarted) / 1000).toFixed(2)}s`);

      // Cross-tab: does "looks sent" agree with "has a backup"?
      const cross = { sentBacked: 0, sentNoBackup: 0, receivedBacked: 0, receivedNoBackup: 0 };
      for (const f of scan.files) {
        const backed = (f.backupCount ?? 0) > 0;
        if (f.classification === 'sent') cross[backed ? 'sentBacked' : 'sentNoBackup']++;
        else if (f.classification === 'received') cross[backed ? 'receivedBacked' : 'receivedNoBackup']++;
      }
      log('\n  agreement between the two signals:');
      log(`    判为发送件 且 找到备份 : ${cross.sentBacked}`);
      log(`    判为发送件 但 没找到备份: ${cross.sentNoBackup}   <- 值得人工看一眼`);
      log(`    判为接收件 但 找到备份 : ${cross.receivedBacked}   <- 忘了存哪的，工具的价值点`);
      log(`    判为接收件 且 无备份   : ${cross.receivedNoBackup}`);

      report.match = {
        indexedFiles: stats.files,
        withBackup: withBackup.length,
        backedBytes,
        ...matchResult,
        cross,
      };

      report.samples = scan.files.slice(0, 200).map((f) => ({
        name: f.name,
        size: f.size,
        month: f.month,
        modified: new Date(f.modifiedMs).toISOString(),
        classification: f.classification,
        deltaDays: f.deltaDays,
        backupCount: f.backupCount ?? 0,
        backups: (f.backups ?? []).map((b) => b.path),
      }));
    }
  }

report.finishedAt = new Date().toISOString();
writeFileSync(join(here, 'selftest-report.json'), JSON.stringify(report, null, 2), 'utf8');
log('\nreport written to tools/selftest-report.json');
