/**
 * Full-volume file index built from the NTFS MFT.
 *
 * The index answers one question fast: "which other files on this machine have
 * this name and this size?". That is the prefilter for backup detection. Because
 * the MFT gives name + size + mtime for every file without touching directories,
 * building it takes seconds even on volumes with millions of files.
 *
 * Matching itself happens in two stages:
 *   1. exact (lowercased name, size) bucket lookup — pure in-memory, O(1);
 *   2. content hash comparison over that small candidate set, so a same-name
 *      same-size different-content pair is never reported as a backup.
 */
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { enumerateVolumes } from '../core/volume-source.js';

/** Files larger than this get a sampled hash instead of a full-content hash. */
export const FULL_HASH_LIMIT = 64 * 1024 * 1024;
const SAMPLE_CHUNK = 4 * 1024 * 1024;
const SAMPLE_COUNT = 4;

/**
 * Candidate hash algorithms, best first.
 *
 * The digest is probed at runtime rather than hardcoded: Electron's bundled Node
 * does NOT support blake2b512 (`createHash` throws "Digest method not
 * supported"), while a standalone Node 24 does. Hardcoding blake2b512 made every
 * "查备份" fail in the packaged app even though it worked in development, so the
 * algorithm is now discovered from what the running process actually offers.
 */
const HASH_CANDIDATES = ['blake2b512', 'sha512', 'sha256'];

let resolvedDigest = null;

/**
 * The strongest digest this process supports.
 *
 * The chosen name is prefixed onto every hash string, so two hashes are only
 * ever compared when they came from the same algorithm.
 *
 * @returns {string}
 */
export function pickDigest() {
  if (resolvedDigest) return resolvedDigest;
  for (const candidate of HASH_CANDIDATES) {
    try {
      createHash(candidate).update('probe').digest();
      resolvedDigest = candidate;
      return candidate;
    } catch {
      // Not available in this runtime; try the next.
    }
  }
  // sha256 is guaranteed by Node, so this is unreachable in practice; failing
  // loudly beats silently hashing with something unexpected.
  throw new Error(`此运行时不支持任何可用的哈希算法（已尝试 ${HASH_CANDIDATES.join(', ')}）`);
}

/** Directories whose contents are never plausible "user backups". */
const EXCLUDED_PATH_PARTS = [
  '\\$recycle.bin\\',
  '\\system volume information\\',
  '\\windows\\winsxs\\',
  '\\windows\\servicing\\',
  '\\node_modules\\',
  '\\$extend\\',
  '\\appdata\\local\\temp\\',
];

/** True when a path should be ignored as a backup candidate. */
export function isExcludedPath(lowerPath) {
  for (const part of EXCLUDED_PATH_PARTS) if (lowerPath.includes(part)) return true;
  return false;
}

/**
 * In-memory index of every file on one or more NTFS volumes.
 *
 * Internally a Map keyed by `name\u0000size` whose values are arrays of records.
 * Records are plain objects; at roughly 150 bytes each, a 2-million-file volume
 * costs a few hundred MB, which is acceptable for a desktop tool that must
 * answer queries instantly.
 */
export class VolumeIndex {
  constructor() {
    /** @type {Map<string, Array<{path:string, dir:string, name:string, size:number, modifiedMs:number, volume:string, fromMft:boolean}>>} */
    this.buckets = new Map();
    /** @type {Map<string, {elapsedMs:number, records:number, files:number, mftBytes:number, error?:string}>} */
    this.volumeStats = new Map();
    this.fileCount = 0;
    this.directoryCount = 0;
    this.builtAt = 0;
  }

  /** Bucket key for a (name, size) pair. */
  static key(name, size) {
    return `${name.toLowerCase()}\u0000${size}`;
  }

  /**
   * Add one file record.
   * @param {{name:string, size:number, path:string, modifiedMs:number, volume:string, fromMft:boolean}} rec
   */
  add(rec) {
    const key = VolumeIndex.key(rec.name, rec.size);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(rec);
    this.fileCount++;
  }

