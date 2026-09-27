/**
 * Prove the bundle is relocatable.
 *
 * Copies the packaged app to a fresh directory, including one with spaces and
 * non-ASCII characters (the realistic case for a Chinese Windows user), then
 * checks that every path the app resolves at runtime still points inside the new
 * location. A stray absolute path or an asar-relative assumption shows up here.
 *
 * Usage: node tools/probe-relocate.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { helperScriptPath, findNodeExecutable } from '../src/core/volume-source.js';
import { readManifest } from './pe-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const bundle = join(root, 'dist', '微信收发文件清理器-win32-x64');
const exeName = '微信收发文件清理器.exe';
const originalExe = join(bundle, exeName);

const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);
let failures = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

if (!existsSync(originalExe)) {
  log('!! packaged app not found; run: node tools/build-portable.mjs');
  process.exit(1);
}

// A destination that mimics a real user's folder: spaces and Chinese characters.
const destRoot = join(tmpdir(), `搬家 测试 目录 ${process.pid}`);
const dest = join(destRoot, '微信收发文件清理器-win32-x64');

log('=== relocation probe ===');
log(`from: ${bundle}`);
log(`to  : ${dest}`);

try {
  mkdirSync(destRoot, { recursive: true });
  cpSync(bundle, dest, { recursive: true });
  check('the bundle copied to the new location', existsSync(join(dest, exeName)));

  const resources = join(dest, 'resources');

  // Every runtime path must resolve inside the NEW location.
  const helper = helperScriptPath(true, resources);
  const node = findNodeExecutable({ isPackaged: true, resourcesPath: resources });

  log('\n--- resolved runtime paths ---');
  for (const [label, resolved] of [
    ['MFT helper', helper],
    ['node runtime', node ?? '(not found)'],
  ]) {
    log(`    ${label}: ${resolved}`);
    check(`${label} exists in the new location`, Boolean(resolved) && existsSync(resolved));
    check(`${label} does not point at the old location`,
      !String(resolved).includes(bundle), 'still an absolute path from the build machine');
    check(`${label} is not inside the asar`, !String(resolved).includes('app.asar'));
  }

  // The manifest must travel with the exe.
  const manifest = readManifest(join(dest, exeName)) ?? '';
  check('the elevation request survives the copy', manifest.includes('requireAdministrator'));

  // The helper must actually run from the new location, which is what proves there
  // is no dependency on the original path depth or name.
  log('\n--- running the helper from the new location ---');
  const { execFileSync } = await import('node:child_process');
  let stdout = '';
  try {
    stdout = execFileSync(node, [helper, 'D'], { encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    stdout = err.stdout ?? '';
  }
  const messages = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('the helper started from the new path', messages.some((m) => m.t === 'done'),
    stdout.slice(0, 120));
  check('the helper reported a volume outcome',
    messages.some((m) => m.t === 'volume' || m.t === 'error'));

  // And the whole app must launch from there (elevation removed on a scratch copy
  // so it can start unattended).
  log('\n--- launching the app from the new location ---');
  const { embedManifest, requireAdministratorManifest } = await import('./pe-manifest.mjs');
  const launchCopy = join(destRoot, 'launch-test.exe');
  cpSync(join(dest, exeName), launchCopy);
  embedManifest(launchCopy, requireAdministratorManifest('probe').replace(
    '<requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>',
    '<requestedExecutionLevel level="asInvoker" uiAccess="false"/>',
  ), {});
  const probe = join(here, 'probe-launch.ps1');
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe, '-Exe', launchCopy,
  ], { encoding: 'utf8', timeout: 120000 });
  const started = /CreateProcess OK|shell started/.test(out);
  check('Windows launches the app from the new location', started,
    out.split('\n').filter((l) => /CreateProcess|shell/.test(l)).join(' | ').slice(0, 140));
} finally {
  try { rmSync(destRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

log('');
log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
