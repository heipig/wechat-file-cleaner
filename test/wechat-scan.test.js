/**
 * Unit tests for the WeChat folder scanner and the sent/received heuristic.
 *
 * The classification rule is the backbone of the tool, so its boundaries are
 * pinned here explicitly — including the cases where the heuristic is known to
 * be weak, so a future change cannot silently widen them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMonthFolder,
  monthForPath,
  classifyByTime,
  kindOf,
  formatSize,
  formatTime,
  scanWeChatFolder,
  CLASSIFICATION,
} from '../src/core/wechat-scan.js';

const localMs = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

test('parseMonthFolder accepts the WeChat month folder formats', () => {
  const may = parseMonthFolder('2026-05');
  assert.equal(may.year, 2026);
  assert.equal(may.month, 5);
  assert.equal(may.label, '2026-05');
  assert.equal(may.start, localMs(2026, 5, 1));
  assert.equal(may.end, localMs(2026, 6, 1));

  // Single-digit month and the compact legacy form both resolve.
  assert.equal(parseMonthFolder('2026-5').label, '2026-05');
  assert.equal(parseMonthFolder('202609').label, '2026-09');
});

test('parseMonthFolder rejects non-month names', () => {
  for (const bad of ['file', 'attach', '2026', '2026-13', '2026-00', 'abc-05', '2026-05月', '', 'msg']) {
    assert.equal(parseMonthFolder(bad), null, `${bad} should not parse as a month`);
  }
});

test('monthForPath finds the enclosing month at any nesting depth', () => {
  assert.equal(monthForPath('D:\\wx\\msg\\file\\2022-09\\a.pdf').label, '2022-09');
  assert.equal(monthForPath('D:\\wx\\msg\\file\\2022-09\\sub\\deep\\a.pdf').label, '2022-09');
  assert.equal(monthForPath('D:\\wx\\msg\\video\\2022-09\\a.mp4').label, '2022-09');
  assert.equal(monthForPath('D:\\wx\\msg\\file\\a.pdf'), null);
});

test('classifyByTime calls a file inside its month received', () => {
  const month = parseMonthFolder('2022-09');
  const verdict = classifyByTime(localMs(2022, 9, 26, 16, 13), month);
  assert.equal(verdict.classification, CLASSIFICATION.RECEIVED);
});

test('classifyByTime calls a clearly older file sent', () => {
  const month = parseMonthFolder('2022-09');
  const verdict = classifyByTime(localMs(2022, 6, 29, 9, 42), month);
  assert.equal(verdict.classification, CLASSIFICATION.SENT);
  assert.ok(verdict.deltaDays <= -60, `expected a large negative delta, got ${verdict.deltaDays}`);
});

test('classifyByTime tolerates a couple of days of clock skew at the month edge', () => {
  const month = parseMonthFolder('2022-09');
  // One day before the month starts is still treated as received...
  assert.equal(classifyByTime(localMs(2022, 8, 31), month).classification, CLASSIFICATION.RECEIVED);
  // ...but well before that is not.
  assert.equal(classifyByTime(localMs(2022, 8, 20), month).classification, CLASSIFICATION.SENT);
  // The grace window is configurable.
  assert.equal(classifyByTime(localMs(2022, 8, 20), month, 30).classification, CLASSIFICATION.RECEIVED);
});

test('classifyByTime treats a later mtime as sent with an explanatory reason', () => {
  const month = parseMonthFolder('2022-09');
  const verdict = classifyByTime(localMs(2022, 11, 3), month);
  // Known weak case: a received file the user later edited also lands here.
  assert.equal(verdict.classification, CLASSIFICATION.SENT);
  assert.match(verdict.reason, /晚于/);
});

test('classifyByTime refuses to guess without a month or an mtime', () => {
  assert.equal(classifyByTime(localMs(2022, 9, 1), null).classification, CLASSIFICATION.UNKNOWN);
  assert.equal(classifyByTime(0, parseMonthFolder('2022-09')).classification, CLASSIFICATION.UNKNOWN);
});

test('the last day of a month is inside it, the first of the next is not', () => {
  const month = parseMonthFolder('2026-05');
  assert.equal(classifyByTime(localMs(2026, 5, 31, 23, 59), month).classification, CLASSIFICATION.RECEIVED);
  assert.equal(classifyByTime(localMs(2026, 6, 1, 0, 1), month).classification, CLASSIFICATION.SENT);
});

test('kindOf buckets extensions the way the UI filter expects', () => {
  assert.equal(kindOf('.pdf'), 'document');
  assert.equal(kindOf('.DWG'), 'other');       // CAD is its own world, not a document
  assert.equal(kindOf('.mp4'), 'video');
  assert.equal(kindOf('.JPG'), 'image');
  assert.equal(kindOf('.7z'), 'archive');
  assert.equal(kindOf('.silk'), 'audio');
  assert.equal(kindOf(''), 'other');
});

test('formatSize and formatTime render stable, readable text', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1024), '1.00 KB');
  assert.equal(formatSize(4003552), '3.82 MB');
  assert.equal(formatSize(-1), '-');
  assert.equal(formatTime(0), '-');
  assert.equal(formatTime(localMs(2022, 9, 26, 8, 13)), '2022-09-26 08:13');
});

test('scanWeChatFolder walks a real tree and classifies every file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wxs-'));
  try {
    const may = join(root, '2026-05');
    const nested = join(may, 'sub');
    await mkdir(nested, { recursive: true });

    const receivedFile = join(may, 'received.pdf');
    const sentFile = join(may, 'sent-project-plan.docx');
    const nestedFile = join(nested, 'nested.xlsx');
    await writeFile(receivedFile, 'r');
    await writeFile(sentFile, 's');
    await writeFile(nestedFile, 'n');

    // Received: written during the month folder's month.
    await utimes(receivedFile, new Date(localMs(2026, 5, 12, 10, 0)), new Date(localMs(2026, 5, 12, 10, 0)));
    // Sent: the local original predates the send month by months.
    await utimes(sentFile, new Date(localMs(2026, 2, 3, 9, 0)), new Date(localMs(2026, 2, 3, 9, 0)));
    // Nested files resolve to the same month as their enclosing folder.
    await utimes(nestedFile, new Date(localMs(2026, 5, 20, 9, 0)), new Date(localMs(2026, 5, 20, 9, 0)));

    const scan = await scanWeChatFolder(root, { recursive: true });
    assert.deepEqual(scan.months, ['2026-05']);
    assert.equal(scan.files.length, 3);

    const byName = Object.fromEntries(scan.files.map((f) => [f.name, f]));
    assert.equal(byName['received.pdf'].classification, CLASSIFICATION.RECEIVED);
    assert.equal(byName['sent-project-plan.docx'].classification, CLASSIFICATION.SENT);
    assert.equal(byName['nested.xlsx'].classification, CLASSIFICATION.RECEIVED);
    assert.equal(byName['nested.xlsx'].month, '2026-05');
    assert.equal(byName['nested.xlsx'].kind, 'document');

    // Only files judged sent are pre-ticked for review.
    assert.equal(scan.files.filter((f) => f.selected).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanWeChatFolder with recursive:false lists the chosen folder but nothing below it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wxs-'));
  try {
    const may = join(root, '2026-05');
    const nested = join(may, 'sub');
    await mkdir(nested, { recursive: true });
    await writeFile(join(may, 'top.pdf'), 'x');
    await writeFile(join(nested, 'deep.pdf'), 'y');

    // Pointing at a month folder: its own files must still be listed.
    const shallow = await scanWeChatFolder(may, { recursive: false });
    assert.deepEqual(shallow.files.map((f) => f.name), ['top.pdf']);

    // Pointing at the parent with recursion off: the month folder is skipped.
    const parentShallow = await scanWeChatFolder(root, { recursive: false });
    assert.equal(parentShallow.files.length, 0);

    // Recursion reaches everything.
    const deep = await scanWeChatFolder(root, { recursive: true });
    assert.deepEqual(deep.files.map((f) => f.name).sort(), ['deep.pdf', 'top.pdf']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanWeChatFolder returns nothing for a missing folder instead of throwing', async () => {
  const scan = await scanWeChatFolder('D:\\definitely-not-a-real-folder-xyz', { recursive: true });
  assert.equal(scan.files.length, 0);
  assert.deepEqual(scan.months, []);
});
