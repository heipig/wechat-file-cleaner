/**
 * Tests for the deletion module.
 *
 * These really do delete files on disk, because the failure modes that matter here
 * (read-only attributes, non-ASCII paths, a missing external interpreter) are
 * invisible to a mocked test. Recycle mode is used wherever the content matters, so
 * a failure leaves the file recoverable.
 *
 * The Recycle Bin path goes through Windows Script Host rather than PowerShell:
 * PowerShell depends on execution policy, antivirus tolerance and an extra .NET
 * assembly, each of which varies between machines — and a failure there presented
 * as the app disappearing on someone else's computer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deleteFiles,
  localizeDeleteError,
  localizeErrorType,
  parseReport,
  recycleScriptPath,
  RECYCLE_SCRIPT,
  setDeleteScriptDir,
} from '../src/core/delete.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const exists = async (p) => {
  try { await stat(p); return true; } catch { return false; }
};

test('the recycle helper is plain ASCII so no code page can corrupt it', () => {
  // The script is written as UTF-16LE with a BOM, but keeping its content ASCII
  // means an editor or a copy step cannot introduce a decoding surprise either.
  const offenders = [...RECYCLE_SCRIPT].filter((ch) => ch.charCodeAt(0) > 127);
  assert.deepEqual(offenders, [], `non-ASCII characters in the recycle script: ${offenders.slice(0, 5).join('')}`);
  assert.match(RECYCLE_SCRIPT, /Scripting\.FileSystemObject/);
  assert.match(RECYCLE_SCRIPT, /DeleteFile/);
});

test('the generated recycle script exists and is UTF-16LE with a BOM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxdel-'));
  try {
    setDeleteScriptDir(dir);
    const script = recycleScriptPath();
    assert.equal(existsSync(script), true, script);
    const bytes = readFileSync(script);
    // FF FE is the UTF-16LE BOM that Windows Script Host needs to read it as Unicode.
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xfe);
  } finally {
    setDeleteScriptDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseReport reads the WSH report format', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxdel-'));
  try {
    const report = join(dir, 'report.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(report, '\ufeffD=2\r\nF=C:\\a.pdf <= access denied|C:\\b.pdf <= not a file\r\n', 'utf16le');
    const parsed = parseReport(report);
    assert.equal(parsed.deleted, 2);
    assert.deepEqual(parsed.failures, ['C:\\a.pdf <= access denied', 'C:\\b.pdf <= not a file']);
    assert.equal(parseReport(join(dir, 'missing.txt')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('localizeDeleteError covers both Node and WSH vocabularies', () => {
  assert.match(localizeDeleteError('still-present-after-delete'), /仍然存在/);
  assert.match(localizeDeleteError('not a file'), /不是文件/);
  assert.match(localizeDeleteError('EPERM: operation not permitted'), /权限不足/);
  assert.match(localizeDeleteError('EBUSY: resource busy'), /占用/);
  assert.match(localizeDeleteError('EACCES: permission denied'), /拒绝/);
  assert.match(localizeDeleteError('ENOENT: no such file'), /不存在/);
  assert.equal(localizeDeleteError('some unique failure'), 'some unique failure');
  assert.equal(localizeDeleteError(''), '未知错误');
});

test('localizeErrorType explains both error vocabularies', () => {
  assert.match(localizeErrorType('EPERM'), /权限/);
  assert.match(localizeErrorType('EBUSY'), /占用/);
  assert.match(localizeErrorType('ENOENT'), /不存在/);
  assert.match(localizeErrorType('UnauthorizedAccessException'), /权限/);
  assert.equal(localizeErrorType('WeirdError'), 'WeirdError');
});

test('an empty request is a no-op and never spawns a process', async () => {
  const result = await deleteFiles({ paths: [], mode: 'recycle' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.succeeded, []);
});

test('permanent deletion really removes the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxdel-'));
  try {
    const target = join(dir, 'delete-me.txt');
    await writeFile(target, 'payload');
    const result = await deleteFiles({ paths: [target], mode: 'permanent', tempDir: dir });
    assert.deepEqual(result.failed, []);
    assert.equal(result.recycled, false);
    assert.equal(result.succeeded[0].note, 'deleted');
    assert.equal(await exists(target), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('permanent deletion removes a READ-ONLY file (the WeChat default)', async () => {
  // Every WeChat payload carries FILE_ATTRIBUTE_READONLY. A plain delete of such a
  // file fails with "access denied", which is the error reported from the field.
  const dir = await mkdtemp(join(tmpdir(), 'wxro-'));
  try {
    const target = join(dir, 'readonly-测试.pdf');
    await writeFile(target, 'payload');
    await chmod(target, 0o444);
    const st = await stat(target);
    assert.equal((st.mode & 0o200) === 0, true, 'file should be read-only before the test');

    const result = await deleteFiles({ paths: [target], mode: 'permanent', tempDir: dir });
    assert.deepEqual(result.failed, [], `permanent delete of a read-only file failed: ${JSON.stringify(result.failed)}`);
    assert.equal(result.succeeded[0].note, 'deleted');
    assert.equal(await exists(target), false, 'read-only file should be gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recycle mode removes a read-only file whose name is non-ASCII', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxdel-'));
  try {
    const target = join(dir, '镜湖站联络线三角区结构图(1).dwg');
    await writeFile(target, 'payload');
    await chmod(target, 0o444);

    const result = await deleteFiles({ paths: [target], mode: 'recycle', tempDir: dir });
    assert.deepEqual(result.failed, [], `recycle failed: ${JSON.stringify(result.failed)}`);
    assert.equal(result.recycled, true);
    assert.equal(result.succeeded.length, 1);
    assert.equal(result.succeeded[0].note, 'recycled');
    assert.equal(await exists(target), false, 'file should have been recycled');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing file is reported as already-missing or recycled, never as a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxdel-'));
  try {
    const target = join(dir, 'never-existed.txt');
    const permanent = await deleteFiles({ paths: [target], mode: 'permanent', tempDir: dir });
    assert.equal(permanent.ok, true);
    assert.equal(permanent.succeeded[0].note, 'already-missing');

    const recycled = await deleteFiles({ paths: [target], mode: 'recycle', tempDir: dir });
    assert.equal(recycled.ok, true, JSON.stringify(recycled));
    assert.equal(recycled.succeeded.length + recycled.failed.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a directory is refused in both modes and survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxdel-'));
  try {
    const folder = join(dir, 'a-folder');
    await mkdir(folder);

    const permanent = await deleteFiles({ paths: [folder], mode: 'permanent', tempDir: dir });
    assert.equal(permanent.ok, false, 'permanent mode must refuse a directory');
    assert.equal(await exists(folder), true, 'a directory must survive permanent mode');

    const recycled = await deleteFiles({ paths: [folder], mode: 'recycle', tempDir: dir });
    assert.equal(recycled.ok, false, 'recycle mode must refuse a directory');
    assert.equal(await exists(folder), true, 'a directory must survive recycle mode');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mixed batch of read-only and normal files all delete permanently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxmix-'));
  try {
    const ro1 = join(dir, '甲-只读.pdf');
    const ro2 = join(dir, '乙 只读.xlsx');
    const normal = join(dir, '丙-普通.txt');
    for (const f of [ro1, ro2, normal]) await writeFile(f, 'x');
    await chmod(ro1, 0o444);
    await chmod(ro2, 0o444);

    const result = await deleteFiles({ paths: [ro1, ro2, normal], mode: 'permanent', tempDir: dir });
    assert.deepEqual(result.failed, [], `failures: ${JSON.stringify(result.failed)}`);
    assert.equal(result.succeeded.length, 3);
    for (const f of [ro1, ro2, normal]) assert.equal(await exists(f), false, `${f} should be deleted`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mixed batch works in recycle mode too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxmix-'));
  try {
    const files = [join(dir, '一号 报告.pdf'), join(dir, '二号(修订).docx'), join(dir, 'three.txt')];
    for (const f of files) await writeFile(f, 'x');
    await chmod(files[0], 0o444);

    const result = await deleteFiles({ paths: files, mode: 'recycle', tempDir: dir });
    assert.deepEqual(result.failed, [], `failures: ${JSON.stringify(result.failed)}`);
    assert.equal(result.succeeded.length, 3);
    for (const f of files) assert.equal(await exists(f), false, `${f} should be recycled`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a batch reports per-path failures instead of failing as one lump', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxdel-'));
  try {
    const good = join(dir, 'good.txt');
    const bad = join(dir, 'subdir');
    await writeFile(good, 'x');
    await mkdir(bad);

    const result = await deleteFiles({ paths: [good, bad], mode: 'permanent', tempDir: dir });
    assert.equal(result.succeeded.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, bad);
    assert.equal(await exists(good), false);
    assert.equal(await exists(bad), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the module no longer depends on PowerShell', () => {
  // A regression guard for the portability bug: PowerShell availability, execution
  // policy, antivirus tolerance and the Microsoft.VisualBasic assembly all vary
  // between machines, and a failure there looked like the app crashing.
  const source = readFileSync(join(root, 'src', 'core', 'delete.js'), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  assert.equal(/powershell/i.test(code), false, 'delete.js must not invoke PowerShell');
  assert.equal(/Microsoft\.VisualBasic/.test(code), false, 'delete.js must not need the VB assembly');
  assert.match(code, /cscript/i, 'recycle mode should use Windows Script Host');
  assert.match(code, /rmSync/, 'permanent mode should use Node fs directly');
});
