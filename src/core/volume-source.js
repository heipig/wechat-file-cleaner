/**
 * Raw NTFS volume access with an automatic child-process fallback.
 *
 * Background
 * ----------
 * Reading the NTFS master file table means opening `\\.\D:` and reading raw
 * bytes. That works in Node 22+ but NOT in the Node 20 that Electron 33 embeds,
 * where the device path is opened as a directory and every read fails with
 * EISDIR. (Verified on this machine: node.exe 24.19.0 reads the boot sector and
 * the whole 232 MB MFT; electron.exe 33.4.11 reports the handle as a directory.)
 *
 * So this module tries the in-process path first — which costs nothing and keeps
 * working on newer Electron versions — and falls back to running the same
 * enumeration inside a real `node.exe` child process when the in-process read
 * cannot work. The caller gets an identical interface either way.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeVolumeAccess, enumerateMft } from '../mft/ntfs.js';
import { log, logError } from './logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');

/** Where the helper script lives, in dev and inside the packaged app. */
export function helperScriptPath(isPackaged, resourcesPath) {
  // Packaged: the helper and the modules it imports are shipped OUTSIDE the asar,
  // because the helper runs in a real `node.exe` child process and Node cannot
  // read into an asar archive. Electron only teaches its own fs layer about asar;
  // a spawned interpreter sees a normal filesystem and fails with "cannot find
  // module" if handed an app.asar path. The repo layout is mirrored under
  // resources/helper/ so the helper's relative imports resolve unchanged.
  if (isPackaged) return join(resourcesPath, 'helper', 'tools', 'mft-helper.mjs');
  return join(projectRoot, 'tools', 'mft-helper.mjs');
}

/**
 * Locate the PowerShell helper that performs deletions.
 *
 * Same asar rule as the MFT helper: `powershell.exe` is a separate process and
 * cannot open a path inside app.asar. Handing it an asar path makes it exit with
 * "the argument to the -File parameter does not exist" and nothing is deleted —
 * observed in the field as "delete does nothing / the app falls over".
 *
 * @param {boolean} isPackaged
 * @param {string} resourcesPath
 * @returns {string}
 */
export function deleteScriptPath(isPackaged, resourcesPath) {
  if (isPackaged) return join(resourcesPath, 'helper', 'resources', 'delete-files.ps1');
  return join(projectRoot, 'resources', 'delete-files.ps1');
}

/**
 * Locate a Node.js executable capable of raw volume reads.
 *
 * `process.execPath` is Electron, which cannot do the job, so it is deliberately
 * never used. Candidates are tried in order of trustworthiness.
 *
 * @param {{isPackaged?:boolean, resourcesPath?:string, explicit?:string}} [options]
 * @returns {string|null}
 */
export function findNodeExecutable(options = {}) {
  const candidates = [];
  if (options.explicit) candidates.push(options.explicit);
  if (process.env.WECHAT_CLEANER_NODE) candidates.push(process.env.WECHAT_CLEANER_NODE);

  // A Node runtime shipped alongside the app takes priority: it guarantees a
  // working version even on a machine with no Node installed.
  const roots = [];
  if (options.resourcesPath) roots.push(options.resourcesPath);
  roots.push(projectRoot);
  for (const root of roots) {
    candidates.push(join(root, 'runtime', 'node.exe'));
    candidates.push(join(root, 'node.exe'));
    candidates.push(join(root, '..', 'runtime', 'node.exe'));
  }

  // Then anything on PATH.
  const pathExts = (process.env.PATHEXT ?? '.EXE').split(';').filter(Boolean);
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of pathExts) candidates.push(join(dir, `node${ext.toLowerCase()}`));
    candidates.push(join(dir, 'node.exe'));
  }
  // Finally the usual install locations, in case PATH is odd when elevated.
  candidates.push('C:\\Program Files\\nodejs\\node.exe');
  candidates.push('C:\\Program Files (x86)\\nodejs\\node.exe');

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* unreadable candidate */ }
  }
  return null;
}

/**
 * Whether this process can actually read raw volume bytes.
 *
 * A successful `openSync` is not enough: Electron 33's runtime opens the device
 * and then fails every read with EISDIR, so the probe must read a byte.
 *
 * @param {string} letter
 * @returns {{ok:boolean, error?:string, code?:string}}
 */
export function canReadRawVolume(letter) {
  const probe = probeVolumeAccess(letter);
  if (!probe.ok) return { ok: false, error: probe.error, code: probe.code };
  return { ok: true };
}