  /** Exact (name, size) candidates for a file. */
  lookup(name, size) {
    return this.buckets.get(VolumeIndex.key(name, size)) ?? null;
  }

  /** Serialisable summary for the UI. */
  stats() {
    return {
      files: this.fileCount,
      directories: this.directoryCount,
      buckets: this.buckets.size,
      builtAt: this.builtAt,
      volumes: [...this.volumeStats.entries()].map(([volume, s]) => ({ volume, ...s })),
    };
  }
}

/**
 * Build an index by streaming the MFT of each requested volume.
 *
 * Raw volume reads go through the volume-source layer, which uses this process
 * when its runtime can read `\\.\X:` and falls back to a Node child process when
 * it cannot (Electron 33 bundles Node 20, whose fs layer opens the device as a
 * directory and fails every read with EISDIR).
 *
 * @param {string[]} volumes Drive letters such as ["C","D"].
 * @param {{onProgress?:Function, shouldStop?:Function, nameFilter?:RegExp,
 *   isPackaged?:boolean, resourcesPath?:string}} [options]
 * @returns {Promise<VolumeIndex>}
 */
export async function buildVolumeIndex(volumes, options = {}) {
  const { onProgress, shouldStop, nameFilter } = options;
  const index = new VolumeIndex();
  const started = Date.now();

  /** Directory counts per volume, accumulated as each volume is resolved. */
  const dirCounts = new Map();

  /**
   * Resolve a volume's records into index entries.
   * Paths need every parent present, so this runs once a whole volume is in.
   */
  const incorporate = (volume, records, meta) => {
    const volumeStarted = Date.now();
    // Resolve full paths by walking parent links, memoising directories.
    const pathCache = new Map();
    const resolvePath = (recordNumber, depth = 0) => {
      if (depth > 64) return null; // corrupt or cyclic parent chain
      if (pathCache.has(recordNumber)) return pathCache.get(recordNumber);
      const rec = records.get(recordNumber);
      if (!rec) return null;
      let result;
      if (rec.parent === recordNumber || recordNumber === 5) {
        // Record 5 is the volume root "."; it is its own parent.
        result = `${volume}:\\`;
      } else {
        const parentPath = resolvePath(rec.parent, depth + 1);
        result = parentPath == null
          ? null
          : parentPath.endsWith('\\') ? parentPath + rec.name : `${parentPath}\\${rec.name}`;
      }
      pathCache.set(recordNumber, result);
      return result;
    };

    let added = 0;
    let dirs = 0;
    for (const [recordNumber, rec] of records) {
      if (rec.isDirectory) { dirs++; continue; }
      if (nameFilter && !nameFilter.test(rec.name)) continue;
      const path = resolvePath(recordNumber);
      if (!path) continue;
      if (isExcludedPath(path.toLowerCase())) continue;
      index.add({
        path,
        dir: path.slice(0, path.lastIndexOf('\\')),
        name: rec.name,
        size: rec.size,
        modifiedMs: rec.modifiedMs,
        volume,
        fromMft: true,
      });
      added++;
    }

    dirCounts.set(volume, dirs);
    index.volumeStats.set(volume, {
      elapsedMs: meta?.elapsedMs ?? (Date.now() - volumeStarted),
      records: records.size,
      files: added,
      mftBytes: meta?.mftBytes ?? 0,
      engine: meta?.engine,
      boot: meta?.boot,
    });
    onProgress?.({ phase: 'volume-done', volume, files: added, elapsedMs: meta?.elapsedMs ?? (Date.now() - volumeStarted) });
  };

  const { stats, engine, nodePath } = await enumerateVolumes({
    volumes,
    isPackaged: options.isPackaged,
    resourcesPath: options.resourcesPath,
    shouldStop,
    onProgress,
    onVolumeRecords: incorporate,
  });

  index.directoryCount = [...dirCounts.values()].reduce((a, b) => a + b, 0);
  index.engine = engine;
  index.helperNode = nodePath;
  for (const s of stats) {
    if (s.error) {
      index.volumeStats.set(s.volume, {
        elapsedMs: s.elapsedMs ?? 0,
        records: 0,
        files: 0,
        mftBytes: 0,
        engine: s.engine,
        error: s.error,
        status: s.status ?? (s.error ? 'unreadable' : 'indexed'),
      });
    } else if (!index.volumeStats.has(s.volume)) {
      // Enumerated but contributed nothing (e.g. all paths filtered out).
      index.volumeStats.set(s.volume, {
        elapsedMs: s.elapsedMs ?? 0,
        records: s.records ?? 0,
        files: 0,
        mftBytes: 0,
        engine: s.engine,
      });
    }
  }

  index.builtAt = Date.now();
  onProgress?.({ phase: 'done', elapsedMs: Date.now() - started, engine });
  return index;
}

