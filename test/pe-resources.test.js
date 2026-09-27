/**
 * Tests for the PE resource reader/writer and the manifest embedder.
 *
 * These run against the real Electron executable, because the structures involved
 * (a 6-type resource tree with 51 entries, version info, an icon group) are
 * exactly what a synthetic fixture would fail to reproduce faithfully. The
 * round-trip assertion — read, rebuild, read again, compare — is what catches
 * offset-convention and tree-shape bugs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, copyFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  peLayout, findSection, readResources, buildResourceSection,
} from '../tools/pe-resources.mjs';
import {
  embedManifest, readManifest, requireAdministratorManifest,
} from '../tools/pe-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ELECTRON = join(here, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
const hasElectron = existsSync(ELECTRON);

const tmpExe = (name) => join(process.env.TEMP ?? here, `wxclean-pe-${name}-${process.pid}.exe`);

test('peLayout and findSection locate the .rsrc section', { skip: !hasElectron }, () => {
  const buf = readFileSync(ELECTRON);
  const layout = peLayout(buf);
  assert.equal(layout.numberOfSections > 5, true);
  const rsrc = findSection(buf, layout, '.rsrc');
  assert.ok(rsrc, '.rsrc section should exist');
  assert.equal(rsrc.rawSize > 0, true);
  assert.equal(rsrc.rawSize <= buf.length, true);
});

test('readResources parses the real resource tree correctly', { skip: !hasElectron }, () => {
  const { entries } = readResources(readFileSync(ELECTRON));

  // Six distinct types: cursor/icon (1), icon (3), group cursor (12),
  // group icon (14), version (16), manifest (24).
  const types = [...new Set(entries.map((e) => e.type))].sort((a, b) => a - b);
  assert.deepEqual(types, [1, 3, 12, 14, 16, 24]);
  assert.equal(entries.length > 40, true, `expected many entries, got ${entries.length}`);

  // Every blob must be a real, in-range slice.
  const total = entries.reduce((sum, e) => sum + e.data.length, 0);
  assert.equal(total > 10000, true);
  for (const entry of entries) {
    assert.equal(entry.data.length > 0, true, `type ${entry.type} id ${entry.id} has no data`);
    assert.equal(typeof entry.id, 'number');
    assert.equal(typeof entry.lang, 'number');
  }

  // The manifest must be the XML document Windows already ships with Electron.
  const manifest = entries.find((e) => e.type === 24 && e.id === 1);
  assert.ok(manifest, 'Electron ships an RT_MANIFEST');
  const xml = manifest.data.toString('utf8');
  assert.match(xml, /<assembly/);
  assert.match(xml, /requestedExecutionLevel/);
});

test('buildResourceSection round-trips every entry through a rebuilt section', { skip: !hasElectron }, () => {
  // The decisive test: serialise the parsed tree, read it back, and require an
  // identical (type, id, lang, bytes) set. This is what catches the offset
  // convention mistakes that produce a plausible-looking but wrong tree.
  const original = readFileSync(ELECTRON);
  const layout = peLayout(original);
  const rsrc = findSection(original, layout, '.rsrc');
  const { entries } = readResources(original);

  const { section, size } = buildResourceSection(entries);

  // Wrap the section in a minimal PE the reader can consume: copy the original
  // image and point its .rsrc header at the rebuilt blob appended at the end.
  const rawPointer = original.length + ((512 - (original.length % 512)) % 512);
  const image = Buffer.alloc(rawPointer + section.length);
  original.copy(image, 0);
  section.copy(image, rawPointer);

  const headerOffset = rsrc.headerOffset;
  image.writeUInt32LE(size, headerOffset + 8);
  image.writeUInt32LE(rsrc.virtualAddress, headerOffset + 12);
  image.writeUInt32LE(section.length, headerOffset + 16);
  image.writeUInt32LE(rawPointer, headerOffset + 20);

  // Data entries hold section-relative offsets; convert them to RVAs the same
  // way the embedder does.
  const rel = (v) => ((v & 0x80000000) ? (v & 0x7fffffff) : v);
  const patch = (offset, level) => {
    const named = image.readUInt16LE(rawPointer + offset + 12);
    const ids = image.readUInt16LE(rawPointer + offset + 14);
    for (let i = 0; i < named + ids; i++) {
      const eo = rawPointer + offset + 16 + i * 8;
      const child = rel(image.readUInt32LE(eo + 4));
      if (level < 2) patch(child, level + 1);
      else {
        const de = rawPointer + child;
        image.writeUInt32LE(rsrc.virtualAddress + image.readUInt32LE(de), de);
      }
    }
  };
  patch(0, 0);

  const roundTripped = readResources(image).entries;
  assert.equal(roundTripped.length, entries.length, 'entry count must survive the round trip');

  const key = (e) => `${e.type}:${e.id}:${e.lang}:${e.data.length}`;
  const before = entries.map(key).sort();
  const after = roundTripped.map(key).sort();
  assert.deepEqual(after, before, 'the rebuilt tree must describe the same resources');

  // And the bytes must match, not just the shape.
  const byKey = new Map(roundTripped.map((e) => [key(e), e.data]));
  for (const entry of entries) {
    assert.equal(byKey.get(key(entry)).equals(entry.data), true, `bytes differ for ${key(entry)}`);
  }
});

test('embedManifest replaces the manifest and preserves every other resource', { skip: !hasElectron }, () => {
  const target = tmpExe('embed');
  try {
    copyFileSync(ELECTRON, target);
    const before = readResources(readFileSync(target)).entries;

    const info = embedManifest(target, requireAdministratorManifest('test'), {});
    assert.equal(info.bytes > statSync(ELECTRON).size, true, 'the file should grow by the new section');

    const after = readResources(readFileSync(target)).entries;
    const signature = (list) => list
      .filter((e) => e.type !== 24)
      .map((e) => `${e.type}:${e.id}:${e.lang}:${e.data.length}`)
      .sort()
      .join('|');

    assert.equal(signature(after), signature(before), 'non-manifest resources must be preserved');

    const manifest = after.find((e) => e.type === 24 && e.id === 1);
    assert.ok(manifest, 'a manifest must be present after embedding');
    const xml = manifest.data.toString('utf8');
    assert.match(xml, /requireAdministrator/);
    assert.match(xml, /requestedExecutionLevel/);
  } finally {
    try { unlinkSync(target); } catch { /* best effort */ }
  }
});

