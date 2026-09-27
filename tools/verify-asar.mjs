/**
 * Inspect the packaged asar and confirm the shipped code contains the fixes and
 * the diagnostics added for them.
 *
 * Exists because package-level mistakes (a file excluded from the archive, or a
 * stale bundle) are invisible from source review and have broken this build more
 * than once.
 *
 * Usage: node tools/verify-asar.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listPackage, extractFile } from '@electron/asar';

const here = dirname(fileURLToPath(import.meta.url));
const asarPath = join(here, '..', 'dist', '微信收发文件清理器-win32-x64', 'resources', 'app.asar');

const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);
let failures = 0;
function check(label, ok, detail = '') {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

log('=== asar contents verification ===');
const entries = listPackage(asarPath);
log(`entries: ${entries.length}`);

/** Read a file out of the archive using the separator asar actually stores. */
function read(rel) {
  const candidates = [rel.replace(/\//g, '\\'), rel.replace(/\\/g, '/')];
  for (const candidate of candidates) {
    try { return extractFile(asarPath, candidate).toString('utf8'); } catch { /* try the next */ }
  }
  return null;
}

log('\n--- required files present ---');
for (const rel of [
  'src/main/main.js',
  'src/preload/preload.js',
  'src/renderer/renderer.js',
  'src/renderer/index.html',
  'src/core/volume-source.js',
  'src/core/delete.js',
  'src/core/logger.js',
  'src/mft/ntfs.js',
  'src/mft/mft-index.js',
  'tools/mft-helper.mjs',
  'package.json',
]) {
  check(rel, read(rel) !== null);
}

log('\n--- retired files are gone ---');
// The PowerShell deletion script was replaced by Node fs + a runtime-generated
// .vbs, so shipping it again would mean something still depends on PowerShell.
check('resources/delete-files.ps1 is not shipped', read('resources/delete-files.ps1') === null);

log('\n--- shipped code carries the fixes and diagnostics ---');
const main = read('src/main/main.js') ?? '';
const preload = read('src/preload/preload.js') ?? '';
const renderer = read('src/renderer/renderer.js') ?? '';
const volumeSource = read('src/core/volume-source.js') ?? '';
const mftIndex = read('src/mft/mft-index.js') ?? '';
const deleteModule = read('src/core/delete.js') ?? '';

/**
 * Strip line and block comments before scanning for a forbidden pattern, so a
 * comment that merely mentions "app.asar" or "PowerShell" (explaining why it must
 * not be used) does not trip the check.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
}

check('main wires up the deletion engine', main.includes('setDeleteScriptDir'));
check('main never builds an app.asar path', !/app\.asar/.test(codeOnly(main)));
check('main installs a crash handler', main.includes('uncaughtException'));
check('main logs delete requests at entry', main.includes("log.info('delete'"));
check('main forwards isPackaged into the index build', main.includes('isPackaged: app.isPackaged'));
check('main reports its log destinations', main.includes('getLogFiles'));
check('main serves the in-app log viewer', main.includes("'log:read'"));

// The deletion engine must be portable: Node fs plus Windows Script Host, with no
// PowerShell dependency, since PowerShell availability, execution policy, antivirus
// tolerance and the VB assembly all vary between machines.
check('delete.js uses Node fs for permanent deletion', /rmSync/.test(deleteModule));
check('delete.js uses cscript for recycle mode', /cscript/i.test(deleteModule));
check('delete.js has no PowerShell dependency', !/powershell/i.test(codeOnly(deleteModule)));
check('main accepts renderer log lines', main.includes('renderer:log'));

check('preload exposes the renderer logging channel', preload.includes('renderer:log'));
check('renderer logs delete clicks', renderer.includes("rlog('delete'"));
check('renderer captures window errors', renderer.includes("addEventListener('error'"));

check('volume-source keeps the helper outside the asar', !/app\.asar/.test(codeOnly(volumeSource)));
check('volume-source exposes deleteScriptPath', volumeSource.includes('deleteScriptPath'));
check('mft-index probes for a supported digest', mftIndex.includes('pickDigest'));

log('');
log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
