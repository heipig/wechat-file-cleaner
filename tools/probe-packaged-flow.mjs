/**
 * Run the packaged application's own code, unattended.
 *
 * The shipped exe embeds `requireAdministrator`, so it cannot be launched from a
 * script without a UAC prompt. This copies the WHOLE bundle to a temp directory
 * and drops only the elevation requirement from the copied launcher's manifest, so
 * the exact code inside the shipped app.asar runs with no interaction. (Copying
 * the exe alone does not work: it then cannot find its sibling DLLs.)
 *
 * It then drives the full sequence — scan, folder-mode index, backup lookup, and
 * deleting copies of real read-only WeChat files — and reports whether the app
 * survived.
 *
 * The shipped bundle is never modified, and no real WeChat data is touched.
 *
 * Usage: node tools/probe-packaged-flow.mjs [--recycle]
 */
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { embedManifest, readManifest, requireAdministratorManifest } from './pe-manifest.mjs';
import { listPackage, extractFile } from '@electron/asar';
import { prepareSamples, sampleDirFrom } from './paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundle = join(root, 'dist', '微信收发文件清理器-win32-x64');
const shippedExe = join(bundle, '微信收发文件清理器.exe');
const asarPath = join(bundle, 'resources', 'app.asar');
// Real WeChat files are used only when the caller points at some; otherwise samples
// are synthesised, so the probe does not require one particular person's WeChat folder.
const SAMPLE_SOURCE = sampleDirFrom();
const useRecycle = process.argv.includes('--recycle');

const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);
let failures = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

if (!existsSync(shippedExe)) {
  log('!! packaged app not found; run: node tools/build-portable.mjs');
  process.exit(1);
}

log('=== packaged flow probe (unattended) ===');

