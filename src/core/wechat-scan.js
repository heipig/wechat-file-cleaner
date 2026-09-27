/**
 * WeChat local-file scanner.
 *
 * New WeChat 4.x ("xwechat") keeps each chat payload under
 *   <account>\msg\file\<yyyy-MM>\...   documents
 *   <account>\msg\video\<yyyy-MM>\...  video
 *   <account>\msg\attach\<hash>\...    images/voice, chunked by content hash
 *
 * The month folder is named for when WeChat received the message, while each
 * file keeps the modification time it had at the moment of the transfer:
 *
 *   - A file you RECEIVED was written by WeChat at roughly that moment, so its
 *     mtime falls inside the folder's month.
 *   - A file you SENT already existed on your disk, so WeChat copied it in with
 *     its original mtime — which usually predates the folder's month, sometimes
 *     by years.
 *
 * That gap is the primary sent/received signal. It is a heuristic, not a
 * guarantee (a file created and sent within the same month looks "received"),
 * which is exactly why the backup index exists as an independent second signal.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

/** Recognise "2026-05" and "2026-5" month folder names. */
const MONTH_DIR_RE = /^(\d{4})-(\d{1,2})$/;

/** Recognise the older WeChat layout's "2026-05" or bare "202605". */
const COMPACT_MONTH_RE = /^(\d{4})(\d{2})$/;

/**
 * Interpret a folder name as a month.
 * @param {string} name
 * @returns {{year:number, month:number, start:number, end:number, label:string}|null}
 *   `start` is inclusive Unix ms for the 1st 00:00 local time; `end` is the
 *   exclusive start of the following month.
 */
export function parseMonthFolder(name) {
  const m = MONTH_DIR_RE.exec(name) ?? COMPACT_MONTH_RE.exec(name);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 1990 || year > 2200 || month < 1 || month > 12) return null;
  return {
    year,
    month,
    label: `${year}-${String(month).padStart(2, '0')}`,
    start: new Date(year, month - 1, 1).getTime(),
    end: new Date(year, month, 1).getTime(),
  };
}

/**
 * Find the month a file's containing path belongs to.
 * Walks up from the file at most `maxDepth` levels so nested subfolders still
 * resolve to their enclosing month directory.
 * @param {string} filePath
 * @param {number} [maxDepth]
 * @returns {{year:number, month:number, start:number, end:number, label:string}|null}
 */
export function monthForPath(filePath, maxDepth = 3) {
  const parts = filePath.split(/[\\/]/);
  for (let i = parts.length - 2, depth = 0; i >= 0 && depth < maxDepth; i--, depth++) {
    const parsed = parseMonthFolder(parts[i]);
    if (parsed) return parsed;
  }
  return null;
}

/** Classify a file as sent / received / unknown from its mtime against its month folder. */
export const CLASSIFICATION = {
  SENT: 'sent',
  RECEIVED: 'received',
  UNKNOWN: 'unknown',
};

/**
 * Decide whether a file looks sent or received.
 *
 * @param {number} modifiedMs File mtime in Unix ms.
 * @param {{start:number,end:number,label:string}|null} month Folder month.
 * @param {number} [graceDays] How many days before the month start still counts
 *   as "received": WeChat writes received files during the month, but clock skew
 *   and very-late-night messages can land a file a little early.
 * @returns {{classification:string, deltaDays:number|null, reason:string}}
 */
export function classifyByTime(modifiedMs, month, graceDays = 2) {
  if (!month) {
    return { classification: CLASSIFICATION.UNKNOWN, deltaDays: null, reason: '所在文件夹名不是月份格式，无法判断' };
  }
  if (!modifiedMs) {
    return { classification: CLASSIFICATION.UNKNOWN, deltaDays: null, reason: '文件没有可用的修改时间' };
  }
  const grace = graceDays * 86400000;
  const deltaDays = Math.round((modifiedMs - month.start) / 86400000);

  if (modifiedMs >= month.start - grace && modifiedMs < month.end) {
    return {
      classification: CLASSIFICATION.RECEIVED,
      deltaDays,
      reason: `修改时间落在 ${month.label} 月内，与收件月份一致`,
    };
  }
  if (modifiedMs < month.start - grace) {
    return {
      classification: CLASSIFICATION.SENT,
      deltaDays,
      reason: `修改时间比 ${month.label} 早 ${Math.abs(deltaDays)} 天，说明是本地已有文件被发出`,
    };
  }
  return {
    classification: CLASSIFICATION.SENT,
    deltaDays,
    reason: `修改时间晚于 ${month.label} 文件夹，多半是发出后又改过的本地文件`,
  };
}

