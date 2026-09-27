/**
 * Locate the project root from a tool script, without hardcoding the checkout path.
 *
 * Every verification script starts by finding the project. Writing the developer's
 * own absolute path there would leak the directory layout of a private machine into
 * a public repository, so the path is derived from the script's own location instead.
 *
 * Tools live one level below the project root, so the root is always the parent of
 * the directory containing this module.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The packaged bundle directory, if it has been built.
 * @param {string} [appName]
 * @returns {string}
 */
export function bundleDir(appName = '微信收发文件清理器-win32-x64') {
  return join(REPO_ROOT, 'dist', appName);
}

/** Default application executable name. */
export const APP_EXE_NAME = '微信收发文件清理器.exe';

/**
 * A directory of real WeChat files to test against, or null.
 *
 * Several probes want to exercise real characteristics: read-only files, Chinese
 * filenames, commas and parentheses. Pointing them at the developer's own WeChat
 * folder hardcoded a WeChat account id into the repository, so the location is now
 * supplied by the caller — via the first positional argument or the
 * `WECHAT_CLEANER_SAMPLE_DIR` environment variable — and a probe that needs it
 * reports what to pass instead of failing obscurely.
 *
 * @param {string[]} [argv]
 * @returns {string|null}
 */
export function sampleDirFrom(argv = process.argv.slice(2)) {
  const fromArgs = argv.find((a) => !a.startsWith('--'));
  if (fromArgs) return resolve(fromArgs);
  const fromEnv = process.env.WECHAT_CLEANER_SAMPLE_DIR;
  return fromEnv ? resolve(fromEnv) : null;
}

/**
 * Gather sample files from a directory, or synthesise equivalents when none is given.
 *
 * Synthetic samples reproduce the properties that matter for these tests — a
 * read-only attribute, non-ASCII names, commas, parentheses, a mix of extensions and
 * a mix of sizes — so a probe can run on any machine. That is not a substitute for
 * testing against real data, but it removes the need for one particular person's
 * WeChat folder to be present.
 *
 * @param {object} options
 * @param {number} options.count How many files to produce.
 * @param {string} options.destDir Where to write synthetic samples.
 * @param {string|null} [options.sourceDir] Real directory to copy from instead.
 * @returns {{files:string[], synthetic:boolean}}
 */
export async function prepareSamples({ count, destDir, sourceDir }) {
  const { chmodSync, copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');

  mkdirSync(destDir, { recursive: true });
  const files = [];

  if (sourceDir) {
    const entries = readdirSync(sourceDir)
      .map((name) => joinPath(sourceDir, name))
      .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } })
      .slice(0, count);
    for (const src of entries) {
      const dest = joinPath(destDir, src.slice(src.lastIndexOf('\\') + 1));
      copyFileSync(src, dest);
      try { chmodSync(dest, 0o444); } catch { /* best effort */ }
      files.push(dest);
    }
    return { files, synthetic: false };
  }

  // Names chosen to cover the awkward cases: non-ASCII, a comma, parentheses, a
  // space, and a long descriptive name.
  const names = [
    '一号线(12).pdf',
    '会议纪要 2022-09-29.docx',
    '某项目,概算书.xlsx',
    '设计说明-第十分册.7z',
    '0415 招标文件定稿.doc',
    '图号 BJM22-05-01-03-CS-GX-001.dwg',
    '附件2 说明.pdf',
    '清单(1)(1).xlsx',
    '计划表.xls',
    '归档资料.zip',
  ];
  for (let i = 0; i < Math.min(count, names.length); i++) {
    const dest = joinPath(destDir, names[i]);
    // Vary the size so the index and matcher see distinct entries.
    writeFileSync(dest, `synthetic sample ${i} `.repeat(40 + i * 37), 'utf8');
    try { chmodSync(dest, 0o444); } catch { /* best effort */ }
    files.push(dest);
  }
  return { files, synthetic: true };
}