/**
 * Validate an index before it is used for matching.
 *
 * A failed index build yields an EMPTY index object, not null — so a naive
 * `if (!index)` guard passes and every file is then reported as "no backup
 * found" with no error anywhere. That silent no-result is exactly what makes a
 * backup tool look broken, so emptiness is treated as a hard error here.
 *
 * @param {VolumeIndex|null|undefined} index
 * @returns {string|null} A user-facing problem description, or null when usable.
 */
export function describeIndexProblem(index) {
  if (!index) return '尚未建立备份索引，请先点“建立全盘索引”。';
  const files = index.fileCount ?? 0;
  if (files > 0) return null;
  const volumes = index.stats?.().volumes ?? [];
  // Only genuine read failures are problems. A drive without an NTFS master file
  // table (a FAT32/exFAT stick, a phone, an optical disc) cannot be indexed by
  // design, and treating that as a failure made healthy runs look broken.
  const failures = volumes.filter((v) => v.error && v.status !== 'unsupported');
  if (failures.length) {
    return `索引为空：${failures.map((v) => `${v.volume}: 盘读取失败（${v.error}）`).join('；')}`;
  }
  const unsupported = volumes.filter((v) => v.status === 'unsupported');
  if (unsupported.length === volumes.length && volumes.length > 0) {
    return `所选盘符都不是 NTFS 格式（${unsupported.map((v) => v.volume).join('、')}），无法读取主文件表。`
      + '请改选 NTFS 磁盘，或切换到“只索引指定文件夹”模式。';
  }
  return '索引里没有任何文件，请重新建立索引（未以管理员身份运行时读不到 NTFS 主文件表）。';
}

/**
 * Decide how to obtain a usable index.
 *
 * Kept as a pure function so every branch is testable without Electron or a real
 * volume. The rules encode what the UI has to explain to the user:
 *
 *   - an existing non-empty index is reused;
 *   - folder mode always works and needs no elevation;
 *   - MFT mode requires elevation, and silently produces an EMPTY index when it
 *     lacks it, so elevation is a hard precondition rather than a runtime hope;
 *   - when MFT is impossible but folders are configured, fall back to folders
 *     instead of failing, and say so.
 *
 * @param {object} input
 * @param {number} [input.indexFiles] File count of the existing index (0 = none).
 * @param {'mft'|'folders'} [input.scope] Configured index source.
 * @param {string[]} [input.folders] Configured backup-search folders.
 * @param {string[]} [input.volumes] Selected drive letters.
 * @param {boolean} [input.elevated] Whether the process can read raw volumes.
 * @param {boolean} [input.preferFolders] Force the folder source (no admin path).
 * @returns {{action:'reuse'|'build-folders'|'build-mft'|'switch-to-folders'|'impossible',
 *   reason:string, note?:string}}
 */
