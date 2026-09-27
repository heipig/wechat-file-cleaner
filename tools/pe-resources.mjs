/**
 * PE resource-directory reader and writer.
 *
 * Only what is needed to add or replace one RT_MANIFEST resource in a Windows
 * executable, which is how the portable launcher is made to require elevation:
 * Electron (and Windows) read the application manifest from the executable the
 * user double-clicks, so the manifest must live in that file's resources.
 *
 * Resource tree shape (all offsets are relative to the section start unless the
 * high bit is set, in which case they point at a subdirectory):
 *
 *   IMAGE_RESOURCE_DIRECTORY { Characteristics, TimeDateStamp, Major, Minor,
 *                              NumberOfNamedEntries, NumberOfIdEntries }
 *   IMAGE_RESOURCE_DIRECTORY_ENTRY { Name/Id, OffsetToData }
 *   IMAGE_RESOURCE_DATA_ENTRY { OffsetToData (an RVA), Size, CodePage, Reserved }
 *
 * Levels are: type -> name/id -> language -> data entry.
 */
import { readFileSync } from 'node:fs';

/** Align a value up to the next multiple of `to`. */
export const alignUp = (value, to) => value + ((to - (value % to)) % to);

/** Section table offset of the PE header. */
export function peLayout(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a PE file (missing MZ)');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('not a PE file (missing PE signature)');
  const numberOfSections = buf.readUInt16LE(pe + 6);
  const optionalHeaderSize = buf.readUInt16LE(pe + 20);
  return {
    pe,
    numberOfSections,
    optionalHeaderSize,
    sectionTable: pe + 24 + optionalHeaderSize,
    // First data directory entries live at the end of the optional header.
    sizeOfImageOffset: pe + 24 + 56,
    fileAlignment: buf.readUInt32LE(pe + 24 + 36),
    sectionAlignment: buf.readUInt32LE(pe + 24 + 32),
  };
}

/** Read one section header. */
export function readSection(buf, layout, index) {
  const off = layout.sectionTable + index * 40;
  return {
    index,
    headerOffset: off,
    name: buf.toString('latin1', off, off + 8).replace(/\0+$/, ''),
    virtualSize: buf.readUInt32LE(off + 8),
    virtualAddress: buf.readUInt32LE(off + 12),
    rawSize: buf.readUInt32LE(off + 16),
    rawPointer: buf.readUInt32LE(off + 20),
  };
}

/** Find a section by name, or null. */
export function findSection(buf, layout, name) {
  for (let i = 0; i < layout.numberOfSections; i++) {
    const section = readSection(buf, layout, i);
    if (section.name === name) return section;
  }
  return null;
}

/**
 * Read every resource entry in a PE image.
 *
 * Offset convention: a directory entry's OffsetToData is a SECTION-RELATIVE
 * offset either way — with the high bit set it points at a subdirectory, without
 * it at a data entry. Only the final file read adds the section's raw pointer.
 * Mixing the two conventions silently reads garbage, so this function keeps every
 * intermediate value section-relative.
 *
 * @param {Buffer} buf
 * @returns {{entries:Array<{type:number,id:number,lang:number,codePage:number,data:Buffer}>, section:object|null, layout:object}}
 */
export function readResources(buf) {
  const layout = peLayout(buf);
  const section = findSection(buf, layout, '.rsrc');
  if (!section) return { entries: [], section: null, layout };

  const base = section.rawPointer;
  const entries = [];

  /** Section-relative offset for a directory entry's OffsetToData. */
  const relative = (value) => (value & 0x80000000) ? (value & 0x7fffffff) : value;
  /** Absolute file offset of a section-relative offset. */
  const absolute = (rel) => base + rel;

  const walk = (rel, level, type, id) => {
    if (absolute(rel) + 16 > buf.length) return;
    const header = absolute(rel);
    const named = buf.readUInt16LE(header + 12);
    const idCount = buf.readUInt16LE(header + 14);
    for (let i = 0; i < named + idCount; i++) {
      const entryOffset = header + 16 + i * 8;
      if (entryOffset + 8 > buf.length) return;
      const nameOrId = buf.readUInt32LE(entryOffset);
      const childRel = relative(buf.readUInt32LE(entryOffset + 4));
      const childId = nameOrId & 0x7fffffff;

      if (level < 2) {
        walk(childRel, level + 1,
          level === 0 ? childId : type,
          level === 0 ? id : childId);
        continue;
      }

      // Level 3: the child is an IMAGE_RESOURCE_DATA_ENTRY.
      const de = absolute(childRel);
      if (de + 16 > buf.length) continue;
      const dataRva = buf.readUInt32LE(de);
      const size = buf.readUInt32LE(de + 4);
      const codePage = buf.readUInt32LE(de + 8);
      const fileOffset = dataRva - section.virtualAddress + base;
      if (fileOffset < 0 || size <= 0 || fileOffset + size > buf.length) continue;
      entries.push({
        type,
        id,
        lang: childId,
        codePage,
        data: Buffer.from(buf.subarray(fileOffset, fileOffset + size)),
      });
    }
  };

  walk(0, 0, null, null);
  return { entries, section, layout };
}

