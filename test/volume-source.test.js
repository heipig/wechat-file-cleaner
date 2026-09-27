/**
 * Tests for the MFT helper plumbing, which is the part of the app most likely to
 * break silently in a packaged build.
 *
 * Two independent failures motivated these:
 *   1. Electron 33 bundles Node 20, whose fs layer opens `\\.\X:` as a directory
 *      and fails every read with EISDIR — so the app cannot read the MFT in
 *      process and must delegate to a real Node child process.
 *   2. Node cannot read into an asar archive, so if the helper (or a module it
 *      imports) is packaged inside the asar, the child process dies with
 *      "cannot find module" and indexing silently yields nothing.
 */
import * as mftIndex from '../src/mft/mft-index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  helperScriptPath, findNodeExecutable, canReadRawVolume, enumerateVolumes,
} from '../src/core/volume-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('helperScriptPath points outside the asar when packaged', () => {
  const packaged = helperScriptPath(true, 'C:\\app\\resources');
  // The repo layout is mirrored so the helper's relative imports resolve.
  assert.equal(packaged, join('C:\\app\\resources', 'helper', 'tools', 'mft-helper.mjs'));
  // The decisive property: never inside app.asar, which a child Node cannot read.
  assert.equal(packaged.includes('app.asar'), false);

  const dev = helperScriptPath(false, undefined);
  assert.equal(dev, join(root, 'tools', 'mft-helper.mjs'));
  assert.equal(existsSync(dev), true, 'the dev helper must exist');
});

test('findNodeExecutable finds a runtime and never returns Electron', () => {
  const found = findNodeExecutable({});
  assert.ok(found, 'a Node runtime should be discoverable in this environment');
  assert.equal(/electron\.exe$/i.test(found), false, 'Electron cannot read raw volumes');
  assert.equal(existsSync(found), true);
});