export function planIndexSource(input = {}) {
  const {
    indexFiles = 0,
    scope = 'mft',
    folders = [],
    volumes = [],
    elevated = false,
    preferFolders = false,
  } = input;
  const usableFolders = (folders ?? []).filter(Boolean);
  const usableVolumes = (volumes ?? []).filter(Boolean);
  const wanted = preferFolders ? 'folders' : scope;

  if (wanted !== 'folders' && indexFiles > 0) {
    return { action: 'reuse', reason: `已有 ${indexFiles} 个文件的索引` };
  }

  if (wanted === 'folders') {
    if (!usableFolders.length) {
      return {
        action: 'impossible',
        reason: '文件夹索引模式下还没有选择任何文件夹',
      };
    }
    return { action: 'build-folders', reason: `遍历 ${usableFolders.length} 个文件夹` };
  }

  // MFT requested.
  if (!elevated) {
    if (usableFolders.length) {
      return {
        action: 'switch-to-folders',
        reason: '未以管理员身份运行，无法读取 NTFS 主文件表',
        note: '读不到 NTFS 主文件表，已改用文件夹索引。',
      };
    }
    return {
      action: 'impossible',
      reason: '未以管理员身份运行，无法读取 NTFS 主文件表；也没有配置可用的备份文件夹',
    };
  }

  if (!usableVolumes.length) {
    return { action: 'impossible', reason: '没有选择任何要索引的盘符' };
  }
  return { action: 'build-mft', reason: `读取 ${usableVolumes.join('、')}: 的 NTFS 主文件表` };
}

/**
 * Content hash of a file.
 *
 * Files at or below FULL_HASH_LIMIT are hashed end to end. Larger files are
 * hashed from four spread-out 4MB samples plus the exact size, which is
 * dramatically cheaper and still catches essentially every real duplicate —
 * but the result is tagged `sampled` so callers can be honest about it.
 *
 * @param {string} filePath
 * @param {number} size
 * @returns {Promise<{hash:string, sampled:boolean, error?:string}>}
 */
export async function hashFile(filePath, size) {
  // Discovered per process: Electron's Node lacks blake2b512, a standalone Node
  // has it. The algorithm name prefixes the result so hashes produced by
  // different algorithms are never compared against each other.
  const algorithm = pickDigest();
  const hash = createHash(algorithm);
  hash.update(String(size));
  const tag = `${algorithm}:`;
  let handle;
  try {
    handle = await open(filePath, 'r');
    if (size <= FULL_HASH_LIMIT) {
      const buf = Buffer.allocUnsafe(Math.min(size, SAMPLE_CHUNK));
      let pos = 0;
      while (pos < size) {
        const want = Math.min(buf.length, size - pos);
        const { bytesRead } = await handle.read(buf, 0, want, pos);
        if (bytesRead <= 0) break;
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
      return { hash: tag + hash.digest('base64'), sampled: false, algorithm };
    }
    const chunk = Math.min(SAMPLE_CHUNK, Math.floor(size / (SAMPLE_COUNT * 2)));
    const buf = Buffer.allocUnsafe(chunk);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const pos = Math.floor(((size - chunk) * i) / (SAMPLE_COUNT - 1));
      const { bytesRead } = await handle.read(buf, 0, chunk, pos);
      hash.update(buf.subarray(0, bytesRead));
    }
    return { hash: tag + hash.digest('base64'), sampled: true, algorithm };
  } catch (err) {
    return { hash: '', sampled: false, error: err.message, algorithm };
  } finally {
    await handle?.close();
  }
}

/**
 * Find backed-up copies of each scanned file.
 *
 * Stage 1 is the in-memory (name, size) lookup. Stage 2 hashes both sides only
 * when the caller asks for verification (`verify: true`), and always skips the
 * source file itself and any candidate inside the scan root.
 *
 * @param {Array<object>} files Files produced by the WeChat scanner.
 * @param {VolumeIndex} index
 * @param {{verify?:boolean, scanRoot?:string, hashCache?:Map<string,string>, onProgress?:Function, shouldStop?:Function, maxBackupsPerFile?:number}} [options]
 * @returns {Promise<{verified:number, cleared:number, totalBackups:number}>}
 */
