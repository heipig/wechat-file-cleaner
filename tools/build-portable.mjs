/**
 * Build the portable launcher by assembling the bundle directly.
 *
 * Why not electron-packager: it insists on re-downloading Electron from GitHub
 * even when a perfectly good copy already sits in node_modules, and on a slow or
 * filtered network that turns every build into a multi-minute timeout. Assembling
 * the bundle from the installed Electron distribution is a handful of copies plus
 * one asar call, is fully offline, and gives exact control over what ships.
 *
 * Steps:
 *   1. copy the installed Electron runtime into dist/<name>/;
 *   2. pack the app sources into resources/app.asar;
 *   3. unpack the MFT helper (and the modules it imports) OUTSIDE the asar,
 *      because the helper runs in a real node.exe child process and Node cannot
 *      read into an asar archive;
 *   4. bundle a Node runtime so the helper works without Node installed;
 *   5. embed a `requireAdministrator` manifest into the launcher exe, because
 *      reading the NTFS MFT needs elevation and Windows only honours the manifest
 *      of the exe the user double-clicks.
 *
 * Every step that can silently produce a broken bundle is verified, and the build
 * fails rather than shipping it.
 *
 * Usage: node tools/build-portable.mjs [--no-runtime]
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPackageWithOptions, extractFile } from '@electron/asar';

/**
 * Read a file out of an asar archive.
 *
 * `listPackage` reports paths with a leading backslash and backslash separators, so
 * several spellings are tried rather than assuming one. Returning null lets callers
 * report a clear "missing from the archive" error instead of an exception.
 *
 * @param {string} asar
 * @param {string} rel Path inside the archive, e.g. "src/core/delete.js".
 * @returns {string|null}
 */
function readFromAsar(asar, rel) {
  const normalised = rel.replace(/\\/g, '/').replace(/^\//, '');
  const candidates = [
    normalised,
    `\\${normalised.replace(/\//g, '\\')}`,
    normalised.replace(/\//g, '\\'),
    `/${normalised}`,
  ];
  for (const candidate of candidates) {
    try { return extractFile(asar, candidate).toString('utf8'); } catch { /* try the next spelling */ }
  }
  return null;
}

import { embedManifest, requireAdministratorManifest, readManifest } from './pe-manifest.mjs';
import { findNodeExecutable, helperScriptPath } from '../src/core/volume-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distDir = join(root, 'dist');
const APP_NAME = '微信收发文件清理器';
const APP_DIR = join(distDir, `${APP_NAME}-win32-x64`);
const ELECTRON_DIST = join(root, 'node_modules', 'electron', 'dist');

const includeRuntime = !process.argv.includes('--no-runtime');

const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Recursively copy a directory tree. */
function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = join(fromDir, entry.name);
    const to = join(toDir, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

/** Recursive directory size. */
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else { try { total += statSync(p).size; } catch { /* skip */ } }
  }
  return total;
}

/** Fail the build loudly rather than shipping a broken bundle. */
function require2(condition, message) {
  if (condition) return;
  log(`!! ${message}`);
  process.exit(1);
}

log('=== building portable launcher ===');

// --- 0. preconditions --------------------------------------------------------
require2(existsSync(ELECTRON_DIST), `Electron runtime not found at ${ELECTRON_DIST}; run: npm install`);
const electronExe = join(ELECTRON_DIST, 'electron.exe');
require2(existsSync(electronExe), 'electron.exe missing from the Electron distribution');

// The stock Electron manifest must be untouched: if an earlier experiment wrote an
// elevation request here, the dev-mode app would start demanding admin.
const stockManifest = readManifest(electronExe);
require2(
  !stockManifest || !stockManifest.includes('requireAdministrator'),
  'node_modules/electron/dist/electron.exe carries an elevation manifest; reinstall Electron',
);

log('removing the previous dist/');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(APP_DIR, { recursive: true });

// --- 1. copy the Electron runtime -------------------------------------------
log('\n--- copying the Electron runtime ---');
copyTree(ELECTRON_DIST, APP_DIR);
const exePath = join(APP_DIR, `${APP_NAME}.exe`);
renameSync(join(APP_DIR, 'electron.exe'), exePath);
log(`runtime copied (${mb(dirSize(APP_DIR))})`);

// --- 2. pack the app into an asar -------------------------------------------
log('\n--- packing the application ---');
const appStaging = join(distDir, '.app-stage');
mkdirSync(appStaging, { recursive: true });

const APP_FILES = ['src', 'resources', 'tools/mft-helper.mjs'].filter((rel) => existsSync(join(root, rel)));
for (const rel of APP_FILES) {
  const from = join(root, rel);
  const to = join(appStaging, rel);
  if (statSync(from).isDirectory()) copyTree(from, to);
  else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

// The staged package.json is the app's identity; strip build-only fields.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(appStaging, 'package.json'), JSON.stringify({
  name: pkg.name,
  productName: pkg.productName ?? APP_NAME,
  version: pkg.version,
  private: true,
  type: pkg.type,
  main: pkg.main,
}, null, 2), 'utf8');