test('the embedded file is still a structurally valid PE image', { skip: !hasElectron }, () => {
  const target = tmpExe('valid');
  try {
    copyFileSync(ELECTRON, target);
    embedManifest(target, requireAdministratorManifest('test'), {});

    const buf = readFileSync(target);
    assert.equal(buf.readUInt16LE(0), 0x5a4d, 'MZ header');
    const pe = buf.readUInt32LE(0x3c);
    assert.equal(buf.readUInt32LE(pe), 0x00004550, 'PE signature');

    const layout = peLayout(buf);
    const rsrc = findSection(buf, layout, '.rsrc');
    assert.ok(rsrc, '.rsrc must still be findable');
    // The section's raw payload must lie inside the file.
    assert.equal(rsrc.rawPointer + rsrc.rawSize <= buf.length, true);
    // SizeOfImage must cover the section's virtual extent.
    const sizeOfImage = buf.readUInt32LE(layout.sizeOfImageOffset);
    assert.equal(sizeOfImage >= rsrc.virtualAddress + rsrc.virtualSize, true);
  } finally {
    try { unlinkSync(target); } catch { /* best effort */ }
  }
});

test('bytes before the appended section are left untouched', { skip: !hasElectron }, () => {
  const target = tmpExe('intact');
  try {
    copyFileSync(ELECTRON, target);
    const original = readFileSync(ELECTRON);
    embedManifest(target, requireAdministratorManifest('test'), {});
    const output = readFileSync(target);

    // Only the section header(s) and SizeOfImage may differ inside the original
    // extent; the .reloc payload and every other section must be byte-identical.
    const layout = peLayout(original);
    const rsrc = findSection(original, layout, '.rsrc');
    let diffs = 0;
    let firstDiff = -1;
    for (let i = 0; i < original.length; i++) {
      if (original[i] !== output[i]) {
        diffs++;
        if (firstDiff < 0) firstDiff = i;
      }
    }
    // Header fields touched: SizeOfRawData/PointerToRawData/VirtualSize of .rsrc.
    assert.equal(diffs <= 16, true, `expected only header fields to change, ${diffs} bytes differed (first at ${firstDiff})`);
    assert.equal(firstDiff >= rsrc.headerOffset, true, 'no bytes before the .rsrc header may change');
  } finally {
    try { unlinkSync(target); } catch { /* best effort */ }
  }
});

test('readManifest reads back exactly what was embedded', { skip: !hasElectron }, () => {
  const target = tmpExe('manifest');
  try {
    copyFileSync(ELECTRON, target);
    const xml = requireAdministratorManifest('round trip');
    embedManifest(target, xml, {});
    const back = readManifest(target);
    assert.ok(back, 'manifest should be readable');
    assert.equal(back.includes('round trip'), true);
    assert.equal(back.includes('requireAdministrator'), true);
  } finally {
    try { unlinkSync(target); } catch { /* best effort */ }
  }
});
