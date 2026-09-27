/**
 * Ask Windows whether an executable will actually launch.
 *
 * Written in Node rather than PowerShell so it stays usable on a machine with a
 * restrictive execution policy, and so the verification scripts have no shell
 * dependency at all.
 *
 * Two outcomes matter and are reported distinctly:
 *
 *   - the image LAUNCHES (spawn succeeded, or the process started and exited),
 *   - spawning was REFUSED with EACCES, which is what a `requireAdministrator`
 *     manifest produces for a non-elevated caller. That is not a defect: it means
 *     Windows read the manifest and honoured it.
 *
 * A corrupt image shows up as EFTYPE or ENOEXEC instead, which is a real failure.
 *
 * Usage: node tools/verify-launch.mjs <exe> [--timeout ms]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManifest } from './pe-manifest.mjs';
import { readResources, peLayout, findSection } from './pe-resources.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Launch an executable and classify the outcome.
 *
 * @param {string} exe
 * @param {{timeoutMs?:number, args?:string[]}} [options]
 * @returns {{launched:boolean, outcome:'launched'|'needs-elevation'|'invalid'|'missing', detail:string, code?:string}}
 */
export function launchOutcome(exe, options = {}) {
  const { timeoutMs = 20000, args = ['--version'] } = options;
  if (!existsSync(exe)) {
    return { launched: false, outcome: 'missing', detail: `no such file: ${exe}` };
  }

  const result = spawnSync(exe, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
  const err = result.error;

  if (!err) {
    // It ran. A GUI app that stayed open until the timeout is also a success.
    const detail = result.status === null && result.signal
      ? `started and was terminated (${result.signal})`
      : `exited with status ${result.status}`;
    return { launched: true, outcome: 'launched', detail };
  }

  const code = err.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      launched: true,
      outcome: 'needs-elevation',
      code,
      detail: 'Windows refused the start because the manifest requires elevation (expected for the launcher)',
    };
  }
  return { launched: false, outcome: 'invalid', code, detail: `${code}: ${err.message}` };
}

/**
 * Validate that a PE image is structurally sound and readable by the Windows
 * resource loader equivalent: the section table must be consistent and the manifest
 * resource must be enumerable.
 *
 * A resource rewrite that produced an unlaunchable image showed up as a manifest
 * that could not be read at all, so this is the cheap structural half of the check.
 *
 * @param {string} exe
 * @returns {{ok:boolean, problems:string[], manifestBytes:number|null, requestsElevation:boolean|null}}
 */
export function inspectImage(exe) {
  const problems = [];
  let manifestBytes = null;
  let requestsElevation = null;
  try {
    const buf = readFileSync(exe);
    const layout = peLayout(buf);
    const rsrc = findSection(buf, layout, '.rsrc');

    if (!rsrc) problems.push('no .rsrc section (the manifest cannot be read)');
    else {
      if (rsrc.rawPointer + rsrc.rawSize > buf.length) problems.push('.rsrc payload lies past end of file');
      const sizeOfImage = buf.readUInt32LE(layout.sizeOfImageOffset);
      if (sizeOfImage < rsrc.virtualAddress + rsrc.virtualSize) {
        problems.push(`SizeOfImage (${sizeOfImage}) does not cover .rsrc (${rsrc.virtualAddress} + ${rsrc.virtualSize})`);
      }
    }

    for (let i = 0; i < layout.numberOfSections; i++) {
      const off = layout.sectionTable + i * 40;
      const name = buf.toString('latin1', off, off + 8).replace(/\0+$/, '');
      const rawSize = buf.readUInt32LE(off + 16);
      const rawPointer = buf.readUInt32LE(off + 20);
      if (rawPointer + rawSize > buf.length) problems.push(`section ${name} lies past end of file`);
    }

    const { entries } = readResources(buf);
    const manifest = entries.find((e) => e.type === 24 && e.id === 1);
    if (manifest) {
      manifestBytes = manifest.data.length;
      requestsElevation = manifest.data.toString('utf8').includes('requireAdministrator');
    } else {
      problems.push('no RT_MANIFEST resource (Windows would apply defaults)');
    }
  } catch (err) {
    problems.push(`could not parse the image: ${err.message}`);
  }
  return { ok: problems.length === 0, problems, manifestBytes, requestsElevation };
}

/** Command-line entry point. */
function main() {
  const exe = process.argv[2];
  if (!exe) {
    process.stdout.write('usage: node tools/verify-launch.mjs <exe>\n');
    process.exit(2);
  }
  const timeoutArg = process.argv.indexOf('--timeout');
  const timeoutMs = timeoutArg > -1 ? Number(process.argv[timeoutArg + 1]) : 20000;

  const log = (s) => process.stdout.write(`${s}\n`);
  log(`exe    : ${exe}`);
  log(`bytes  : ${existsSync(exe) ? statSync(exe).size : '(missing)'}`);

  const image = inspectImage(exe);
  log('\n--- image structure ---');
  log(`  manifest bytes : ${image.manifestBytes ?? '(none)'}`);
  log(`  requests admin : ${image.requestsElevation ?? '(unknown)'}`);
  if (image.ok) log('  structure      : ok');
  else for (const problem of image.problems) log(`  PROBLEM        : ${problem}`);

  log('\n--- launch ---');
  const outcome = launchOutcome(exe, { timeoutMs });
  log(`  outcome: ${outcome.outcome} — ${outcome.detail}`);

  const ok = image.ok && outcome.launched;
  log('');
  log(ok ? 'RESULT OK' : 'RESULT FAILED');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/verify-launch.mjs')) {
  main();
}

void join;
void here;