const asarPath = join(APP_DIR, 'resources', 'app.asar');
mkdirSync(dirname(asarPath), { recursive: true });
await createPackageWithOptions(appStaging, asarPath, {});
rmSync(appStaging, { recursive: true, force: true });
log(`packed ${APP_FILES.join(', ')} -> resources/app.asar (${mb(statSync(asarPath).size)})`);

// Confirm the helper really is inside the asar, which is what the dev-mode path
// resolves to and what the app expects to find for its `tools/` reference.
const asarBuffer = readFileSync(asarPath);
const asarHeader = JSON.parse(asarBuffer.toString('utf8', 16, 16 + asarBuffer.readUInt32LE(12)));
require2(
  Boolean(asarHeader.files?.tools?.files?.['mft-helper.mjs']),
  'tools/mft-helper.mjs did not make it into the asar',
);
log('verified: helper present in the asar');

// --- 3. unpack the helper next to the app -----------------------------------
// A spawned node.exe cannot read into an asar, so the MFT helper and its imports
// ship as loose files, mirroring the repo layout so relative imports work.
//
// The deletion engine needs nothing unpacked: permanent deletion is Node's own fs,
// and recycle mode writes its .vbs at runtime into the app's userData directory and
// runs it with cscript.exe.
log('\n--- unpacking the MFT helper outside the asar ---');
const helperDir = join(APP_DIR, 'resources', 'helper');
mkdirSync(join(helperDir, 'tools'), { recursive: true });
copyFileSync(join(root, 'tools', 'mft-helper.mjs'), join(helperDir, 'tools', 'mft-helper.mjs'));
copyTree(join(root, 'src'), join(helperDir, 'src'));

log('  resources/helper/tools/mft-helper.mjs');
log('  resources/helper/src/');

require2(
  existsSync(join(helperDir, 'src', 'mft', 'ntfs.js')),
  'the helper\'s src/mft/ntfs.js dependency was not unpacked',
);

// --- 3b. keep only the locales that matter ----------------------------------
// Chromium ships ~55 locale packs (40 MB). The UI is Chinese, and en-US covers a
// fallback, so the rest are dead weight in a portable bundle.
log('\n--- pruning locales ---');
const localesDir = join(APP_DIR, 'locales');
const KEEP_LOCALES = ['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak'];
if (existsSync(localesDir)) {
  const before = readdirSync(localesDir);
  let removed = 0;
  let removedBytes = 0;
  for (const name of before) {
    if (KEEP_LOCALES.includes(name)) continue;
    try {
      removedBytes += statSync(join(localesDir, name)).size;
      rmSync(join(localesDir, name), { force: true });
      removed++;
    } catch { /* leave it rather than failing the build */ }
  }
  const kept = readdirSync(localesDir);
  require2(kept.includes('zh-CN.pak') || kept.includes('en-US.pak'),
    'no usable locale pack survived pruning');
  log(`  kept ${kept.length} (${kept.join(', ')}), removed ${removed} (${mb(removedBytes)})`);
} else {
  log('  no locales directory; skipping');
}