/**
 * Run the MFT helper as a child process and stream its records.
 *
 * @param {object} options
 * @param {string[]} options.volumes
 * @param {string} options.nodePath
 * @param {string} options.scriptPath
 * @param {(batch:object[], progress:object)=>void} [options.onBatch] Called per volume batch.
 * @param {(info:object)=>void} [options.onProgress] Called as the helper reports progress.
 * @param {()=>boolean} [options.shouldStop]
 * @returns {Promise<{volumes:Array<object>, recordsEmitted:number, elapsedMs:number, stderr:string}>}
 */
export function enumerateViaHelper(options) {
  const { volumes, nodePath, scriptPath, onBatch, onProgress, shouldStop } = options;

  return new Promise((resolve, reject) => {
    if (!existsSync(scriptPath)) {
      reject(new Error(`MFT 助手脚本缺失：${scriptPath}`));
      return;
    }

    log.info('mft-helper', `spawning ${nodePath} ${scriptPath} ${volumes.join(' ')}`);
    const child = spawn(nodePath, [scriptPath, ...volumes], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // One volume's records are gathered before path resolution, matching the
    // in-process implementation's behaviour (paths need every parent present).
    const byVolume = new Map();
    let currentVolume = volumes[0];
    let recordsEmitted = 0;
    let stderr = '';
    let finished = false;
    const volumeStats = [];

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // ignore a torn line rather than failing the whole scan
      }

      switch (msg.t) {
        case 'rec': {
          let bucket = byVolume.get(currentVolume);
          if (!bucket) { bucket = new Map(); byVolume.set(currentVolume, bucket); }
          bucket.set(msg.r, {
            name: msg.n,
            parent: msg.p,
            size: msg.z,
            modifiedMs: msg.m,
            isDirectory: msg.d === 1,
          });
          recordsEmitted++;
          break;
        }
        case 'progress':
          onProgress?.({ phase: 'enumerate', volume: msg.volume, recordsRead: msg.recordsRead, totalRecords: msg.totalRecords, kept: recordsEmitted });
          break;
        case 'volume': {
          const bucket = byVolume.get(msg.volume) ?? new Map();
          byVolume.delete(msg.volume);
          onBatch?.(bucket, msg);
          volumeStats.push({
            volume: msg.volume,
            records: msg.records,
            files: 0,           // filled by the caller after path resolution
            mftBytes: msg.mftBytes,
            elapsedMs: msg.elapsedMs,
            boot: msg.boot,
          });
          currentVolume = volumes[volumes.indexOf(msg.volume) + 1] ?? currentVolume;
          break;
        }
        case 'error':
          volumeStats.push({ volume: msg.volume, records: 0, files: 0, mftBytes: 0, elapsedMs: 0, error: msg.message });
          logError('mft-helper', `volume ${msg.volume} failed in helper`, { message: msg.message, code: msg.code, name: msg.name });
          break;
        case 'done':
          finished = true;
          resolve({ volumes: volumeStats, recordsEmitted: msg.recordsEmitted, elapsedMs: msg.elapsedMs, stderr });
          break;
        default:
          break;
      }

      if (shouldStop?.()) {
        try { child.kill(); } catch { /* already gone */ }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      logError('mft-helper', 'failed to start the helper', err);
      reject(err);
    });
    child.on('close', (code) => {
      if (finished) return;
      // The helper died before reporting: surface why.
      const detail = stderr.trim().slice(0, 500);
      reject(new Error(`MFT 助手异常退出（退出码 ${code}）${detail ? `：${detail}` : ''}`));
    });
  });
}

/**
 * Classify a volume-level failure so the UI can distinguish a real fault from a
 * drive that simply cannot be indexed.
 *
 * A non-NTFS drive (a FAT32 or exFAT USB stick, an optical disc, a phone in MTP
 * mode) is not a failure of the app — it has no master file table to read. Reporting
 * it as an error made a perfectly healthy run look broken, and a removable drive is
 * often present on a machine the bundle is copied to.
 *
 * @param {string|undefined} message
 * @returns {'indexed'|'unsupported'|'unreadable'}
 */
export function classifyVolumeOutcome(message) {
  if (!message) return 'indexed';
  const text = String(message);
  if (/is not NTFS/i.test(text)) return 'unsupported';
  // Opening a device that is not a fixed data volume fails in a few distinct ways
  // depending on the filesystem and how the drive is presented.
  if (/EINVAL|ENOTSUP|EISDIR/i.test(text) && /open|read/i.test(text)) return 'unsupported';
  return 'unreadable';
}