export async function matchBackups(files, index, options = {}) {
  const {
    verify = true,
    scanRoot = '',
    hashCache = new Map(),
    onProgress,
    shouldStop,
    maxBackupsPerFile = 3,
  } = options;

  const rootLower = scanRoot.toLowerCase();
  let verified = 0;
  let cleared = 0;
  let totalBackups = 0;

  /**
   * Hash a file, memoised.
   *
   * The value returned by hashFile already carries its algorithm name (and the
   * caller's verify mode decides whether sampled hashes are acceptable), so it is
   * stored as-is: two entries are only equal when they describe the same file
   * content under the same algorithm.
   */
  const cacheHash = async (path, size) => {
    const cached = hashCache.get(path);
    if (cached !== undefined) return cached;
    const { hash, error } = await hashFile(path, size);
    const value = error ? '' : hash;
    hashCache.set(path, value);
    return value;
  };

  for (let i = 0; i < files.length; i++) {
    if (shouldStop?.()) break;
    const file = files[i];
    const candidates = index.lookup(file.name, file.size);

    file.backups = [];
    file.backupCount = 0;

    if (!candidates || !candidates.length) {
      file.backupStatus = 'none';
      file.backupChecked = true;
      onProgress?.({ done: i + 1, total: files.length, verified, cleared });
      continue;
    }

    const selfLower = file.path.toLowerCase();
    const plausible = [];
    for (const cand of candidates) {
      const candLower = cand.path.toLowerCase();
      if (candLower === selfLower) continue;          // the file itself
      if (candLower.startsWith(rootLower)) continue;  // another copy inside WeChat
      plausible.push(cand);
    }

    if (!plausible.length) {
      file.backupStatus = 'none';
      file.backupChecked = true;
      onProgress?.({ done: i + 1, total: files.length, verified, cleared });
      continue;
    }

    let keep = plausible;
    if (verify) {
      const mine = await cacheHash(file.path, file.size);
      if (!mine) {
        // Unreadable source: fall back to the name+size evidence but say so.
        file.backupStatus = 'unverified';
        file.backups = plausible.slice(0, maxBackupsPerFile);
        file.backupCount = plausible.length;
      } else {
        keep = [];
        for (const cand of plausible) {
          const theirs = await cacheHash(cand.path, cand.size);
          if (theirs && theirs === mine) keep.push(cand);
          else cleared++;
        }
        file.backupStatus = keep.length ? 'confirmed' : 'none';
        file.backups = keep.slice(0, maxBackupsPerFile);
        file.backupCount = keep.length;
      }
      verified++;
    } else {
      file.backupStatus = 'candidate';
      file.backups = plausible.slice(0, maxBackupsPerFile);
      file.backupCount = plausible.length;
    }

    totalBackups += file.backupCount;
    file.backupChecked = true;
    onProgress?.({ done: i + 1, total: files.length, verified, cleared });
  }

  return { verified, cleared, totalBackups };
}

/**
 * Build an index from an explicit list of directories instead of the MFT.
 * Used when the app runs without Administrator, and for targeted "only look in
 * these folders" scans.
 *
 * @param {string[]} roots
 * @param {{onProgress?:Function, shouldStop?:Function}} [options]
 * @returns {Promise<VolumeIndex>}
 */
export async function buildDirectoryIndex(roots, options = {}) {
  const { onProgress, shouldStop } = options;
  const index = new VolumeIndex();
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const queue = [...roots];
  let visited = 0;
  while (queue.length) {
    if (shouldStop?.()) break;
    const dir = queue.shift();
    visited++;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const promises = [];
    for (const ent of dirents) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) { queue.push(full); continue; }
      if (!ent.isFile()) continue;
      promises.push((async () => {
        try {
          const st = await stat(full);
          index.add({
            path: full,
            dir,
            name: ent.name,
            size: st.size,
            modifiedMs: st.mtimeMs,
            volume: full.slice(0, 2),
            fromMft: false,
          });
        } catch { /* vanished mid-scan */ }
      })());
    }
    await Promise.all(promises);
    onProgress?.({ phase: 'walk', dirsSeen: visited, files: index.fileCount, current: dir });
  }
  index.builtAt = Date.now();
  return index;
}
