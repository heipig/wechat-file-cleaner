/**
 * Electron main process for the WeChat file cleaner.
 *
 * Responsibilities:
 *   - own the window and the IPC surface exposed through the preload bridge;
 *   - run the expensive work (MFT indexing, folder scanning, hash verification,
 *     deletion) and stream progress to the renderer;
 *   - persist settings under the user's app data directory;
 *   - detect whether it is elevated, since reading the NTFS MFT needs it.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, closeSync,
} from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';

import { scanWeChatFolder, formatSize, formatTime, CLASSIFICATION } from '../core/wechat-scan.js';
import { buildVolumeIndex, buildDirectoryIndex, matchBackups, describeIndexProblem, planIndexSource } from '../mft/mft-index.js';
import { probeVolumeAccess, openVolume, readExact, parseBootSector } from '../mft/ntfs.js';
import { initLogger, getLogDirs, getLogFile, getLogFiles, log, logError } from '../core/logger.js';
import { helperScriptPath, findNodeExecutable } from '../core/volume-source.js';
import { deleteFiles as runDeleteHelper, setDeleteScriptDir, deleteWorkDir } from '../core/delete.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const isDev = process.argv.includes('--dev') || !app.isPackaged;

/**
 * Directory the deletion helper writes its generated scripts and reports to.
 *
 * The recycle helper is a generated .vbs run by cscript.exe, so there is no
 * long-lived script path to resolve — only a writable directory. Kept next to the
 * program's logs so everything diagnostic lives in one place.
 */
const deleteWorkDirectory = join(app.getPath('userData'), 'delete-work');

const SETTINGS_FILE = () => join(app.getPath('userData'), 'settings.json');

/** The live application state. */
const state = {
  window: null,
  settings: null,
  scan: null,          // { root, files, months, scannedAt }
  index: null,         // VolumeIndex
  hashCache: new Map(),
  busy: false,
  cancelRequested: false,
  elevated: false,
  lastError: null,     // most recent failure, surfaced by the 自检 panel
};

/** Record a failure so the in-app self-check can report it verbatim. */
function noteError(stage, err) {
  state.lastError = {
    stage,
    at: new Date().toISOString(),
    message: err?.message ?? String(err),
    name: err?.name,
    code: err?.code,
  };
  logError('ipc', stage, err);
  return err;
}

/** Wrap an IPC handler so any throw is recorded before propagating. */
function withErrorLog(stage, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw noteError(stage, err);
    }
  };
}

const DEFAULT_SETTINGS = {
  lastFolder: '',
  recursive: true,
  graceDays: 2,
  volumes: ['C', 'D'],
  verifyHash: true,
  fallbackFolders: [],
  deleteMode: 'recycle',       // 'recycle' | 'permanent'
  confirmDelete: true,
  confirmPermanent: true,
  language: detectLanguage(),
  searchScope: 'mft',          // 'mft' | 'folders'
  skipSmallFiles: 0,
  columns: null,
  // 'dark' | 'light' | null. null means 'follow the OS on first run'; an explicit
  // choice is persisted and always wins. Applied to the native window background as
  // well as the page, so the window does not flash the wrong colour while loading.
  theme: null,
};

/** Default UI language from the OS locale. */
function detectLanguage() {
  try {
    const locale = app.getLocale() || '';
    return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

function loadSettings() {
  const file = SETTINGS_FILE();
  try {
    if (existsSync(file)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file, 'utf8')) };
    }
  } catch { /* fall through to defaults on a corrupt file */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(patch) {
  state.settings = { ...state.settings, ...(patch ?? {}) };
  try {
    mkdirSync(dirname(SETTINGS_FILE()), { recursive: true });
    writeFileSync(SETTINGS_FILE(), JSON.stringify(state.settings, null, 2), 'utf8');
  } catch (err) {
    console.error('failed to persist settings:', err.message);
  }
  return state.settings;
}

/** True when this process can open a raw volume handle. */
function isElevated() {
  // Opening the raw volume is the operation that actually matters: `net session`
  // can be blocked by policy even for a genuinely elevated process, so probe
  // what we really need. The result is cached inside ntfs.js.
  const drives = listDrives();
  for (const { letter } of drives) {
    if (probeVolumeAccess(letter).ok) return true;
  }
  // No NTFS volume was openable — try the traditional probe as a secondary hint.
  try {
    execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true });
    log.warn('elevation', 'no raw volume readable, but `net session` succeeded; treating as elevated');
    return true;
  } catch {
    log.warn('elevation', 'NOT elevated: no raw volume readable and `net session` failed');
    return false;
  }
}

