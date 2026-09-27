/**
 * Persistent file logger.
 *
 * The app has to be diagnosable without a console: it is launched by double-click,
 * often elevated, and the interesting failures (raw-volume access, index build,
 * deletion) happen before or outside any UI the user can copy text from. Everything
 * important therefore lands in append-only UTF-8 files whose paths the UI can reveal.
 *
 * Two destinations are kept because they answer different questions:
 *
 *   1. A location that TRAVELS with the program, so a log produced on another
 *      machine can be read without knowing where that machine's `%APPDATA%` is.
 *      The app passes a directory next to its own executable; if that is not
 *      writable (Program Files, a read-only share) it is skipped, not fatal.
 *   2. Electron's userData directory, which always exists, so a log survives even
 *      when the program folder is read-only.
 *
 * This module is dependency-free and never throws: a logger that breaks the app it
 * is instrumenting would be worse than no logger at all.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;

/** Every file currently receiving log lines, most-travellable first. */
let logFiles = [];
/** Every directory that holds a log file. */
let logDirs = [];

/** Pad a number to two digits. */
const p2 = (n) => String(n).padStart(2, '0');

/** Local timestamp with milliseconds. */
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Verify a directory can actually be written to before relying on it. */
function ensureWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, '.write-probe');
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Rotate an oversized log once, then keep appending. */
function rotate(file) {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch { /* keep the existing file rather than losing it */ }
}

/**
 * Configure the logger's destinations.
 *
 * Whichever directories are writable receive the log. Called once at startup.
 *
 * @param {object} options
 * @param {string} [options.travelDir] Directory next to the program, if writable.
 * @param {string} [options.userDataDir] Electron's userData directory.
 * @returns {{files:string[], dirs:string[]}}
 */
export function initLogger({ travelDir, userDataDir } = {}) {
  logFiles = [];
  logDirs = [];
  for (const dir of [travelDir, userDataDir]) {
    if (!dir) continue;
    if (!ensureWritable(dir)) continue;
    const file = join(dir, 'app.log');
    rotate(file);
    logFiles.push(file);
    logDirs.push(dir);
  }
  return { files: [...logFiles], dirs: [...logDirs] };
}

/** Directories currently holding a log file. */
export function getLogDirs() {
  return [...logDirs];
}

/** The primary log file, or null when logging is unavailable. */
export function getLogFile() {
  return logFiles[0] ?? null;
}

/** Every log file currently written to. */
export function getLogFiles() {
  return [...logFiles];
}

/**
 * Single-directory initialiser, kept for callers that only have one location.
 * @param {string} dir
 */
export function initLoggerAt(dir) {
  return initLogger({ userDataDir: dir });
}

/**
 * Render any value compactly for a log line.
 * @param {unknown} value
 */
function render(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.code ? ` (code=${value.code})` : ''}`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Append one line to every destination.
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} tag Short subsystem tag, e.g. "startup".
 * @param {unknown[]} parts
 */
function write(level, tag, parts) {
  const line = `${stamp()} [${level}] [${tag}] ${parts.map(render).join(' ')}\n`;
  // Always echo to stdout/stderr too: useful when launched from a terminal.
  if (level === 'ERROR') process.stderr.write(line);
  else process.stdout.write(line);
  for (const file of logFiles) {
    try {
      appendFileSync(file, line, 'utf8');
    } catch { /* never let logging break the app */ }
  }
}

export const log = {
  info: (tag, ...parts) => write('INFO', tag, parts),
  warn: (tag, ...parts) => write('WARN', tag, parts),
  error: (tag, ...parts) => write('ERROR', tag, parts),
};

/**
 * Log an Error with everything that helps: name, message, errno, syscall, path, and
 * the top of its stack.
 * @param {string} tag
 * @param {string} context
 * @param {unknown} err
 */
export function logError(tag, context, err) {
  const e = err ?? {};
  write('ERROR', tag, [
    context,
    '|',
    `name=${e.name ?? 'n/a'}`,
    `message=${e.message ?? String(err)}`,
    e.code ? `code=${e.code}` : '',
    e.errno ? `errno=${e.errno}` : '',
    e.syscall ? `syscall=${e.syscall}` : '',
    e.path ? `path=${e.path}` : '',
  ].filter(Boolean));
  const stack = (e.stack ?? '').split('\n').slice(1, 5).join(' <- ').trim();
  if (stack) write('ERROR', tag, ['  at', stack]);
}
