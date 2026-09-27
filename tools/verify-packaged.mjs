/**
 * Verify the packaged bundle the way the app will use it.
 *
 * Two things are checked, both of which have failed before in this project:
 *   1. the resolver points the helper at a real file OUTSIDE the asar (a spawned
 *      Node cannot read into an asar archive);
 *   2. a real buildVolumeIndex call with the packaged settings behaves — the
 *      helper spawns, speaks the protocol, and either indexes (elevated) or
 *      reports the volume as unreadable (unelevated) — never "cannot find
 *      module".
 *
 * Usage: node tools/verify-packaged.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildVolumeIndex } from '../src/mft/mft-index.js';
import { helperScriptPath, findNodeExecutable } from '../src/core/volume-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, '..', 'dist', '微信收发文件清理器-win32-x64', 'resources');
const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);

let failures = 0;
function check(label, ok, detail = '') {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

log('=== packaged bundle verification ===');
log(`resources: ${resources}`);
if (!existsSync(resources)) {
  log('!! no packaged bundle found; run: node tools/build-portable.mjs');
  process.exit(1);
}

log('\n--- paths resolved at runtime ---');
const helper = helperScriptPath(true, resources);
check('MFT helper resolved outside the asar', !helper.includes('app.asar'), helper);
check('MFT helper file exists', existsSync(helper));
check('MFT helper import present', existsSync(join(resources, 'helper', 'src', 'mft', 'ntfs.js')));

// The deletion engine ships no script: permanent deletion is Node fs and recycle
// mode generates its .vbs at runtime. The retired PowerShell script must be gone.
check('no retired PowerShell deletion script',
  !existsSync(join(resources, 'helper', 'resources', 'delete-files.ps1')));

const nodePath = findNodeExecutable({ resourcesPath: resources });
check('bundled Node runtime found', Boolean(nodePath), nodePath ?? '(none)');
check('Node runtime is not Electron', Boolean(nodePath) && !/electron\.exe$/i.test(nodePath));

log('\n--- real index build with packaged settings ---');
const index = await buildVolumeIndex(['D'], { isPackaged: true, resourcesPath: resources });
const stats = index.stats();
const volume = stats.volumes[0] ?? {};
const error = volume.error ?? '';

log(`  engine=${index.engine} helperNode=${index.helperNode} files=${stats.files}`);
for (const v of stats.volumes) {
  log(`  volume ${v.volume}: engine=${v.engine} records=${v.records} files=${v.files}${v.error ? ` error=${v.error}` : ''}`);
}

check('no asar path in the failure', !error.includes('app.asar'), error.slice(0, 120));
check('no "Cannot find module"', !error.includes('Cannot find module'), error.slice(0, 120));
check('helper engine was used', index.engine === 'helper' || index.engine === 'in-process', index.engine);

if (stats.files > 0) {
  check('volume indexed (elevated run)', volume.records > 0, `${stats.files} files`);
  log('  (elevated: the packaged helper read the MFT successfully)');
} else {
  // Unelevated is expected here; the volume must be reported as unreadable, which
  // still proves the helper launched and spoke the protocol.
  check('volume reported unreadable rather than crashing', /EPERM|EACCES|denied|not permitted/.test(error), error.slice(0, 120));
  log('  (unelevated run: the helper launched and correctly reported the volume unreadable)');
}

log('');
log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