/**
 * Enumerate volumes for indexing, choosing in-process or helper execution.
 *
 * Each volume is handled independently so a partially successful run still
 * produces a usable index, and the caller learns exactly which volume failed.
 *
 * @param {object} options
 * @param {string[]} options.volumes
 * @param {boolean} [options.isPackaged]
 * @param {string} [options.resourcesPath]
 * @param {(volume:string, records:Map<number,object>, meta:object)=>void} options.onVolumeRecords
 * @param {(info:object)=>void} [options.onProgress]
 * @param {()=>boolean} [options.shouldStop]
 * @returns {Promise<{stats:Array<object>, engine:string, nodePath:string|null}>}
 */
export async function enumerateVolumes(options) {
  const { volumes, onVolumeRecords, onProgress, shouldStop } = options;
  const stats = [];

  // Decide per volume whether the in-process reader works.
  const inProcess = [];
  const needsHelper = [];
  for (const volume of volumes) {
    const probe = canReadRawVolume(volume);
    if (probe.ok) {
      inProcess.push(volume);
      log.info('mft', `${volume}: raw volume readable in-process (engine=in-process)`);
    } else {
      needsHelper.push(volume);
      log.warn('mft', `${volume}: in-process raw read unavailable (${probe.code ?? ''} ${probe.error ?? ''}); will use helper`);
    }
  }

  for (const volume of inProcess) {
    try {
      const bucket = new Map();
      const summary = enumerateMft(volume, (batch, progress) => {
        for (const rec of batch) {
          bucket.set(rec.recordNumber, {
            name: rec.name,
            parent: rec.parent,
            size: rec.isDirectory ? 0 : (rec.dataSize >= 0 ? rec.dataSize : rec.realSize),
            modifiedMs: rec.modifiedMs,
            isDirectory: rec.isDirectory,
          });
        }
        onProgress?.({ phase: 'enumerate', volume, recordsRead: progress.recordsRead, totalRecords: progress.totalRecords, kept: bucket.size });
      }, { chunkRecords: 65536, shouldStop });
      onVolumeRecords(volume, bucket, {
        volume,
        records: bucket.size,
        mftBytes: summary.mftBytes,
        elapsedMs: summary.elapsedMs,
        boot: summary.boot,
      });
      stats.push({ volume, records: bucket.size, elapsedMs: summary.elapsedMs, engine: 'in-process' });
    } catch (err) {
      logError('mft', `in-process enumeration of ${volume} failed`, err);
      stats.push({ volume, records: 0, elapsedMs: 0, error: err.message, status: classifyVolumeOutcome(err.message), engine: 'in-process' });
    }
  }

  if (needsHelper.length) {
    const nodePath = findNodeExecutable({ isPackaged: options.isPackaged, resourcesPath: options.resourcesPath });
    const scriptPath = helperScriptPath(Boolean(options.isPackaged), options.resourcesPath ?? projectRoot);
    if (!nodePath) {
      const message = '找不到可用的 Node.js 运行时，无法读取 NTFS 主文件表。'
        + '请安装 Node.js，或改用“只索引指定文件夹”模式。';
      logError('mft', 'no usable Node runtime found for the helper', new Error(message));
      for (const volume of needsHelper) {
        stats.push({ volume, records: 0, elapsedMs: 0, error: message, status: 'unreadable', engine: 'helper' });
      }
      return { stats, engine: 'helper-unavailable', nodePath: null };
    }

    log.info('mft', `helper runtime: ${nodePath}`);
    try {
      const result = await enumerateViaHelper({
        volumes: needsHelper,
        nodePath,
        scriptPath,
        onProgress,
        shouldStop,
        onBatch: (bucket, meta) => {
          onVolumeRecords(meta.volume, bucket, {
            volume: meta.volume,
            records: bucket.size,
            mftBytes: meta.mftBytes,
            elapsedMs: meta.elapsedMs,
            boot: meta.boot,
          });
        },
      });
      for (const v of result.volumes) {
        stats.push({
          volume: v.volume,
          records: v.records,
          elapsedMs: v.elapsedMs,
          error: v.error,
          status: classifyVolumeOutcome(v.error),
          engine: 'helper',
        });
      }
    } catch (err) {
      logError('mft', 'helper enumeration failed', err);
      for (const volume of needsHelper) {
        stats.push({ volume, records: 0, elapsedMs: 0, error: err.message, status: classifyVolumeOutcome(err.message), engine: 'helper' });
      }
    }
    return { stats, engine: 'helper', nodePath };
  }

  return { stats, engine: 'in-process', nodePath: null };
}