// --- 1. confirm the shipped code carries the fixes --------------------------
log('\n--- shipped code ---');
function readFromAsar(rel) {
  const normalised = rel.replace(/\\/g, '/').replace(/^\//, '');
  for (const candidate of [normalised, `\\${normalised.replace(/\//g, '\\')}`, normalised.replace(/\//g, '\\')]) {
    try { return extractFile(asarPath, candidate).toString('utf8'); } catch { /* next */ }
  }
  return null;
}
/** Strip comments so a check can assert on code without tripping over prose. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}
const mainSrc = readFromAsar('src/main/main.js') ?? '';
const rendererSrc = readFromAsar('src/renderer/renderer.js') ?? '';
check('asar contains main.js', mainSrc.length > 0);
check('shipped main.js stores the window', /state\.window\s*=\s*win/.test(mainSrc));
check('shipped main.js refuses a parentless dialog', /if \(!parent\)[\s\S]{0,240}throw new Error/.test(mainSrc));
check('shipped main.js uses the Node cscript deletion engine',
  mainSrc.includes('setDeleteScriptDir') && !/deleteScriptPath/.test(codeOnly(mainSrc)));
// PowerShell is still used for ONE thing: relaunching elevated, which genuinely
// needs Start-Process -Verb RunAs. The deletion path must not touch it.
{
  const code = codeOnly(mainSrc);
  const deleteHandler = code.slice(code.indexOf("ipcMain.handle('files:delete'"), code.indexOf("ipcMain.handle('shell:openFolder'"));
  check('the deletion handler involves no PowerShell', !/powershell/i.test(deleteHandler),
    deleteHandler.length ? '' : 'could not isolate the handler');
  check('the deletion handler calls the Node engine', /doDelete/.test(deleteHandler));
}
check('shipped main.js reports its log destinations', mainSrc.includes('getLogFiles'));
check('shipped renderer logs delete clicks', rendererSrc.includes("rlog('delete'"));
check('shipped renderer can show the log in-app', rendererSrc.includes('readLogs'));
check('asar carries the full app', listPackage(asarPath).length >= 20, `${listPackage(asarPath).length} entries`);

// --- 2. clone the bundle, drop only the elevation requirement ---------------
log('\n--- cloning the bundle with elevation removed ---');
const cloneRoot = join(tmpdir(), `wxpkgclone-${process.pid}`);
cpSync(bundle, cloneRoot, { recursive: true });
const cloneExe = join(cloneRoot, '微信收发文件清理器.exe');
// Derive the non-elevated manifest from the real template rather than hand-writing
// a minimal one: Windows 11 rejects a manifest that omits requestedExecutionLevel
// or supportedOS with error 193, which once looked like a writer bug.
embedManifest(cloneExe, requireAdministratorManifest('WeChatFileCleanerProbe').replace(
  '<requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>',
  '<requestedExecutionLevel level="asInvoker" uiAccess="false"/>',
), {});
check('the clone no longer requires elevation', !(readManifest(cloneExe) ?? '').includes('requireAdministrator'));
check('the shipped exe still requires elevation', (readManifest(shippedExe) ?? '').includes('requireAdministrator'));
check('the clone kept its node runtime', existsSync(join(cloneRoot, 'resources', 'runtime', 'node.exe')));
check('the clone kept the unpacked helper',
  existsSync(join(cloneRoot, 'resources', 'helper', 'tools', 'mft-helper.mjs')));
check('the clone needs no unpacked delete script',
  !existsSync(join(cloneRoot, 'resources', 'helper', 'resources', 'delete-files.ps1')));

// --- 3. scratch scan folder with read-only samples --------------------------
// Real WeChat files are used only if the caller points at some; otherwise samples
// are synthesised with the same awkward properties (read-only, Chinese names,
// commas, parentheses), so the probe does not depend on one person's WeChat folder
// being present — and no account id ends up in the repository.
const work = join(tmpdir(), `wxpkgflow-${process.pid}`);
const scanRoot = join(work, 'msg', '2022-09');
mkdirSync(scanRoot, { recursive: true });
const prepared = await prepareSamples({ count: 10, destDir: scanRoot, sourceDir: SAMPLE_SOURCE });
const copies = prepared.files;
check(prepared.synthetic ? 'prepared read-only synthetic samples' : 'prepared read-only copies of real WeChat files',
  copies.length === 10,
  `${copies.length} files${prepared.synthetic ? ' (synthetic; pass a directory to use real files)' : ''}`);

const userData = join(process.env.APPDATA ?? tmpdir(), '微信收发文件清理器');
const settingsPath = join(userData, 'settings.json');
let previousSettings = null;
try { previousSettings = readFileSync(settingsPath, 'utf8'); } catch { /* none */ }
mkdirSync(userData, { recursive: true });
writeFileSync(settingsPath, JSON.stringify({
  lastFolder: join(work, 'msg'), recursive: true, graceDays: 2, volumes: [],
  verifyHash: false, fallbackFolders: [scanRoot],
  deleteMode: useRecycle ? 'recycle' : 'permanent',
  confirmDelete: false, confirmPermanent: false, language: 'zh',
  searchScope: 'folders', skipSmallFiles: 0,
}, null, 2), 'utf8');
const logFile = join(userData, 'logs', 'app.log');
const logSizeBefore = existsSync(logFile) ? readFileSync(logFile).length : 0;

// --- 4. run the clone and drive it ------------------------------------------
log('\n--- running the packaged app ---');
const PORT = 9455;
const child = spawn(cloneExe, [`--remote-debugging-port=${PORT}`], {
  cwd: cloneRoot, stdio: 'ignore', windowsHide: true,
});
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (err) { lastError = err; }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function attach(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed');
      return r.result.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}

let cdp = null;
try {
  cdp = await waitFor(() => attach(PORT), 90000, 'the packaged app to start');
  check('packaged app started', true);
  await waitFor(() => cdp.evaluate('Boolean(window.cleaner && document.getElementById("btn-scan"))'), 30000, 'the UI');
  check('packaged UI loaded', true);

  const scan = await cdp.evaluate(`(async () => {
    try {
      const s = await window.cleaner.startScan({ root: ${JSON.stringify(join(work, 'msg'))}, recursive: true, graceDays: 2 });
      return { files: s.files.length, error: null };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  check('packaged app scanned the folder', !scan.error && scan.files === 10, scan.error ?? `files=${scan.files}`);

  const index = await cdp.evaluate(`(async () => {
    try {
      const s = await window.cleaner.buildIndex({ volumes: [], scope: 'folders', folders: [${JSON.stringify(scanRoot)}] });
      return { files: s.files, error: null };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  check('packaged app built a folder index', !index.error && index.files === 10, index.error ?? `files=${index.files}`);

  const match = await cdp.evaluate(`(async () => {
    try {
      const r = await window.cleaner.startMatch({});
      return { total: r.summary.total, withBackup: r.summary.withBackup, error: null };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  check('packaged backup lookup completed', !match.error, match.error ?? `withBackup=${match.withBackup}/${match.total}`);

  log('\n--- deleting through the packaged app ---');
  const del = await cdp.evaluate(`(async () => {
    try {
      const r = await window.cleaner.deleteFiles({
        paths: ${JSON.stringify(copies)},
        mode: ${JSON.stringify(useRecycle ? 'recycle' : 'permanent')},
        confirmed: true,
      });
      return { ok: r.ok, succeeded: (r.succeeded ?? []).length, failed: (r.failed ?? []).length,
               detail: (r.failed ?? []).slice(0, 3).map(f => f.error) };
    } catch (e) { return { threw: String(e && e.message || e) }; }
  })()`).catch((e) => ({ threw: e.message }));

  await new Promise((r) => setTimeout(r, 3000));
  const alive = await cdp.evaluate('document.getElementById("btn-delete") !== null').catch(() => false);

  check('the delete call returned', !del.threw, del.threw ?? '');
  if (!del.threw) {
    check('packaged app deleted the files', del.succeeded === 10,
      `succeeded=${del.succeeded} failed=${del.failed} ${(del.detail ?? []).join(' | ')}`);
  }
  check('the app window survived', alive, alive ? '' : 'page gone');
  check('the process is still running', exited === null,
    exited ? `exited code=${exited.code} signal=${exited.signal}` : '');
  const left = copies.filter((p) => existsSync(p)).length;
  check('no copies remain', left === 0, `remaining=${left}`);

  log('\n--- log evidence ---');
  if (existsSync(logFile)) {
    const tail = readFileSync(logFile, 'utf8').slice(logSizeBefore);
    check('no crash recorded', !tail.includes('[crash]'));
    check('the deletion engine reported a result', tail.includes('deletion engine returned'));
    for (const line of tail.split('\n').filter((l) => /\[delete\]|\[crash\]/.test(l)).slice(-10)) log(`    ${line}`);
  }
} catch (err) {
  check('probe ran to completion', false, err.message);
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1500));
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(cloneRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { if (previousSettings !== null) writeFileSync(settingsPath, previousSettings, 'utf8'); } catch { /* ignore */ }
}

log('');
log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