/** Serialise one IMAGE_RESOURCE_DIRECTORY (header plus entries). */
export function buildDirectory(entries) {
  const buf = Buffer.alloc(16 + entries.length * 8);
  buf.writeUInt16LE(0, 12);                 // NumberOfNamedEntries
  buf.writeUInt16LE(entries.length, 14);    // NumberOfIdEntries
  entries.forEach((entry, i) => {
    buf.writeUInt32LE(entry.id, 16 + i * 8);
    buf.writeUInt32LE(entry.offset, 16 + i * 8 + 4);
  });
  return buf;
}

/**
 * Serialise a complete `.rsrc` section from resource entries.
 *
 * Layout is: all type directories, then all id directories, then all language
 * directories, then all data entries, then the blobs. Working out every offset
 * up front keeps the writer free of back-patching except for the data-entry RVAs,
 * which depend on the section's virtual address and are fixed by `embedManifest`.
 *
 * @param {Array<{type:number,id:number,lang:number,codePage:number,data:Buffer}>} entries
 * @returns {{section:Buffer, size:number, dataEntryOffsets:number[]}}
 */
export function buildResourceSection(entries) {
  // Group type -> id -> [lang data].
  const byType = new Map();
  for (const entry of entries) {
    if (!byType.has(entry.type)) byType.set(entry.type, new Map());
    const byId = byType.get(entry.type);
    if (!byId.has(entry.id)) byId.set(entry.id, []);
    byId.get(entry.id).push(entry);
  }

  const types = [...byType.entries()].map(([type, byId]) => ({
    type,
    ids: [...byId.entries()].map(([id, langs]) => ({ id, langs })),
  }));

  const dirBytes = (count) => 16 + count * 8;
  const flatLangs = [];
  for (const t of types) for (const idDir of t.ids) for (const lang of idDir.langs) flatLangs.push(lang);

  // Pass 1: assign every directory and data-entry offset.
  //
  // Three directory levels are used: root (one entry per type), type (one entry
  // per id), and id (one entry per language). The id level's entries point
  // straight at data entries, so no fourth level is needed.
  let cursor = 0;
  const rootBytes = dirBytes(types.length);
  cursor += rootBytes;
  for (const t of types) { t.dirOffset = cursor; cursor += dirBytes(t.ids.length); }
  for (const t of types) {
    for (const idDir of t.ids) { idDir.dirOffset = cursor; cursor += dirBytes(idDir.langs.length); }
  }
  const dataEntryStart = cursor;
  for (const lang of flatLangs) { lang.dataEntryOffset = cursor; cursor += 16; }

  // Pass 2: blobs, 8-byte aligned relative to the section start.
  let blobCursor = alignUp(cursor, 8);
  for (const lang of flatLangs) {
    lang.blobOffset = blobCursor;
    blobCursor = alignUp(blobCursor + lang.data.length, 8);
  }

  const section = Buffer.alloc(blobCursor);

  // Pass 3: write the directories, one level at a time.
  //
  // Level 0 is the ROOT directory, which lives at offset 0 and has one entry per
  // resource TYPE pointing at that type's directory. Levels 1 and 2 (id, then
  // language) are the per-type directories. Conflating the root with the type
  // directories renumbers every type and shifts the whole tree.
  buildDirectory(types.map((t) => ({
    id: t.type,
    offset: 0x80000000 + t.dirOffset,
  }))).copy(section, 0);

  // Level 1: each type directory holds one entry per resource id.
  for (const t of types) {
    buildDirectory(t.ids.map((idDir) => ({
      id: idDir.id,
      offset: 0x80000000 + idDir.dirOffset,
    }))).copy(section, t.dirOffset);
  }

  // Level 2: each id directory holds one entry per language, pointing at a data
  // entry directly (no high bit).
  for (const t of types) {
    for (const idDir of t.ids) {
      buildDirectory(idDir.langs.map((lang) => ({
        id: lang.lang,
        offset: lang.dataEntryOffset,
      }))).copy(section, idDir.dirOffset);
    }
  }

  // Pass 4: data entries (the RVA field holds a section-relative blob offset
  // until embedManifest converts it) plus their blobs.
  for (const lang of flatLangs) {
    section.writeUInt32LE(lang.blobOffset, lang.dataEntryOffset);
    section.writeUInt32LE(lang.data.length, lang.dataEntryOffset + 4);
    section.writeUInt32LE(lang.codePage ?? 0, lang.dataEntryOffset + 8);
    section.writeUInt32LE(0, lang.dataEntryOffset + 12);
    lang.data.copy(section, lang.blobOffset);
  }

  return {
    section,
    size: blobCursor,
    dataEntryOffsets: flatLangs.map((l) => l.dataEntryOffset),
  };
}
