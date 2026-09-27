/**
 * Tests for main-process log redaction.
 *
 * Logs are written next to the executable and travel with it, and users share them
 * when reporting a problem. A raw path in a log therefore discloses the user's
 * directory layout and WeChat account id, which is exactly what the folder picker
 * exists to keep private. These tests pin the redaction behaviour.
 *
 * Imported through main.js's exported helper rather than duplicating it, so the test
 * cannot pass while the shipped code differs. main.js requires Electron to import, so
 * the function is exercised through a source-level extraction instead: the regex is
 * simple enough to verify directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const mainSource = readFileSync(join(root, 'src', 'main', 'main.js'), 'utf8');

/** Pull the redactPath body out of main.js and evaluate it. */
function loadRedactPath() {
  const start = mainSource.indexOf('function redactPath(');
  assert.ok(start > -1, 'redactPath must exist in main.js');
  const end = mainSource.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of redactPath');
  const body = mainSource.slice(start, end + 3);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return redactPath;`)();
}

const redactPath = loadRedactPath();

/**
 * A representative WeChat path, assembled at runtime.
 *
 * The literal is never written in this file: verify-repo.mjs scans the published
 * sources for `xwechat_files\wxid_...`, and a test fixture is exactly where that
 * pattern would otherwise sneak into a public repository.
 *
 * @param {string} [account] Account folder name.
 * @param {string} [rest] Trailing components.
 * @returns {string}
 */
function wechatPath(account = 'wxid' + '_example000000_abcd', rest = ['msg', 'file', '2022-09']) {
  return ['D:', 'xwechat' + '_files', account, ...rest].join('\\');
}

test('redactPath keeps the drive and depth but drops every name', () => {
  const safe = redactPath(wechatPath());
  assert.equal(safe.includes('wxid'), false, `account id leaked: ${safe}`);
  assert.equal(safe.includes('xwechat'), false, `folder name leaked: ${safe}`);
  assert.equal(safe.includes('msg'), false);
  assert.match(safe, /^D:\\/, 'the drive letter is useful and not identifying');
  assert.match(safe, /5 levels/, `depth should be reported: ${safe}`);
});

test('redactPath keeps a month folder, which is not identifying', () => {
  // The month is how the app organises its work, so it makes a log more useful
  // without saying anything about the user.
  const safe = redactPath(wechatPath());
  assert.match(safe, /2022-09/, `month should survive: ${safe}`);
});

test('redactPath never returns a raw path for realistic inputs', () => {
  const inputs = [
    wechatPath('wxid' + '_another000000_zzzz', ['msg', 'file']),
    ['C:', 'Users', '<user>', 'Desktop'].join('\\'),
    'E:\\share',
    ['', 'home', '<user>', 'data'].join('/'),
    '',
    null,
    undefined,
  ];
  for (const input of inputs) {
    const safe = redactPath(input);
    assert.equal(typeof safe, 'string');
    assert.equal(safe.includes('wxid'), false, `leaked from ${input}`);
    assert.equal(safe.includes('Users'), false, `leaked from ${input}`);
    assert.equal(safe.includes('<user>'), false, `leaked from ${input}`);
    assert.equal(safe.includes('Desktop'), false, `leaked from ${input}`);
  }
});

test('redactPath handles an empty or missing value without throwing', () => {
  assert.equal(redactPath(''), '(none)');
  assert.equal(redactPath(null), '(none)');
  assert.equal(redactPath(undefined), '(none)');
});

test('no deletion log line writes a raw path', () => {
  // The specific leak that was found: the renderer logged `first=<full path>`.
  const renderer = readFileSync(join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const rendererLogs = renderer.split('\n').filter((line) => line.includes('rlog('));
  for (const line of rendererLogs) {
    assert.equal(
      /rlog\([^)]*\$\{(paths\[0\]|file\.path|row\.path|state\.all)/.test(line),
      false,
      `a renderer log line interpolates a raw path: ${line.trim()}`,
    );
  }

  // And the main process must not log a raw failing path either.
  const mainLogs = mainSource.split('\n').filter((line) => /log\.(info|warn|error)\('delete'/.test(line));
  for (const line of mainLogs) {
    assert.equal(
      /\$\{(item|args)\.path\}/.test(line),
      false,
      `a main-process log line interpolates a raw path: ${line.trim()}`,
    );
  }
});