/**
 * Directly open each volume and read its boot sector, logging the exact outcome.
 *
 * Deliberately separate from `probeVolumeAccess`, which caches a boolean: when
 * volume access fails in the field the only useful evidence is the raw per-drive
 * error, recorded where it can be read back later.
 *
 * @param {Array<{letter:string,type:string}>} drives
 * @returns {Array<object>} Per-drive results.
 */
function logVolumeAccess(drives) {
  const results = [];
  for (const { letter, type } of drives) {
    let fd;
    try {
      fd = openVolume(letter);
      const boot = Buffer.alloc(512);
      readExact(fd, boot, 0, 512);
      const parsed = parseBootSector(boot, letter);
      results.push({
        letter,
        type,
        ok: true,
        clusterSize: parsed.clusterSize,
        recordSize: parsed.recordSize,
        mftCluster: parsed.mftCluster,
      });
      log.info('volume', `${letter}: readable (cluster=${parsed.clusterSize} record=${parsed.recordSize} mftCluster=${parsed.mftCluster})`);
    } catch (err) {
      results.push({ letter, type, ok: false, error: err.message, code: err.code, errno: err.errno });
      logError('volume', `raw open of \\\\.\\${letter}: FAILED`, err);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  return results;
}

/**
 * Enumerate the drive letters Windows reports, so the volume picker reflects
 * the real machine instead of a hardcoded guess.
 * @returns {Array<{letter:string, type:string}>}
 */
function listDrives() {
  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object -Property DeviceID,DriveType | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const parsed = JSON.parse(raw.trim() || '[]');
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((d) => d?.DeviceID)
      .map((d) => ({
        letter: String(d.DeviceID).replace(':', ''),
        type: String(d.DriveType), // 3 = local fixed disk, 2 = removable
      }));
  } catch {
    // CIM can be unavailable; fall back to probing the usual letters.
    return ['C', 'D', 'E', 'F'].map((letter) => ({ letter, type: '3' }));
  }
}

/**
 * The theme to use right now.
 *
 * An explicit setting wins; otherwise the OS preference decides, so a first run on a
 * light-themed desktop does not open a dark window.
 *
 * @returns {'dark'|'light'}
 */
function resolveTheme() {
  if (state.settings?.theme === 'light' || state.settings?.theme === 'dark') return state.settings.theme;
  try {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/** Create the tray-less single window. */
function createWindow() {
  const theme = resolveTheme();
  const win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1040,
    minHeight: 620,
    backgroundColor: theme === 'light' ? '#f2f4f7' : '#11141a',
    title: '微信收发文件清理器',
    show: false,
    webPreferences: {
      preload: join(here, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(join(here, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    if (state.window === win) state.window = null;
  });

  // Store it: every dialog parent and every progress emit reads `state.window`,
  // and leaving it null made the confirmation dialog parentless (it opened behind
  // the app, which looks exactly like a crash) and silently dropped all progress.
  state.window = win;
  return win;
}

/** Send an IPC message to the renderer, tolerating a torn-down window. */
function emit(channel, payload) {
  const wc = state.window?.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, payload);
}

/**
 * The window a dialog should be parented to.
 *
 * Taken from the IPC event rather than `state.window`, because a parentless modal
 * dialog opens behind the application and makes the app look like it vanished —
 * which is exactly how a missing parent manifested once. Falling back to the
 * tracked window keeps non-IPC callers working.
 *
 * @param {import('electron').IpcMainInvokeEvent} [event]
 * @returns {import('electron').BrowserWindow|null}
 */
function parentWindowFor(event) {
  try {
    const fromEvent = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
    if (fromEvent && !fromEvent.isDestroyed()) return fromEvent;
  } catch { /* fall through to the tracked window */ }
  return state.window && !state.window.isDestroyed() ? state.window : null;
}

/** Throttled progress emitter so a fast loop cannot flood the renderer. */
function makeProgressEmitter(channel, minIntervalMs = 120) {
  let last = 0;
  let pending = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending) {
      emit(channel, pending);
      pending = null;
      last = Date.now();
    }
  };
  return (payload, force = false) => {
    pending = payload;
    const now = Date.now();
    if (force || now - last >= minIntervalMs) {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, minIntervalMs - (now - last));
    }
  };
}

const scanProgress = makeProgressEmitter('scan:progress');
const indexProgress = makeProgressEmitter('index:progress');
const matchProgress = makeProgressEmitter('match:progress');

/**
 * Run `worker` over `items` with bounded concurrency, preserving order.
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Scan a WeChat folder and attach sent/received classification. */
async function doScan({ root, recursive, graceDays }) {
  state.cancelRequested = false;
  scanProgress({ phase: 'start', root }, true);
  const result = await scanWeChatFolder(root, {
    recursive,
    graceDays,
    onProgress: (p) => scanProgress({ phase: 'walking', ...p }),
    shouldStop: () => state.cancelRequested,
  });
  // Drop anything below the configured size floor before it reaches the UI.
  const floor = Number(state.settings?.skipSmallFiles) || 0;
  if (floor > 0) result.files = result.files.filter((f) => f.size >= floor);

  result.scannedAt = Date.now();
  const sent = result.files.filter((f) => f.classification === CLASSIFICATION.SENT).length;
  scanProgress({ phase: 'done', files: result.files.length, sent }, true);
  return {
    ...result,
    summary: {
      files: result.files.length,
      bytes: result.files.reduce((s, f) => s + f.size, 0),
      sent,
      received: result.files.length - sent,
      months: result.months,
    },
  };
}

/**
 * Summarise paths for logging without disclosing them.
 *
 * Logs are written next to the executable and travel with the program, and users
 * share them when reporting a problem. A raw path would then expose their directory
 * layout and WeChat account id — the very thing the folder picker is used to choose.
 * The shape of a path (how deep, which drive) is what makes a log useful, so the
 * drive and depth are kept and the names are not.
 *
 * @param {string} path
 * @returns {string} e.g. `D:\…\…\2022-09` reduced to `D:\…(3 levels)`
 */
function redactPath(path) {
  const text = String(path ?? '');
  if (!text) return '(none)';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? '') ? parts[0] : null;
  const depth = parts.length - (drive ? 1 : 0);
  const leaf = parts[parts.length - 1] ?? '';
  // A month folder is the one component worth keeping: it is not identifying, and it
  // is how the app organises its work.
  const month = /^\d{4}-\d{1,2}$/.test(leaf) ? `\\${leaf}` : '';
  return `${drive ? `${drive}\\` : ''}…(${depth} levels)${month}`;
}

