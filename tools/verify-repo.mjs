/**
 * Preview what a git commit would actually include.
 *
 * Written because git is not installed on the development machine, and the risk of
 * a first push is specific and large: `node_modules/` is 294 MB and `dist/` is
 * 319 MB, so a missing or wrong .gitignore would either fail the push or poison the
 * repository. This applies the repository's ignore rules and reports the result,
 * including the total size, before any git command runs.
 *
 * Usage: node tools/verify-repo.mjs
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const out = (s) => process.stdout.write(`${s}\n`);

/** Directories that must never be committed, with the reason. */
const FORBIDDEN = [
  ['node_modules', 'installed dependencies (~294 MB)'],
  ['dist', 'build output with the Electron runtime (~319 MB)'],
  ['storage', 'runtime web-storage folder'],
];

/**
 * Parse the project's .gitignore into predicates.
 *
 * Only the subset of gitignore syntax this repository uses is supported: comments,
 * blank lines, directory patterns ending in `/`, `*` globs, and plain names. That is
 * enough to answer "would this be committed", and keeping it simple avoids claiming
 * more fidelity than it has.
 *
 * @param {string} text
 * @returns {Array<{pattern:RegExp, negate:boolean, dirOnly:boolean, source:string}>}
 */
export function parseIgnore(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const body = negate ? line.slice(1) : line;
    const dirOnly = body.endsWith('/');
    const cleaned = body.replace(/\/$/, '');
    // Translate the glob to a regex over a '/'-separated relative path.
    const escaped = cleaned
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*');
    const pattern = new RegExp(`^${escaped}$`);
    rules.push({ pattern, negate, dirOnly, source: line });
  }
  return rules;
}

/**
 * Would a path be ignored?
 * @param {string} rel Posix-style path relative to the repository root.
 * @param {boolean} isDir
 * @param {Array} rules
 */
export function isIgnored(rel, isDir, rules) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    // A pattern matches the path itself or any ancestor directory.
    const segments = rel.split('/');
    let matched = rule.pattern.test(rel);
    if (!matched) {
      for (let i = 1; i < segments.length && !matched; i++) {
        matched = rule.pattern.test(segments.slice(0, i).join('/'));
      }
    }
    if (matched) ignored = !rule.negate;
  }
  return ignored;
}

/** Walk the tree, honouring ignore rules, and collect the files that survive. */
function walk(dir, rules, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (isIgnored(rel, entry.isDirectory(), rules)) continue;
    if (entry.isDirectory()) walk(full, rules, acc);
    else if (entry.isFile()) {
      let size = 0;
      try { size = statSync(full).size; } catch { /* unreadable */ }
      acc.push({ path: rel, size });
    }
  }
}

const ignorePath = join(root, '.gitignore');
if (!existsSync(ignorePath)) {
  out('!! no .gitignore found; refusing to preview');
  process.exit(1);
}
const rules = parseIgnore(readFileSync(ignorePath, 'utf8'));

out('=== what a first commit would include ===');

let failures = 0;

// 1. The dangerous directories must be ignored.
out('\n--- forbidden directories ---');
for (const [name, reason] of FORBIDDEN) {
  if (!existsSync(join(root, name))) continue;
  const ignored = isIgnored(name, true, rules);
  out(`  ${ignored ? 'IGNORED' : 'INCLUDED'}  ${name}/  (${reason})`);
  if (!ignored) failures++;
}