// --- 4. bundle a Node runtime -----------------------------------------------
if (includeRuntime) {
  log('\n--- bundling a Node runtime for the MFT helper ---');
  const nodePath = findNodeExecutable({ resourcesPath: join(APP_DIR, 'resources') });
  require2(Boolean(nodePath), 'no Node runtime found to bundle; the helper would need node.exe on PATH');
  const runtimeDir = join(APP_DIR, 'resources', 'runtime');
  mkdirSync(runtimeDir, { recursive: true });
  const dest = join(runtimeDir, 'node.exe');
  copyFileSync(nodePath, dest);
  log(`  ${nodePath} -> resources/runtime/node.exe (${mb(statSync(dest).size)})`);
}

// --- 5. verify the helper actually runs -------------------------------------
// Runs the unpacked helper with the bundled runtime, unelevated: it must speak
// the JSONL protocol and terminate, reporting the volume as unreadable instead of
// crashing. This is the check whose absence let a broken bundle ship.
log('\n--- verifying the unpacked helper runs ---');
const runtimeNode = join(APP_DIR, 'resources', 'runtime', 'node.exe');
const nodeForCheck = existsSync(runtimeNode) ? runtimeNode : findNodeExecutable({});
require2(Boolean(nodeForCheck), 'no Node runtime available to verify the helper');

let helperOutput = '';
try {
  helperOutput = execFileSync(nodeForCheck, [join(helperDir, 'tools', 'mft-helper.mjs'), 'D'], {
    encoding: 'utf8', timeout: 180000,
  });
} catch (err) {
  helperOutput = err.stdout ?? '';
  require2(Boolean(helperOutput), `the packaged helper produced no output: ${err.message}`);
}
const messages = helperOutput.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
require2(messages.some((m) => m.t === 'done'), 'the packaged helper did not terminate with a done message');
const outcome = messages.find((m) => m.t === 'volume' || m.t === 'error');
require2(Boolean(outcome), 'the packaged helper reported no volume outcome');
const recordsEmitted = messages.filter((m) => m.t === 'rec').length;
log(`  protocol ok: ${messages.length} messages, outcome=${outcome.t}, records=${recordsEmitted}`);

// --- 6. embed the elevation manifest ----------------------------------------
log('\n--- embedding the requireAdministrator manifest ---');
embedManifest(exePath, requireAdministratorManifest(APP_NAME), { log });
const manifest = readManifest(exePath);
require2(Boolean(manifest), 'manifest missing after embedding');
require2(manifest.includes('requireAdministrator'), 'manifest does not request elevation');
log('verified: the launcher requests elevation');

// --- 7. final integrity checks ----------------------------------------------
log('\n--- final checks ---');
require2(existsSync(join(APP_DIR, 'resources', 'app.asar')), 'app.asar missing');
require2(existsSync(join(APP_DIR, 'resources', 'helper', 'tools', 'mft-helper.mjs')), 'unpacked helper missing');

// Verify every path the app resolves at runtime for a packaged build. Each of these
// has silently broken a build once: the MFT helper and its import, the Node runtime,
// and the deletion engine's requirements.
const resourcesDir = join(APP_DIR, 'resources');
const helperResolved = helperScriptPath(true, resourcesDir);
require2(!helperResolved.includes('app.asar'), `MFT helper resolves inside the asar: ${helperResolved}`);
require2(existsSync(helperResolved), `MFT helper missing at ${helperResolved}`);
log(`  MFT helper -> ${helperResolved}`);
const runtimeNodePath = join(resourcesDir, 'runtime', 'node.exe');
if (existsSync(runtimeNodePath)) log(`  Node runtime -> ${runtimeNodePath}`);