/** Build (or rebuild) the backup index from the MFT, or from folders. */
async function doBuildIndex({ volumes, scope, folders }) {
  state.cancelRequested = false;
  indexProgress({ phase: 'start', scope }, true);
  log.info('index', `build requested: scope=${scope} volumes=${(volumes ?? []).join(',') || '(none)'}`
    + ` folders=${(folders ?? []).map(redactPath).join(' | ') || '(none)'}`);

  if (scope === 'folders') {
    const roots = (folders ?? []).filter(Boolean);
    if (!roots.length) {
      // Refuse rather than produce an empty index that would silently report
      // "no backups" for every file.
      const err = new Error('目录索引模式下需要先选择至少一个用于查找备份的文件夹。');
      logError('index', 'folder mode with no folders', err);
      throw err;
    }
    const started = Date.now();
    const index = await buildDirectoryIndex(roots, {
      onProgress: (p) => indexProgress({ phase: 'walk', ...p }),
      shouldStop: () => state.cancelRequested,
    });
    state.index = index;
    const stats = index.stats();
    log.info('index', `folder index built: files=${stats.files} buckets=${stats.buckets} elapsed=${Date.now() - started}ms`);
    indexProgress({ phase: 'done', ...stats }, true);
    return stats;
  }

  const driveList = (volumes ?? []).filter(Boolean);
  if (!driveList.length) {
    const err = new Error('请至少选择一个要索引的盘符。');
    logError('index', 'mft mode with no drives selected', err);
    throw err;
  }

  const index = await buildVolumeIndex(driveList, {
    // These two matter in a packaged build: the MFT helper lives OUTSIDE the asar
    // (a child Node process cannot read into an asar archive), so the resolver
    // must be told that the app is packaged and where its resources live.
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    onProgress: (p) => {
      if (p.phase === 'enumerate' && p.recordsRead % 100000 < 65536) {
        log.info('index', `${p.volume}: ${p.recordsRead}/${p.totalRecords} records, kept ${p.kept ?? 0}`);
      }
      indexProgress({ phase: p.phase, ...p });
    },
    shouldStop: () => state.cancelRequested,
  });
  state.index = index;
  const stats = index.stats();
  for (const v of stats.volumes) {
    if (v.error) {
      logError('index', `volume ${v.volume} failed to index`, { message: v.error, name: 'VolumeIndexError' });
    } else {
      log.info('index', `volume ${v.volume}: files=${v.files} records=${v.records} elapsed=${v.elapsedMs}ms`);
    }
  }
  log.info('index', `mft index result: files=${stats.files} buckets=${stats.buckets}`);
  indexProgress({ phase: 'done', ...stats }, true);
  return stats;
}