test('findNodeExecutable prefers a runtime bundled next to the app', () => {
  const resources = join(root, 'dist-test-resources');
  const runtimeDir = join(resources, 'runtime');
  try {
    mkdirSync(runtimeDir, { recursive: true });
    // A stand-in file is enough: the resolver only checks existence.
    const fake = join(runtimeDir, 'node.exe');
    copyFileSync(process.execPath, fake);
    const found = findNodeExecutable({ resourcesPath: resources });
    assert.equal(found, fake, 'a bundled runtime must win over PATH');
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});

test('canReadRawVolume reports a reason instead of throwing', () => {
  const result = canReadRawVolume('D');
  assert.equal(typeof result.ok, 'boolean');
  if (!result.ok) {
    assert.equal(typeof result.error, 'string');
    assert.equal(result.error.length > 0, true);
  }
});

test('enumerateVolumes reports a per-volume error rather than throwing when it cannot read', async () => {
  // Unelevated this must not throw: it must hand back a stats entry carrying the
  // reason, so the UI can say which drive failed and why.
  const seen = [];
  const result = await enumerateVolumes({
    volumes: ['D'],
    onVolumeRecords: (volume, records, meta) => seen.push({ volume, count: records.size, meta }),
    isPackaged: false,
  });
  assert.equal(Array.isArray(result.stats), true);
  assert.equal(result.stats.length, 1);
  const stat = result.stats[0];
  assert.equal(stat.volume, 'D');
  if (stat.error) {
    assert.equal(typeof stat.error, 'string');
    assert.equal(stat.error.length > 0, true);
    assert.equal(stat.records, 0);
  } else {
    // Elevated: the enumeration should have produced records to hand over.
    assert.equal(stat.records > 0, true);
    assert.equal(seen.length, 1);
  }
});

test('the helper script runs in a real Node process and speaks the JSONL protocol', () => {
  // Runs the helper unelevated, where it must still emit a well-formed stream: a
  // volume-level error plus the done line. This proves the protocol and the
  // script's imports work in a plain Node process, which is how the app runs it.
  const nodePath = findNodeExecutable({});
  assert.ok(nodePath, 'need a Node runtime for this test');
  const script = helperScriptPath(false, undefined);

  let stdout = '';
  try {
    stdout = execFileSync(nodePath, [script, 'D'], { encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    // A non-zero exit is acceptable; the output is what matters.
    stdout = err.stdout ?? '';
    if (!stdout) throw err;
  }

  const lines = stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length >= 2, true, `expected at least 2 JSONL lines, got: ${stdout.slice(0, 200)}`);

  const messages = lines.map((line) => JSON.parse(line));
  for (const msg of messages) assert.equal(typeof msg.t, 'string');

  const done = messages.find((m) => m.t === 'done');
  assert.ok(done, 'the helper must always terminate with a done message');

  const volume = messages.find((m) => m.t === 'volume');
  const error = messages.find((m) => m.t === 'error');
  // Exactly one of the two, depending on elevation.
  assert.equal(Boolean(volume) !== Boolean(error), true, 'a volume is either reported or errors');

  if (error) {
    assert.equal(error.volume, 'D');
    assert.equal(typeof error.message, 'string');
    assert.equal(error.message.length > 0, true);
  }
  if (volume) {
    assert.equal(typeof volume.records, 'number');
    const records = messages.filter((m) => m.t === 'rec');
    assert.equal(records.length > 0, true, 'an elevated run must emit records');
    for (const rec of records.slice(0, 50)) {
      assert.equal(typeof rec.r, 'number', 'record number');
      assert.equal(typeof rec.p, 'number', 'parent number');
      assert.equal(typeof rec.n, 'string', 'name');
      assert.equal(typeof rec.z, 'number', 'size');
      assert.equal(typeof rec.m, 'number', 'mtime');
    }
  }
});

test('the helper streams records that the app can resolve into paths', { skip: !existsSync(join(root, 'dist')) }, async () => {
  // When a packaged build exists, its unpacked helper must load in a plain Node
  // process. This is the check that catches "helper left inside the asar".
  const packagedHelper = join(root, 'dist', '微信收发文件清理器-win32-x64', 'resources', 'helper', 'mft-helper.mjs');
  if (!existsSync(packagedHelper)) return; // a build without the unpack step
  const nodePath = findNodeExecutable({});
  assert.ok(nodePath);
  let stdout = '';
  try {
    stdout = execFileSync(nodePath, [packagedHelper, 'D'], { encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    stdout = err.stdout ?? '';
  }
  const messages = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(messages.some((m) => m.t === 'done'), true, 'the packaged helper must run');
  assert.equal(
    messages.some((m) => m.t === 'volume' || m.t === 'error'),
    true,
    'the packaged helper must report a volume or an error',
  );
});

test('the app source never builds an asar path for the helper', () => {
  // A regression guard: an app.asar path handed to a spawned interpreter is a
  // hard failure ("cannot find module") that only shows up in a packaged build.
  const source = readFileSync(join(root, 'src', 'core', 'volume-source.js'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  assert.equal(
    /app\.asar/.test(code),
    false,
    'volume-source.js must not construct an app.asar path (child processes cannot read it)',
  );
});

test('buildVolumeIndex with packaged settings looks for the helper OUTSIDE the asar', { skip: !existsSync(join(root, 'dist')) }, async () => {
  // Regression: `isPackaged`/`resourcesPath` were dropped between the IPC handler
  // and the helper resolver, so a packaged build looked for the helper inside
  // app.asar and every volume failed with "cannot find module".
  //
  // ESM named imports cannot be swapped for a spy (the binding is immutable), so
  // this asserts on behaviour instead: run the real call against the real
  // packaged layout and check that the outcome never blames an asar path.
  const resources = join(root, 'dist', '微信收发文件清理器-win32-x64', 'resources');
  if (!existsSync(resources)) return;

  const index = await mftIndex.buildVolumeIndex(['D'], {
    isPackaged: true,
    resourcesPath: resources,
  });
  const stats = index.stats();
  assert.equal(stats.volumes.length, 1);
  const volume = stats.volumes[0];
  const error = volume.error ?? '';
  assert.equal(
    error.includes('app.asar'),
    false,
    `a packaged run must never reference an asar path, got: ${error}`,
  );
  assert.equal(
    error.includes('Cannot find module'),
    false,
    `the helper must resolve in the packaged layout, got: ${error}`,
  );
  if (volume.files === 0) {
    // Unelevated: the helper ran and the volume is simply unreadable.
    assert.equal(volume.engine, 'helper');
    assert.match(error, /EPERM|EACCES|denied|not permitted/, `unexpected packaged error: ${error}`);
  } else {
    assert.equal(volume.records > 0, true);
  }
});

test('the forwarding chain is present in the source of every link', () => {
  // The bug was a missing argument two calls up, so assert on the call sites too:
  // a unit test of the resolver alone could never have caught it.
  const indexPath = join(root, 'src', 'mft', 'mft-index.js');
  const indexSource = readFileSync(indexPath, 'utf8');
  assert.match(
    indexSource,
    /enumerateVolumes\(\{[\s\S]{0,400}isPackaged:\s*options\.isPackaged/,
    'buildVolumeIndex must forward isPackaged to enumerateVolumes',
  );
  assert.match(
    indexSource,
    /enumerateVolumes\(\{[\s\S]{0,400}resourcesPath:\s*options\.resourcesPath/,
    'buildVolumeIndex must forward resourcesPath to enumerateVolumes',
  );

  const mainSource = readFileSync(join(root, 'src', 'main', 'main.js'), 'utf8');
  assert.match(
    mainSource,
    /buildVolumeIndex\(driveList,\s*\{[\s\S]{0,400}isPackaged:\s*app\.isPackaged/,
    'the IPC handler must pass app.isPackaged into buildVolumeIndex',
  );
  assert.match(
    mainSource,
    /buildVolumeIndex\(driveList,\s*\{[\s\S]{0,400}resourcesPath:\s*process\.resourcesPath/,
    'the IPC handler must pass process.resourcesPath into buildVolumeIndex',
  );
});

test('the deletion engine needs nothing unpacked and no PowerShell', () => {
  // The deletion path used to be a PowerShell script that had to be unpacked next
  // to the app, because powershell.exe cannot read inside app.asar. It is now Node's
  // own fs for permanent deletion plus a runtime-generated .vbs for the Recycle Bin,
  // so there is no script to place and nothing PowerShell-specific to go wrong on a
  // machine with a different execution policy or antivirus.
  const deleteSource = readFileSync(join(root, 'src', 'core', 'delete.js'), 'utf8');
  assert.match(deleteSource, /rmSync/, 'permanent deletion should use Node fs');
  assert.match(deleteSource, /cscript/i, 'recycle mode should use Windows Script Host');
  assert.equal(
    /powershell/i.test(deleteSource.replace(/\/\*[\s\S]*?\*\//g, '')),
    false,
    'the deletion engine must not depend on PowerShell',
  );

  // And the module it replaced must be gone, so nothing can quietly keep using it.
  assert.equal(
    existsSync(join(root, 'resources', 'delete-files.ps1')),
    false,
    'the retired PowerShell deletion script should no longer be shipped',
  );
});

test('the app source never builds an asar path for a child process', () => {
  // The MFT helper is executed by a separate node.exe, which cannot read into an
  // asar archive. Comments are stripped first, since explaining why app.asar must be
  // avoided legitimately names it.
  const strip = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  for (const rel of [join('src', 'core', 'volume-source.js'), join('src', 'main', 'main.js')]) {
    const code = strip(readFileSync(join(root, rel), 'utf8'));
    assert.equal(
      /app\.asar/.test(code),
      false,
      `${rel} must not construct an app.asar path (a separate process cannot read it)`,
    );
  }
});

test('the main process stores the window and never opens a parentless modal', () => {
  // Regression for two failures caused by one omission — `state.window` was never
  // assigned:
  //   1. the delete confirmation opened as a PARENTLESS modal, which on Windows
  //      sits behind the app and looks exactly like a crash;
  //   2. every progress event was dropped, because the emitter returns early when
  //      there is no window.
  // Source-level because importing main.js requires Electron.
  const source = readFileSync(join(root, 'src', 'main', 'main.js'), 'utf8');

  assert.match(source, /state\.window\s*=\s*win/,
    'createWindow must store the created window in state.window');
  assert.match(source, /function parentWindowFor/,
    'the dialog parent must be resolvable from the IPC event');
  assert.match(source, /if \(!parent\)[\s\S]{0,240}throw new Error/,
    'a parentless confirmation dialog must be refused rather than shown');

  // Every showOpenDialog/showMessageBox must pass a parent explicitly. Checked per
  // line so a nested call in the argument list does not confuse the scan.
  const lines = source.split('\n');
  let dialogSites = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/dialog\.show(OpenDialog|MessageBox)\(/.test(lines[i])) continue;
    dialogSites++;
    const window = [lines[i], lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ');
    assert.equal(
      /parentWindowFor|parent[,\s)]/.test(window),
      true,
      `dialog call at line ${i + 1} has no parent window: ${lines[i].trim()}`,
    );
  }
  assert.equal(dialogSites >= 3, true, `expected the dialog call sites, found ${dialogSites}`);
});

test('deletion confirmation is drawn in-app, not by the OS', () => {
  // A native dialog.showMessageBox appeared but never resolved on one user's
  // machine: the log showed "showing confirmation" followed by two minutes of
  // silence and then a fresh app start. The app looked frozen or crashed when it was
  // really waiting on an invisible modal, so confirmation now happens in the page.
  const renderer = readFileSync(join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const html = readFileSync(join(root, 'src', 'renderer', 'index.html'), 'utf8');
  const main = readFileSync(join(root, 'src', 'main', 'main.js'), 'utf8');

  assert.match(html, /id="confirm-overlay"/, 'the page must carry its own confirmation modal');
  assert.match(html, /id="confirm-ok"/, 'the modal needs a confirm button');
  assert.match(renderer, /function confirmDelete/, 'the renderer must ask in-app');
  assert.match(renderer, /confirmDelete\(\{ count:/, 'the delete flow must use it');
  assert.match(renderer, /confirmed: true/, 'the renderer must tell the main process it confirmed');

  // The main process must honour that and skip its own prompt for BOTH modes. It
  // previously short-circuited only the recycle branch, so a permanent delete asked
  // twice — and the second prompt was the native one that hangs.
  const handler = main.slice(
    main.indexOf("ipcMain.handle('files:delete'"),
    main.indexOf("ipcMain.handle('shell:openFolder'"),
  );
  assert.match(handler, /confirmed !== true && confirmSetting/,
    'the native dialog must be skipped whenever the caller already confirmed');

  // And if it is ever used, it must be time-boxed so it cannot freeze the app.
  assert.match(handler, /Promise\.race\(/, 'the native dialog must be raced against a timeout');
  assert.match(handler, /timedOut/, 'a timed-out dialog must be reported as a cancellation');
});

test('the packaged layout, when present, has every runtime path in place', { skip: !existsSync(join(root, 'dist')) }, () => {
  // Mirrors what the resolvers compute for a packaged run: this is the exact check
  // whose absence let broken bundles ship twice.
  const resources = join(root, 'dist', '微信收发文件清理器-win32-x64', 'resources');
  if (!existsSync(resources)) return;

  const helper = helperScriptPath(true, resources);
  assert.equal(existsSync(helper), true, `packaged helper missing at ${helper}`);
  assert.equal(helper.includes('app.asar'), false);
  assert.equal(existsSync(join(resources, 'helper', 'src', 'mft', 'ntfs.js')), true);

  // The deletion engine ships no script: permanent deletion is Node fs and recycle
  // mode generates its .vbs at runtime. The retired PowerShell script must not be
  // present, so nothing can quietly keep using it.
  assert.equal(
    existsSync(join(resources, 'helper', 'resources', 'delete-files.ps1')),
    false,
    'the retired PowerShell deletion script should not be in the bundle',
  );

  assert.equal(existsSync(join(resources, 'runtime', 'node.exe')), true, 'bundled Node runtime missing');
});