/** File kinds used for filtering; keeps the UI vocabulary small. */
export function kindOf(ext) {
  const e = ext.toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.tif', '.tiff', '.svg'].includes(e)) return 'image';
  if (['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.m4v', '.rmvb', '.webm'].includes(e)) return 'video';
  if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma', '.amr', '.silk'].includes(e)) return 'audio';
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv', '.md'].includes(e)) return 'document';
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(e)) return 'archive';
  if (['.exe', '.msi', '.dll', '.bat', '.cmd', '.ps1', '.apk'].includes(e)) return 'executable';
  return 'other';
}

/**
 * Recursively list files under `root`.
 *
 * `root` itself is always enumerated: "do not include subfolders" means "do not
 * descend into child directories", not "return nothing". That distinction
 * matters because the user's folder may be either a parent (`msg\file\`, whose
 * interesting files all live one level down in month folders) or a single month
 * (`msg\file\2022-09`, whose files are direct children).
 *
 * Uses a bounded-concurrency walk rather than `fs.glob` so one unreadable
 * subfolder (locked, permission-denied) cannot abort the whole scan.
 *
 * @param {string} root
 * @param {{recursive?: boolean, concurrency?: number, onProgress?: Function, shouldStop?: Function, minSize?: number, maxSize?: number}} [options]
 * @returns {Promise<Array<object>>} File entries.
 */
export async function scanFolder(root, options = {}) {
  const {
    recursive = true,
    concurrency = 32,
    onProgress,
    shouldStop,
    minSize = 0,
    maxSize = Number.MAX_SAFE_INTEGER,
  } = options;

  const files = [];
  let dirsSeen = 0;
  const queue = [root];

  while (queue.length) {
    if (shouldStop?.()) break;
    const batch = queue.splice(0, concurrency);
    dirsSeen += batch.length;

    const results = await Promise.all(batch.map(async (dir) => {
      try {
        return await readdir(dir, { withFileTypes: true });
      } catch {
        return null; // unreadable directory: skip, never abort
      }
    }));

    for (let i = 0; i < results.length; i++) {
      const dirents = results[i];
      if (!dirents) continue;
      const dir = batch[i];
      // Files directly inside `root` are always collected, so that pointing at a
      // single month folder with "include subfolders" off still lists that
      // month's files. Descending into subdirectories, however, happens only
      // when recursion is on — pointing at the parent folder with recursion off
      // legitimately yields nothing, because its files all live one level down.

      const subdirs = [];
      const candidates = [];
      for (const ent of dirents) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (recursive) subdirs.push(full);
        } else if (ent.isFile()) {
          candidates.push(full);
        }
      }
      queue.push(...subdirs);

      const stats = await Promise.all(candidates.map(async (full) => {
        try {
          return [full, await stat(full)];
        } catch {
          return null;
        }
      }));

      for (const item of stats) {
        if (!item) continue;
        const [full, st] = item;
        if (st.size < minSize || st.size > maxSize) continue;
        const ext = extname(full);
        files.push({
          path: full,
          name: full.slice(full.lastIndexOf('\\') + 1),
          dir: full.slice(0, full.lastIndexOf('\\')),
          ext: ext.toLowerCase(),
          kind: kindOf(ext),
          size: st.size,
          modifiedMs: st.mtimeMs,
          createdMs: st.birthtimeMs,
          // mtime floored to the second: WeChat stores second precision, and
          // rounding here keeps index/backup comparisons stable.
          modifiedSec: Math.floor(st.mtimeMs / 1000),
        });
      }
      onProgress?.({ dirsSeen, files: files.length, current: dir });
    }
  }

  return files;
}

/**
 * Scan a WeChat folder and attach the month + sent/received verdict to each file.
 * @param {string} root
 * @param {{recursive?:boolean, graceDays?:number, onProgress?:Function, shouldStop?:Function}} [options]
 * @returns {Promise<{root:string, files:Array<object>, months:Array<string>}>}
 */
export async function scanWeChatFolder(root, options = {}) {
  const { graceDays = 2, ...rest } = options;
  const files = await scanFolder(root, rest);

  for (const file of files) {
    const month = monthForPath(file.path);
    const verdict = classifyByTime(file.modifiedMs, month, graceDays);
    file.month = month?.label ?? null;
    file.monthStart = month?.start ?? null;
    file.classification = verdict.classification;
    file.deltaDays = verdict.deltaDays;
    file.classifyReason = verdict.reason;
    // Default the UI filter to "worth reviewing": anything you sent, plus
    // anything old enough that a backup is likely to exist somewhere.
    file.selected = verdict.classification === CLASSIFICATION.SENT;
  }

  const months = [...new Set(files.map((f) => f.month).filter(Boolean))].sort();
  return { root, files, months };
}

/** Byte size for display. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** Local timestamp for display. */
export function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