/**
 * Ensure an index usable for matching, building one on demand if needed.
 *
 * The user should not have to know that matching needs an index. If the
 * configured source can produce one — folder mode always can, MFT mode only when
 * elevated — build it transparently and report what happened.
 *
 * @returns {Promise<{built:boolean, stats:object|null, problem:string|null}>}
 */
async function ensureIndex({ preferFolders = false } = {}) {
  const folderList = (state.settings.fallbackFolders ?? []).filter(Boolean);
  const plan = planIndexSource({
    indexFiles: state.index?.fileCount ?? 0,
    scope: state.settings.searchScope ?? 'mft',
    folders: folderList,
    volumes: state.settings.volumes ?? [],
    elevated: state.elevated,
    preferFolders,
  });

  switch (plan.action) {
    case 'reuse':
      return { built: false, stats: state.index.stats(), problem: null };
    case 'build-folders': {
      const stats = await doBuildIndex({ scope: 'folders', folders: folderList });
      return { built: true, stats, problem: null };
    }
    case 'switch-to-folders': {
      const stats = await doBuildIndex({ scope: 'folders', folders: folderList });
      saveSettings({ searchScope: 'folders' });
      return { built: true, stats, problem: null, note: plan.note };
    }
    case 'build-mft': {
      const stats = await doBuildIndex({ scope: 'mft', volumes: state.settings.volumes ?? [] });
      const problem = describeIndexProblem(state.index);
      if (!problem) return { built: true, stats, problem: null };
      // A build that reports success but yields nothing (e.g. MFT read denied
      // despite the elevation probe) still falls back to folders when possible.
      if (folderList.length) {
        const fallbackStats = await doBuildIndex({ scope: 'folders', folders: folderList });
        saveSettings({ searchScope: 'folders' });
        return {
          built: true,
          stats: fallbackStats,
          problem: null,
          note: '读不到 NTFS 主文件表，已改用文件夹索引。',
        };
      }
      return { built: false, stats: null, problem };
    }
    default:
      return { built: false, stats: null, problem: plan.reason };
  }
}

/** Verify backups for the current scan against the current index. */
async function doMatch({ onlyPaths, autoIndex = true } = {}) {
  if (!state.scan) throw new Error('尚未扫描微信文件夹，请先点“开始扫描”。');

  let indexNote = null;
  if (autoIndex) {
    const ensured = await ensureIndex();
    indexNote = ensured.note ?? null;
    if (ensured.problem) throw new Error(ensured.problem);
  } else {
    const problem = describeIndexProblem(state.index);
    if (problem) throw new Error(problem);
  }
  state.cancelRequested = false;

  const targets = onlyPaths?.length
    ? state.scan.files.filter((f) => onlyPaths.includes(f.path))
    : state.scan.files;

  matchProgress({ phase: 'start', total: targets.length }, true);

  // Hashing is I/O bound; a small pool keeps the disk busy without thrashing.
  const concurrency = 4;
  let done = 0;
  const results = await mapConcurrent(targets, concurrency, async (file) => {
    const out = await matchBackups([file], state.index, {
      verify: state.settings.verifyHash,
      scanRoot: state.scan.root,
      hashCache: state.hashCache,
      maxBackupsPerFile: 3,
    });
    done++;
    matchProgress({ phase: 'hashing', done, total: targets.length, verified: out.verified });
    return out;
  });

  const summary = results.reduce((acc, r) => ({
    verified: acc.verified + r.verified,
    cleared: acc.cleared + r.cleared,
    totalBackups: acc.totalBackups + r.totalBackups,
  }), { verified: 0, cleared: 0, totalBackups: 0 });

  const withBackup = targets.filter((f) => (f.backupCount ?? 0) > 0).length;
  matchProgress({ phase: 'done', ...summary, withBackup, total: targets.length }, true);

  // The renderer only needs the changed fields; sending the whole list back
  // would duplicate megabytes of path strings it already holds.
  return {
    summary: { ...summary, withBackup, total: targets.length },
    indexNote,
    index: state.index?.stats() ?? null,
    updates: targets.map((f) => ({
      path: f.path,
      backupStatus: f.backupStatus,
      backupCount: f.backupCount ?? 0,
      backups: f.backups ?? [],
      backupChecked: true,
    })),
  };
}

