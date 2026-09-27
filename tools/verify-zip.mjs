/**
 * Verify the distributable zip is actually usable.
 *
 * Extracts it to a fresh directory with spaces and Chinese characters in the path
 * (the realistic case) and checks that the extracted bundle is complete, that the
 * elevation request survived compression, and that the app launches from there.
 *
 * Usage: node tools/verify-zip.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManifest } from './pe-manifest.mjs';
import { launchOutcome, inspectImage } from './verify-launch.mjs';
import { helperScriptPath, findNodeExecutable } from '../src/core/volume-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const zip = join(root, 'dist', '微信收发文件清理器-portable.zip');
const exeName = '微信收发文件清理器.exe';

const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);
let failures = 0;
const check = (label, ok, detail = '') => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

if (!existsSync(zip)) {
  log('!! zip not found; create it first');
  process.exit(1);
}
log('=== zip verification ===');
log(`zip: ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MB)`);

// Extract into a path a real user might use: spaces plus Chinese characters.
const destRoot = join(tmpdir(), `解压 测试 ${process.pid}`);
const dest = join(destRoot, '微信收发文件清理器-win32-x64');
try {
  mkdirSync(destRoot, { recursive: true });
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destRoot}' -Force`,
  ], { encoding: 'utf8', timeout: 600000 });
  check('archive extracted', r.status === 0, r.stderr?.slice(0, 160) ?? `status=${r.status}`);

  const exe = join(dest, exeName);
  check('the launcher is present', existsSync(exe));

  // Complete bundle: every file the app needs at runtime.
  const resources = join(dest, 'resources');
  check('app.asar present', existsSync(join(resources, 'app.asar')));
  check('Node runtime present', existsSync(join(resources, 'runtime', 'node.exe')));
  check('MFT helper present', existsSync(join(resources, 'helper', 'tools', 'mft-helper.mjs')));

  // Nothing may ship that is not part of the runtime. This check used to assert the
  // opposite — that an internal 部署指南.md was *present* — which is how a private
  // guide written for the author's own machine ended up inside a published zip.
  const electronDist = join(root, 'node_modules', 'electron', 'dist');
  if (existsSync(electronDist)) {
    const expected = new Set(readdirSync(electronDist));
    expected.delete('electron.exe');
    expected.add(exeName);
    const stray = readdirSync(dest).filter((name) => !expected.has(name));
    check('the bundle root carries nothing but the runtime', stray.length === 0, stray.join(', '));
  } else {
    log('  SKIP  bundle root whitelist (no node_modules/electron to compare against)');
  }
  // The deletion engine ships no script: permanent deletion is Node fs and recycle
  // mode generates its .vbs at runtime. The retired PowerShell script must be gone.
  check('no retired PowerShell deletion script',
    !existsSync(join(resources, 'helper', 'resources', 'delete-files.ps1')));

  // Runtime path resolution from the extracted location.
  const helper = helperScriptPath(true, resources);
  const node = findNodeExecutable({ isPackaged: true, resourcesPath: resources });
  check('helper resolves inside the extracted copy', helper.startsWith(dest) && existsSync(helper));
  check('Node runtime resolves inside the extracted copy', Boolean(node) && node.startsWith(dest));

  // Deletion must work from the extracted copy, both ways.
  const { deleteFiles } = await import('../src/core/delete.js');
  const probeDir = join(destRoot, 'delete-probe');
  mkdirSync(probeDir, { recursive: true });
  const permanentVictim = join(probeDir, '只读.txt');
  writeFileSync(permanentVictim, 'x', 'utf8');
  try { chmodSync(permanentVictim, 0o444); } catch { /* best effort */ }
  const permanent = await deleteFiles({ paths: [permanentVictim], mode: 'permanent', tempDir: probeDir });
  check('permanent deletion works from the extracted copy',
    permanent.ok && !existsSync(permanentVictim),
    `${permanent.ok} ${JSON.stringify(permanent.failed ?? [])}`);

  const recycleVictim = join(probeDir, '回收站(1).pdf');
  writeFileSync(recycleVictim, 'x', 'utf8');
  try { chmodSync(recycleVictim, 0o444); } catch { /* best effort */ }
  const recycled = await deleteFiles({ paths: [recycleVictim], mode: 'recycle', tempDir: probeDir });
  check('recycle deletion works from the extracted copy',
    recycled.ok && !existsSync(recycleVictim),
    `${recycled.ok} recycled=${recycled.recycled} ${JSON.stringify(recycled.failed ?? recycled.errors ?? [])}`);

  // The elevation request must survive compression.
  check('the launcher still requests elevation', (readManifest(exe) ?? '').includes('requireAdministrator'));

  // Helper actually runs from the extracted copy.
  let stdout = '';
  try {
    stdout = spawnSync(node, [helper, 'D'], { encoding: 'utf8', timeout: 180000 }).stdout ?? '';
  } catch (err) { stdout = err.stdout ?? ''; }
  const messages = stdout.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  check('the extracted helper runs', messages.some((m) => m.t === 'done'));
  check('the extracted helper reports a volume', messages.some((m) => m.t === 'volume' || m.t === 'error'));

  // The launcher is accepted by Windows (elevation removed on a scratch copy so it
  // can start without a prompt).
  const { cpSync } = await import('node:fs');
  const { embedManifest, requireAdministratorManifest } = await import('./pe-manifest.mjs');
  const launchCopy = join(destRoot, 'launch-check.exe');
  cpSync(exe, launchCopy);
  embedManifest(launchCopy, requireAdministratorManifest('probe').replace(
    '<requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>',
    '<requestedExecutionLevel level="asInvoker" uiAccess="false"/>',
  ), {});
  const probeOut = launchOutcome(launchCopy, { timeoutMs: 30000 });
  check('Windows launches the extracted launcher', probeOut.launched,
    `${probeOut.outcome}: ${probeOut.detail}`.slice(0, 140));
  const image = inspectImage(launchCopy);
  check('the extracted launcher is a structurally valid image', image.ok,
    image.problems.join('; ').slice(0, 140));

  // File count sanity: the folder should carry the whole runtime, not a stub.
  function countFiles(dir) {
    let n = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
      else n++;
    }
    return n;
  }
  const files = countFiles(dest);
  check('the archive carries a full bundle', files > 20, `${files} files`);
} finally {
  try { rmSync(destRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

log('');
log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