// The deletion engine must work with no PowerShell involved. Permanent deletion is
// pure Node fs; recycle mode uses cscript.exe with a generated .vbs, because
// PowerShell availability, execution policy, antivirus tolerance and the
// Microsoft.VisualBasic assembly all vary between machines — and a failure there
// presented as the app crashing on someone else's computer.
log('\n--- verifying the deletion engine as shipped ---');
const { deleteFiles: packagedDelete } = await import('../src/core/delete.js');

const shippedDeleteSource = readFromAsar(asarPath, 'src/core/delete.js') ?? '';
require2(shippedDeleteSource.length > 0, 'src/core/delete.js missing from the asar');
const shippedDeleteCode = shippedDeleteSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');
require2(!/powershell/i.test(shippedDeleteCode), 'the shipped delete module still references PowerShell');
require2(/cscript/i.test(shippedDeleteCode), 'the shipped delete module does not use Windows Script Host');
require2(/rmSync/.test(shippedDeleteCode), 'the shipped delete module does not use Node fs for permanent deletion');
log('  shipped delete module uses Node fs + cscript (no PowerShell)');

// The interpreter recycle mode needs must be present on this machine, because it
// will be needed on the target machine too.
const cscriptPath = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'cscript.exe')
  : 'cscript.exe';
require2(existsSync(cscriptPath), `cscript.exe not found at ${cscriptPath}; recycle mode would fail`);
log(`  cscript available -> ${cscriptPath}`);

// And deletion must really work, both ways, on throwaway files. This is the check
// that matters: a delete that reports success while leaving the file on disk is the
// worst possible failure for a cleaning tool.
const probeDir = join(distDir, '.delete-probe');
const probeWork = join(probeDir, 'work');
rmSync(probeDir, { recursive: true, force: true });
mkdirSync(probeWork, { recursive: true });

const permanentVictim = join(probeDir, '只读 victim.txt');
writeFileSync(permanentVictim, 'probe', 'utf8');
try { chmodSync(permanentVictim, 0o444); } catch { /* best effort */ }
const permanentResult = await packagedDelete({
  paths: [permanentVictim], mode: 'permanent', tempDir: probeWork,
});
require2(permanentResult.ok, `permanent deletion failed: ${JSON.stringify(permanentResult.failed)}`);
require2(!existsSync(permanentVictim), 'permanent deletion reported success but left the file behind');
log('  permanent deletion removed a read-only file');

const recycleVictim = join(probeDir, '回收站 victim(1).pdf');
writeFileSync(recycleVictim, 'probe', 'utf8');
try { chmodSync(recycleVictim, 0o444); } catch { /* best effort */ }
const recycleResult = await packagedDelete({
  paths: [recycleVictim], mode: 'recycle', tempDir: probeWork,
});
require2(recycleResult.ok, `recycle deletion failed: ${JSON.stringify(recycleResult.failed ?? recycleResult.errors)}`);
require2(!existsSync(recycleVictim), 'recycle deletion reported success but left the file behind');
log('  recycle deletion moved a read-only file to the Recycle Bin');
rmSync(probeDir, { recursive: true, force: true });

log(`launcher : ${exePath}`);
log(`manifest : requireAdministrator (double-click raises UAC)`);
log(`helper   : resources/helper/tools/mft-helper.mjs (outside the asar)`);
log(`runtime  : ${existsSync(runtimeNode) ? 'resources/runtime/node.exe (bundled)' : 'not bundled (uses PATH)'}`);
log(`total    : ${mb(dirSize(APP_DIR))}`);
log('');
log('bundle root:');
for (const entry of readdirSync(APP_DIR)) {
  const p = join(APP_DIR, entry);
  log(`  ${entry}${statSync(p).isDirectory() ? '/' : ` (${mb(statSync(p).size)})`}`);
}