/**
 * Delete the requested files through the shared helper module.
 *
 * @param {{paths:string[], mode:'recycle'|'permanent'}} request
 * @returns {Promise<object>}
 */
function doDelete({ paths, mode }) {
  return runDeleteHelper({ paths, mode, tempDir: deleteWorkDirectory });
}
/** Refresh one file's stat data (used after a failed delete or an external change). */
function statFile(path) {
  try {
    const st = statSync(path);
    return {
      path,
      exists: true,
      size: st.size,
      modifiedMs: st.mtimeMs,
      modifiedText: formatTime(st.mtimeMs),
      sizeText: formatSize(st.size),
      name: basename(path),
    };
  } catch {
    return { path, exists: false };
  }
}

/** The renderer-facing snapshot of everything the app knows right now. */
function getStatePayload() {
  return {
    settings: state.settings,
    elevated: state.elevated,
    drives: listDrives(),
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    scan: state.scan
      ? {
        root: state.scan.root,
        months: state.scan.months,
        scannedAt: state.scan.scannedAt,
        summary: state.scan.summary,
        files: state.scan.files.map((f) => ({
          path: f.path,
          name: f.name,
          dir: f.dir,
          ext: f.ext,
          kind: f.kind,
          size: f.size,
          sizeText: formatSize(f.size),
          modifiedMs: f.modifiedMs,
          modifiedText: formatTime(f.modifiedMs),
          month: f.month,
          classification: f.classification,
          deltaDays: f.deltaDays,
          classifyReason: f.classifyReason,
          backupStatus: f.backupStatus ?? 'unchecked',
          backupCount: f.backupCount ?? 0,
          backups: f.backups ?? [],
        })),
      }
      : null,
    index: state.index ? state.index.stats() : null,
  };
}