// 2. Report what would be committed.
const included = [];
walk(root, rules, included);
const totalBytes = included.reduce((sum, f) => sum + f.size, 0);
out(`\n--- files that would be committed: ${included.length} (${(totalBytes / 1024).toFixed(1)} KB) ---`);
const byTop = new Map();
for (const file of included) {
  const top = file.path.includes('/') ? file.path.split('/')[0] : '(root)';
  const bucket = byTop.get(top) ?? { count: 0, bytes: 0 };
  bucket.count++;
  bucket.bytes += file.size;
  byTop.set(top, bucket);
}
for (const [top, bucket] of [...byTop.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  out(`  ${top.padEnd(18)} ${String(bucket.count).padStart(3)} files  ${(bucket.bytes / 1024).toFixed(1)} KB`);
}

// 3. The essentials must be present.
out('\n--- expected repository files ---');
for (const required of ['README.md', 'LICENSE', '.gitignore', '.gitattributes', 'package.json', 'package-lock.json']) {
  const present = included.some((f) => f.path === required);
  out(`  ${present ? 'PRESENT ' : 'MISSING '} ${required}`);
  if (!present) failures++;
}
for (const dir of ['src/', 'tools/', 'test/', 'resources/']) {
  const count = included.filter((f) => f.path.startsWith(dir)).length;
  out(`  ${count > 0 ? 'PRESENT ' : 'MISSING '} ${dir} (${count} files)`);
  if (!count) failures++;
}

// 4. Nothing enormous should be in there.
const largest = [...included].sort((a, b) => b.size - a.size).slice(0, 5);
out('\n--- largest files to be committed ---');
for (const file of largest) out(`  ${(file.size / 1024).toFixed(1).padStart(8)} KB  ${file.path}`);

const oversized = included.filter((f) => f.size > 5 * 1024 * 1024);
if (oversized.length) {
  out(`\n!! ${oversized.length} file(s) over 5 MB would be committed:`);
  for (const file of oversized) out(`   ${(file.size / 1048576).toFixed(1)} MB  ${file.path}`);
  failures++;
}

// 5. Debug debris should stay out.
const debris = included.filter((f) => /\.(log|json)$/.test(f.path) && /^(probe|tools)\//.test(f.path)
  && !/package(-lock)?\.json$/.test(f.path));
if (debris.length) {
  out(`\n!! ${debris.length} probe report/log file(s) would be committed:`);
  for (const file of debris.slice(0, 8)) out(`   ${file.path}`);
  failures++;
}

// 6. No private machine details. A public repository must not carry the author's
//    WeChat account id, home directory, or checkout layout — and it is easy to
//    introduce one by writing a real path into a probe.
out('\n--- private information scan ---');
const PRIVATE_PATTERNS = [
  // A real WeChat data folder: the account id only appears under this parent, which
  // is what makes it identifying rather than incidental. Matching the bare `wxid_`
  // prefix would flag documentation placeholders and test fixtures.
  [/xwechat_files[\\/]+wxid_[A-Za-z0-9]+_[A-Za-z0-9]+/i, "a real WeChat account folder"],
  [/C:\\Users\\[^\\\s"'<>|]+/i, "a user's home directory"],
  [/\/home\/[a-z0-9_-]{2,}/i, "a user's home directory"],
  [/\/Users\/[A-Za-z0-9._-]{2,}/, "a user's home directory"],
  [/D:\\DSHworker|E:\\AIprogram/i, 'a developer checkout path'],
];
// Scanned file types. Deliberately broad: a leaked path is just as harmful in a
// .txt note as in a .js file, and a `.txt` file is exactly how a scratch note of
// real paths ends up committed.
const TEXT_EXT = /\.(js|mjs|cjs|ts|html|css|json|md|txt|yml|yaml|ps1|bat|cmd|log|ini|cfg|xml|sh)$/i;
const TEXT_BASENAMES = /^(LICENSE|NOTICE|AUTHORS|Makefile|Dockerfile|\.gitignore|\.gitattributes)$/i;
let privateHits = 0;
for (const file of included) {
  const baseName = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (!TEXT_EXT.test(file.path) && !TEXT_BASENAMES.test(baseName)) continue;
  let text;
  try { text = readFileSync(join(root, file.path), 'utf8'); } catch { continue; }
  // Comments are NOT excluded here: a real path in a comment leaks just as well.
  for (const [pattern, description] of PRIVATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    privateHits++;
    out(`  !! ${file.path} contains ${description}: ${match[0]}`);
  }
}
if (privateHits === 0) out('  no WeChat ids, home directories or checkout paths found');
else failures += privateHits;

out('');
out(failures === 0
  ? `READY TO COMMIT — ${included.length} files, ${(totalBytes / 1024).toFixed(1)} KB`
  : `${failures} PROBLEM(S) FOUND`);
process.exit(failures === 0 ? 0 : 1);
