/**
 * Tests for the "silent empty result" failure mode.
 *
 * The reported symptom was "backup files were not found even though I copied
 * them elsewhere". Those copies are matched correctly (see backup-repro), so the
 * defect has to be that matching ran against an empty index and cheerfully
 * reported "no backup" for every file. These tests pin that down: an empty index
 * must be *detected*, not treated as a legitimate result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VolumeIndex,
  describeIndexProblem,
  planIndexSource,
  buildDirectoryIndex,
  matchBackups,
  hashFile,
  pickDigest,
} from '../src/mft/mft-index.js';
import { scanWeChatFolder } from '../src/core/wechat-scan.js';
import { classifyVolumeOutcome } from '../src/core/volume-source.js';

test('classifyVolumeOutcome separates a real fault from an indexable-by-design drive', () => {
  // A drive with no NTFS master file table — a FAT32/exFAT USB stick, a phone, an
  // optical disc — is not a failure of the app. Reporting it as one made a healthy
  // run look broken, and a removable drive is commonly present on a machine the
  // bundle is copied to (one field log showed a G: removable drive erroring).
  assert.equal(classifyVolumeOutcome(undefined), 'indexed');
  assert.equal(classifyVolumeOutcome('E: is not NTFS (OEM id "MSDOS5.0")'), 'unsupported');
  assert.equal(classifyVolumeOutcome("EINVAL: invalid argument, read"), 'unsupported');
  assert.equal(classifyVolumeOutcome('EPERM: operation not permitted, open \'\\\\.\\D:\''), 'unreadable');
  assert.equal(classifyVolumeOutcome('EACCES: permission denied'), 'unreadable');
  assert.equal(classifyVolumeOutcome('some unexpected failure'), 'unreadable');
});

test('an all-unsupported drive selection explains itself instead of looking broken', () => {
  // Selecting only non-NTFS drives is a user mistake with a specific fix, so the
  // message must name it rather than blaming permissions or an empty index.
  const index = new VolumeIndex();
  index.volumeStats.set('G', {
    elapsedMs: 5, records: 0, files: 0, mftBytes: 0,
    error: 'EINVAL: invalid argument, read', status: 'unsupported',
  });
  const problem = describeIndexProblem(index);
  assert.ok(problem, 'an empty index is still a problem');
  assert.match(problem, /NTFS/);
  assert.match(problem, /只索引指定文件夹|NTFS 磁盘/);
});

test('an unsupported drive alongside a good one is not reported as a fault', () => {
  const index = new VolumeIndex();
  index.add({ path: 'D:\\a.pdf', dir: 'D:\\', name: 'a.pdf', size: 1, modifiedMs: 0, volume: 'D', fromMft: true });
  index.volumeStats.set('D', { elapsedMs: 10, records: 1, files: 1, mftBytes: 0, status: 'indexed' });
  index.volumeStats.set('G', {
    elapsedMs: 5, records: 0, files: 0, mftBytes: 0,
    error: 'EINVAL: invalid argument, read', status: 'unsupported',
  });
  // The index is usable, so there is no problem to report at all.
  assert.equal(describeIndexProblem(index), null);
});

test('planIndexSource reuses an existing non-empty index', () => {
  const plan = planIndexSource({ indexFiles: 1234, scope: 'mft', elevated: false });
  assert.equal(plan.action, 'reuse');
});

test('planIndexSource builds the MFT index only when elevated', () => {
  assert.equal(
    planIndexSource({ indexFiles: 0, scope: 'mft', volumes: ['D'], elevated: true }).action,
    'build-mft',
  );
  // Unelevated with no folders: impossible, and the reason must say why.
  const blocked = planIndexSource({ indexFiles: 0, scope: 'mft', volumes: ['D'], elevated: false });
  assert.equal(blocked.action, 'impossible');
  assert.match(blocked.reason, /管理员/);
});

test('planIndexSource falls back to folders when MFT is unusable but folders exist', () => {
  const plan = planIndexSource({
    indexFiles: 0, scope: 'mft', volumes: ['D'], elevated: false, folders: ['D:\\share'],
  });
  assert.equal(plan.action, 'switch-to-folders');
  assert.match(plan.note, /文件夹索引/);
});

test('planIndexSource refuses folder mode with no folders configured', () => {
  const plan = planIndexSource({ indexFiles: 0, scope: 'folders', folders: [], elevated: true });
  assert.equal(plan.action, 'impossible');
  assert.match(plan.reason, /没有选择任何文件夹/);
});

test('planIndexSource builds a folder index without elevation', () => {
  const plan = planIndexSource({
    indexFiles: 0, scope: 'folders', folders: ['D:\\share', 'E:\\bak'], elevated: false,
  });
  assert.equal(plan.action, 'build-folders');
  assert.match(plan.reason, /2 个文件夹/);
});

test('planIndexSource forces the folder path when asked to prefer folders', () => {
  // Even with a populated index and elevation, preferFolders wins.
  const plan = planIndexSource({
    indexFiles: 999, scope: 'mft', volumes: ['D'], elevated: true,
    folders: ['D:\\share'], preferFolders: true,
  });
  assert.equal(plan.action, 'build-folders');
});

test('planIndexSource requires at least one drive for the MFT path', () => {
  const plan = planIndexSource({ indexFiles: 0, scope: 'mft', volumes: [], elevated: true });
  assert.equal(plan.action, 'impossible');
  assert.match(plan.reason, /盘符/);
});

test('a missing index is reported as missing', () => {
  assert.match(describeIndexProblem(null), /尚未建立备份索引/);
  assert.match(describeIndexProblem(undefined), /尚未建立备份索引/);
});

test('an index that was never null but holds nothing is an error, not a result', () => {
  // This is the exact shape a failed build leaves behind: a real object with
  // fileCount 0, which passes a truthiness check.
  const empty = new VolumeIndex();
  assert.equal(!!empty, true, 'the object is truthy, which is why the guard missed it');
  assert.equal(empty.fileCount, 0);
  const problem = describeIndexProblem(empty);
  assert.ok(problem, 'an empty index must produce a problem description');
  assert.match(problem, /索引里没有任何文件/);
  assert.match(problem, /管理员/);
});

test('a failed volume surfaces its error rather than a generic message', () => {
  const index = new VolumeIndex();
  index.volumeStats.set('D', {
    elapsedMs: 12, records: 0, files: 0, mftBytes: 0, error: 'EACCES: permission denied',
  });
  const problem = describeIndexProblem(index);
  assert.match(problem, /D: 盘读取失败/);
  assert.match(problem, /EACCES/);
});

test('a usable index reports no problem', () => {
  const index = new VolumeIndex();
  index.add({ path: 'D:\\a.pdf', dir: 'D:\\', name: 'a.pdf', size: 10, modifiedMs: 0, volume: 'D', fromMft: true });
  assert.equal(describeIndexProblem(index), null);
});

test('building a folder index from no folders yields the empty index that the guard now rejects', async () => {
  const index = await buildDirectoryIndex([], {});
  assert.equal(index.fileCount, 0);
  assert.ok(describeIndexProblem(index), 'an empty folder list must not look like a good index');
});

test('matching against an empty index produces the exact misleading outcome that was reported', async () => {
  // Reproduces the user-visible bug end to end: files exist, copies exist, but
  // the index is empty, so every file is labelled "no backup".
  const root = await mkdtemp(join(tmpdir(), 'wxempty-'));
  try {
    const month = join(root, '2026-05');
    await mkdir(month, { recursive: true });
    const doc = join(month, 'report.pdf');
    await writeFile(doc, 'contents');

    const scan = await scanWeChatFolder(root, { recursive: true });
    assert.equal(scan.files.length, 1);

    const emptyIndex = await buildDirectoryIndex([], {});
    const result = await matchBackups(scan.files, emptyIndex, { verify: false, scanRoot: root });

    assert.equal(result.totalBackups, 0);
    assert.equal(scan.files[0].backupStatus, 'none');
    assert.equal(scan.files[0].backupCount, 0);
    // The matcher itself is behaving correctly — there is genuinely nothing in
    // the index. The bug was that nothing warned the user, which is why the
    // guard in the main process now refuses to run at all.
    assert.ok(describeIndexProblem(emptyIndex));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the same files DO match once the copies are inside the indexed scope', async () => {
  // The positive control for the bug report: with a correctly scoped index the
  // copies are found, so an empty result really does mean "wrong scope".
  const root = await mkdtemp(join(tmpdir(), 'wxfound-'));
  const copies = await mkdtemp(join(tmpdir(), 'wxcopies-'));
  try {
    const month = join(root, '2026-05');
    await mkdir(join(copies, 'nested'), { recursive: true });
    await mkdir(month, { recursive: true });
    const doc = join(month, '月报 2026-05.pdf');
    await writeFile(doc, 'the real contents');

    const scan = await scanWeChatFolder(root, { recursive: true });
    // Scope the index to the WeChat folder only: the copy is out of scope.
    const tooNarrow = await buildDirectoryIndex([month], {});
    await matchBackups(scan.files, tooNarrow, { verify: true, scanRoot: root });
    assert.equal(scan.files[0].backupCount, 0, 'a copy outside the index cannot be found');

    // Copy it out and index that location: now it must match.
    await writeFile(join(copies, 'nested', '月报 2026-05.pdf'), 'the real contents');
    const scoped = await buildDirectoryIndex([copies], {});
    await matchBackups(scan.files, scoped, { verify: true, scanRoot: root });
    assert.equal(scan.files[0].backupCount, 1);
    assert.equal(scan.files[0].backupStatus, 'confirmed');
    assert.match(scan.files[0].backups[0].path, /wxcopies-/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(copies, { recursive: true, force: true });
  }
});

test('a same-name same-size file with different contents is rejected by hash verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wxhash-'));
  const copies = await mkdtemp(join(tmpdir(), 'wxhashc-'));
  try {
    const month = join(root, '2026-05');
    await mkdir(month, { recursive: true });
    const doc = join(month, 'report.pdf');
    await writeFile(doc, 'AAAAAAAAAA');
    await writeFile(join(copies, 'report.pdf'), 'BBBBBBBBBB'); // same size, different bytes

    const scan = await scanWeChatFolder(root, { recursive: true });
    const index = await buildDirectoryIndex([copies], {});

    await matchBackups(scan.files, index, { verify: true, scanRoot: root });
    assert.equal(scan.files[0].backupCount, 0, 'content mismatch must not count as a backup');

    // Without verification the same pair is only a candidate, not a confirmation.
    const scan2 = await scanWeChatFolder(root, { recursive: true });
    await matchBackups(scan2.files, index, { verify: false, scanRoot: root });
    assert.equal(scan2.files[0].backupStatus, 'candidate');
    assert.equal(scan2.files[0].backupCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(copies, { recursive: true, force: true });
  }
});

test('pickDigest returns an algorithm this process can actually use', async () => {
  // Regression: hashFile hardcoded blake2b512, which Electron's bundled Node does
  // NOT support ("Digest method not supported"), so verify-mode matching failed in
  // the packaged app while working perfectly under a standalone Node 24.
  const digest = pickDigest();
  assert.equal(typeof digest, 'string');
  assert.equal(digest.length > 0, true);
  assert.equal(pickDigest(), digest, 'the choice must be stable');

  // Prove it really works rather than merely being returned.
  const { createHash } = await import('node:crypto');
  assert.doesNotThrow(() => createHash(digest).update('x').digest());
});

test('hashFile tags its result with the algorithm it used', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wxhash-'));
  try {
    const file = join(root, 'sample.bin');
    await writeFile(file, 'content');
    const result = await hashFile(file, 7);
    assert.equal(result.error, undefined);
    assert.equal(result.hash.startsWith(result.algorithm + ':'), true,
      'hash should be prefixed with its algorithm, got: ' + result.hash.slice(0, 24));
    assert.equal(result.algorithm, pickDigest());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hashes of identical content match, and of different content do not', async () => {
  // Guards the algorithm switch itself: whichever digest is chosen, equal bytes
  // must collide and different bytes must not.
  const root = await mkdtemp(join(tmpdir(), 'wxhash-'));
  try {
    const a = join(root, 'a.bin');
    const b = join(root, 'b.bin');
    const c = join(root, 'c.bin');
    await writeFile(a, 'the same bytes');
    await writeFile(b, 'the same bytes');
    await writeFile(c, 'different bytes!');
    const ha = await hashFile(a, 14);
    const hb = await hashFile(b, 14);
    const hc = await hashFile(c, 16);
    assert.equal(ha.hash, hb.hash, 'identical content must hash identically');
    assert.notEqual(ha.hash, hc.hash, 'different content must not collide');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verify-mode matching works end to end with whatever digest is available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wxvdig-'));
  const copies = await mkdtemp(join(tmpdir(), 'wxvdigc-'));
  try {
    const month = join(root, '2026-05');
    await mkdir(month, { recursive: true });
    const doc = join(month, '报告.pdf');
    await writeFile(doc, 'report contents');
    await writeFile(join(copies, '报告.pdf'), 'report contents');

    const scan = await scanWeChatFolder(root, { recursive: true });
    const index = await buildDirectoryIndex([copies], {});
    await matchBackups(scan.files, index, { verify: true, scanRoot: root });

    assert.equal(scan.files[0].backupStatus, 'confirmed');
    assert.equal(scan.files[0].backupCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(copies, { recursive: true, force: true });
  }
});