function registerIpc() {
  ipcMain.handle('drives:list', () => listDrives());

  // Renderer diagnostics. Synchronous so a line logged immediately before a fatal
  // renderer error still reaches disk before the page disappears.
  ipcMain.on('renderer:log', (event, tag, message) => {
    log.info(`renderer:${tag}`, message);
    event.returnValue = true;
  });

  ipcMain.handle('app:state', () => getStatePayload());
  // Settings writes are frequent (every checkbox) and cheap, so they must not
  // re-serialise the whole file list back to the renderer.
  ipcMain.handle('app:settings', (_e, patch) => saveSettings(patch));

  ipcMain.handle('dialog:pickFolder', async (_e, defaultPath) => {
    const res = await dialog.showOpenDialog(parentWindowFor(_e) ?? undefined, {
      title: '选择微信收发文件夹',
      defaultPath: defaultPath || state.settings.lastFolder || 'D:\\',
      properties: ['openDirectory'],
      buttonLabel: '选择此文件夹',
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dialog:pickFolders', async (_e) => {
    const res = await dialog.showOpenDialog(parentWindowFor(_e) ?? undefined, {
      title: '选择用于查找备份的文件夹',
      properties: ['openDirectory', 'multiSelections'],
      buttonLabel: '添加',
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('scan:start', withErrorLog('scan:start', async (_e, opts) => {
    if (state.busy) throw new Error('已有任务在运行');
    state.busy = true;
    try {
      state.scan = await doScan({ ...state.settings, ...opts });
      saveSettings({ lastFolder: state.scan.root, recursive: opts.recursive, graceDays: opts.graceDays });
      return getStatePayload().scan;
    } finally {
      state.busy = false;
    }
  }));

  ipcMain.handle('index:build', withErrorLog('index:build', async (_e, opts) => {
    if (state.busy) throw new Error('已有任务在运行');
    state.busy = true;
    try {
      saveSettings({ volumes: opts.volumes, searchScope: opts.scope, fallbackFolders: opts.folders });
      return await doBuildIndex(opts);
    } finally {
      state.busy = false;
    }
  }));

  ipcMain.handle('match:start', withErrorLog('match:start', async (_e, opts) => {
    if (state.busy) throw new Error('已有任务在运行');
    state.busy = true;
    try {
      return await doMatch(opts ?? {});
    } finally {
      state.busy = false;
    }
  }));

  ipcMain.handle('task:cancel', () => { state.cancelRequested = true; return true; });

  ipcMain.handle('files:delete', withErrorLog('files:delete', async (event, { paths, mode, confirmed }) => {
    // Logged at entry: "the app vanished when I clicked delete" was previously
    // indistinguishable from the handler never running at all.
    log.info('delete', `requested: count=${paths?.length ?? 0} mode=${mode ?? state.settings.deleteMode}`);
    if (!paths?.length) return { ok: true, succeeded: [], failed: [] };
    const effectiveMode = mode ?? state.settings.deleteMode;

    // Confirmation. The renderer asks in-app and passes `confirmed: true`; the
    // native dialog below is only a fallback for a caller that has not confirmed.
    //
    // `confirmed` must short-circuit BOTH modes. It previously only covered the
    // recycle branch, so a permanent delete asked twice — and the second prompt was
    // the native dialog that hangs on some machines.
    //
    // The native dialog is time-boxed and logged on both sides: on one machine it
    // appeared but never resolved (the log showed "showing confirmation" followed by
    // two minutes of silence), so the app looked frozen. The timeout turns that into
    // a clean cancellation, and the resolve log makes a stall unambiguous.
    const confirmSetting = effectiveMode === 'permanent'
      ? state.settings.confirmPermanent
      : state.settings.confirmDelete;
    const needsDialog = confirmed !== true && confirmSetting;
    if (needsDialog) {
      const sizeText = formatSize(paths.reduce((sum, p) => {
        const stat = state.scan?.files.find((f) => f.path === p);
        return sum + (stat?.size ?? 0);
      }, 0));
      const isPermanent = effectiveMode === 'permanent';
      const parent = parentWindowFor(event);
      // A parentless modal can sit behind the app on Windows, which the user
      // experiences as the program disappearing.
      if (!parent) {
        logError('delete', 'no parent window for the confirmation dialog', new Error('window unavailable'));
        throw new Error('无法获取主窗口，已取消删除以避免界面卡死。请重启程序后重试。');
      }
      const timeoutMs = 120_000;
      log.info('delete', `showing ${isPermanent ? 'permanent' : 'recycle'} confirmation natively (count=${paths.length} size=${sizeText} parentWindow=true timeoutMs=${timeoutMs})`);
      const dialogStarted = Date.now();
      let res;
      let timedOut = false;
      let timer = null;
      try {
        // Raced against a timer rather than relying on the dialog's own `timeout`
        // option, whose support varies by Electron version. A dialog that never
        // resolves must not be able to freeze the app.
        res = await Promise.race([
          dialog.showMessageBox(parent, {
            type: isPermanent ? 'warning' : 'question',
            buttons: [isPermanent ? '永久删除' : '移到回收站', '取消'],
            defaultId: isPermanent ? 1 : 0,
            cancelId: 1,
            noLink: true,
            title: isPermanent ? '确认永久删除' : '确认删除',
            message: isPermanent
              ? `即将永久删除 ${paths.length} 个文件（${sizeText}），此操作无法撤销。`
              : `将 ${paths.length} 个文件（${sizeText}）移到回收站？`,
            detail: isPermanent
              ? '如果你希望可以恢复，请改用“移到回收站”。'
              : '回收站里的文件可以随时还原。',
          }),
          new Promise((resolve) => {
            timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs);
          }),
        ]);
      } catch (err) {
        logError('delete', 'the confirmation dialog threw', err);
        throw new Error(`确认对话框出错，已取消删除：${err.message}`);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (timedOut) {
        // The dialog is still on screen and may still be answered, but its answer is
        // no longer awaited. Report the cancellation instead of hanging.
        logError('delete', `the confirmation dialog did not resolve within ${timeoutMs}ms; treating as cancelled`,
          new Error('confirmation dialog timeout'));
        return { ok: false, canceled: true, succeeded: [], failed: [] };
      }
      log.info('delete', `native confirmation resolved after ${Date.now() - dialogStarted}ms: response=${res?.response}`);
      if (res?.response !== 0) return { ok: false, canceled: true, succeeded: [], failed: [] };
    }

    log.info('delete', `invoking the deletion engine for ${paths.length} files (mode=${effectiveMode})`);
    const result = await doDelete({ paths, mode: effectiveMode });
    log.info('delete', `deletion engine returned: ok=${result.ok} succeeded=${(result.succeeded ?? []).length} failed=${(result.failed ?? []).length} recycled=${result.recycled === true}`);
    for (const item of (result.failed ?? []).slice(0, 5)) {
      // File name only: logs are written next to the executable and travel with it,
      // so a full path would disclose the user's directory layout and account id.
      log.warn('delete', `  failed: ${basename(item.path ?? '')} -> ${item.error}`);
    }
    const removed = new Set((result.succeeded ?? []).map((s) => s.path));
    if (state.scan && removed.size) {
      state.scan.files = state.scan.files.filter((f) => !removed.has(f.path));
      state.scan.summary = {
        ...state.scan.summary,
        files: state.scan.files.length,
        bytes: state.scan.files.reduce((s, f) => s + f.size, 0),
      };
    }
    return result;
  }));

  ipcMain.handle('shell:openFolder', (_e, path) => shell.openPath(path));
  ipcMain.handle('shell:reveal', (_e, path) => { shell.showItemInFolder(path); return true; });
  ipcMain.handle('file:stat', (_e, path) => statFile(path));

  ipcMain.handle('app:relaunchElevated', async () => {
    // Relaunch through the shell so Windows raises the UAC prompt.
    const exe = process.execPath;
    const args = app.isPackaged ? [] : [projectRoot];
    const argumentList = args.map((a) => a.replace(/'/g, "''")).join("','");
    const command = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList '${argumentList}' -Verb RunAs`;
    log.info('elevation', `requesting elevation: ${command}`);
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.on('error', (err) => logError('elevation', 'spawn for elevation failed', err));
      child.unref();
    } catch (err) {
      logError('elevation', 'could not start the elevation helper', err);
      return false;
    }
    // Give the UAC prompt time to appear before this instance exits.
    setTimeout(() => app.quit(), 1500);
    return true;
  });

  ipcMain.handle('log:reveal', () => {
    // Prefer the log that travels with the program: that is the one a user can find
    // and send from another machine without knowing where %APPDATA% is.
    const file = getLogFile();
    if (file && existsSync(file)) { shell.showItemInFolder(file); return file; }
    const dir = getLogDirs()[0];
    if (dir) shell.openPath(dir);
    return file;
  });

  /**
   * Read the logs for the in-app viewer.
   *
   * Returns every destination plus the tail of each, so a log written next to the
   * program is readable from inside the app even when the program folder is not
   * somewhere the user would think to look.
   */
  ipcMain.handle('log:read', () => {
    const TAIL = 120_000;
    const sources = getLogFiles().map((file) => {
      try {
        const text = readFileSync(file, 'utf8');
        return { file, text: text.length > TAIL ? text.slice(-TAIL) : text };
      } catch (err) {
        return { file, text: `（无法读取：${err.message}）` };
      }
    });
    return { sources, dirs: getLogDirs() };
  });

  ipcMain.handle('self:test', async () => {
    const drives = listDrives();
    return {
      elevated: state.elevated,
      appIsPackaged: app.isPackaged,
      drives,
      settingsPath: SETTINGS_FILE(),
      userData: app.getPath('userData'),
      logFile: getLogFile(),
      // Paths are the most common source of packaged-build failures, so report
      // them explicitly rather than leaving the user to infer them.
      paths: {
        resourcesPath: process.resourcesPath,
        execPath: process.execPath,
        helperScript: helperScriptPath(app.isPackaged, process.resourcesPath),
        helperExists: existsSync(helperScriptPath(app.isPackaged, process.resourcesPath)),
        nodeRuntime: findNodeExecutable({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
        deleteWorkDir: deleteWorkDirectory,
        deleteWorkDirExists: existsSync(deleteWorkDirectory),
        // The recycle helper is generated on demand, so report whether the runtime
        // it needs is present rather than a script path.
        cscript: process.env.SystemRoot
          ? join(process.env.SystemRoot, 'System32', 'cscript.exe')
          : 'cscript.exe',
        logFiles: getLogFiles(),
        logDirs: getLogDirs(),
      },
      theme: resolveTheme(),
      searchScope: state.settings?.searchScope ?? 'mft',
      fallbackFolders: state.settings?.fallbackFolders ?? [],
      index: state.index ? state.index.stats() : null,
      lastError: state.lastError ?? null,
      // Prefer the detailed per-drive results captured at startup.
      volumeAccess: state.volumeAccess?.length
        ? state.volumeAccess
        : drives.map(({ letter }) => {
          const probe = probeVolumeAccess(letter);
          return { letter, ok: probe.ok, error: probe.error, boot: probe.boot };
        }),
    };
  });
}

/**
 * Bootstrap. Wrapped in a guard so importing this module (for tests or tooling)
 * never boots Electron or touches the app lifecycle.
 */
async function main() {
  await app.whenReady();

  // Logging first: everything below it is worth recording, especially when the app
  // cannot do its job and the user has no console to copy from.
  //
  // Two destinations: one that travels with the program (so a log from another
  // machine can be retrieved without knowing its %APPDATA%), and Electron's
  // userData directory (which always exists, even when the program folder is
  // read-only). Each is skipped if it is not writable.
  const travelLogDir = app.isPackaged ? join(dirname(process.execPath), 'logs') : null;
  const logTargets = initLogger({
    travelDir: travelLogDir,
    userDataDir: join(app.getPath('userData'), 'logs'),
  });

  // The deletion helper generates its .vbs into this directory, so it must be
  // configured before any delete can run.
  setDeleteScriptDir(deleteWorkDirectory);

  // A crash in the main process kills the window with no explanation, which is
  // exactly what "the app just disappears" looks like to a user. Record it and show
  // it, so a crash is diagnosable instead of mysterious.
  process.on('uncaughtException', (err) => {
    logError('crash', 'uncaught exception in the main process', err);
    try {
      dialog.showErrorBox('程序内部错误', `${err?.message ?? err}\n\n日志：${getLogFile() ?? '(不可用)'}`);
    } catch { /* a dialog may not be possible this late */ }
  });
  process.on('unhandledRejection', (reason) => {
    logError('crash', 'unhandled promise rejection', reason instanceof Error ? reason : { message: String(reason) });
  });

  log.info('startup', '================= app start =================');
  log.info('startup', `version=${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node}`);
  log.info('startup', `packaged=${app.isPackaged} argv=${process.argv.slice(1).join(' ')}`);
  log.info('startup', `execPath=${process.execPath}`);
  log.info('startup', `userData=${app.getPath('userData')}`);
  log.info('startup', `logFiles=${logTargets.files.join(' | ') || '(unavailable)'}`);
  log.info('startup', `logWriteFailedFor=${[travelLogDir, join(app.getPath('userData'), 'logs')]
    .filter((d) => d && !logTargets.dirs.includes(d)).join(' | ') || '(none)'}`);
  log.info('startup', `deleteWorkDir=${deleteWorkDirectory}`);
  log.info('startup', `platform=${process.platform} arch=${process.arch} locale=${app.getLocale()}`);
  log.info('startup', `powershellPolicyRelevant=no (deletion uses cscript + Node fs)`);

  Menu.setApplicationMenu(null);
  state.settings = loadSettings();
  log.info('startup', `settings=${JSON.stringify(state.settings)}`);

  const drives = listDrives();
  log.info('startup', `drives=${drives.map((d) => `${d.letter}:(type ${d.type})`).join(' ') || '(none detected)'}`);
  const volumeAccess = logVolumeAccess(drives);
  state.volumeAccess = volumeAccess;

  state.elevated = isElevated();
  log.info('startup', `elevated=${state.elevated}`);

  createWindow();
  registerIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // A renderer crash should be visible in the log rather than silently blank.
  app.on('render-process-gone', (_e, _wc, details) => {
    logError('renderer', 'render process gone', { message: `${details.reason} (exitCode=${details.exitCode})` });
  });
}

main().catch((err) => {
  logError('startup', 'fatal error during startup', err);
  app.quit();
});

export { isElevated, listDrives };
