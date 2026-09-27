/**
 * Embed a Windows application manifest into a PE executable.
 *
 * This is what makes the portable launcher always start elevated. Windows reads
 * the requested execution level from the manifest resource of the process image,
 * and for a portable Electron app that image is the launcher exe — the app inside
 * it cannot request elevation for itself. So the manifest must be written into
 * the exe's `.rsrc` section.
 *
 * The resource tree is rebuilt from the resources already present (icons,
 * version info, the existing manifest) plus the new manifest, so the exe keeps
 * its own resources and the change is limited to one resource.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  alignUp, peLayout, findSection, readResources, buildResourceSection,
} from './pe-resources.mjs';

export { readResources };

const RT_MANIFEST = 24;
const MANIFEST_ID = 1;

/**
 * Rewrite a PE image's resources with the same content they already carry.
 *
 * An identity operation, exposed so the embedder can be verified in isolation: if
 * re-embedding unchanged resources yields a file Windows refuses to launch, the
 * resource writer is at fault rather than the manifest text. Probes use this to
 * keep an executable runnable while still exercising the writer.
 *
 * @param {string} exePath
 * @param {{outPath?:string, log?:(msg:string)=>void}} [options]
 */
export function rebuildResources(exePath, options = {}) {
  const { entries } = readResources(readFileSync(exePath));
  const existing = entries.find((e) => e.type === RT_MANIFEST && e.id === MANIFEST_ID);
  return embedManifest(exePath, existing ? existing.data.toString('utf8') : '', options);
}

/**
 * Add or replace the RT_MANIFEST resource of a PE file.
 *
 * @param {string} exePath Source executable.
 * @param {string} manifestXml Manifest to embed.
 * @param {{outPath?:string, keepExistingResources?:boolean, log?:(msg:string)=>void}} [options]
 * @returns {{bytes:number, sectionSize:number, rawPointer:number, rsrcVa:number, resources:number}}
 */
export function embedManifest(exePath, manifestXml, options = {}) {
  const { outPath = exePath, keepExistingResources = true, log = () => {} } = options;

  const original = readFileSync(exePath);
  const layout = peLayout(original);
  const existing = readResources(original);

  const kept = keepExistingResources
    ? existing.entries.filter((e) => !(e.type === RT_MANIFEST && e.id === MANIFEST_ID))
    : [];
  kept.push({
    type: RT_MANIFEST,
    id: MANIFEST_ID,
    lang: 0x0409,
    codePage: 65001,
    data: Buffer.from(manifestXml, 'utf8'),
  });
  log(`resources: ${existing.entries.length} read, ${kept.length} written (manifest replaced)`);

  const { section, size } = buildResourceSection(kept);
  const alignedRawSize = alignUp(size, Math.max(layout.fileAlignment, 512));
  const padded = Buffer.alloc(alignedRawSize);
  section.copy(padded, 0);

  const existingRsrc = findSection(original, layout, '.rsrc');

  // The new section is ALWAYS appended at the end of the file, even when a
  // .rsrc already exists. The old .rsrc is not necessarily the last section
  // (electron.exe has .reloc after it), so overwriting it in place would clobber
  // whatever follows. Appending and repointing the header is safe and leaves
  // every other byte of the image untouched; the old section simply becomes
  // unreferenced slack.
  const newRawPointer = alignUp(original.length, Math.max(layout.fileAlignment, 512));

  // The section's virtual address can stay where it was when replacing, which
  // keeps SizeOfImage unchanged.
  let rsrcVa;
  if (existingRsrc) {
    rsrcVa = existingRsrc.virtualAddress;
  } else {
    let end = 0;
    for (let i = 0; i < layout.numberOfSections; i++) {
      const off = layout.sectionTable + i * 40;
      const virtualSize = original.readUInt32LE(off + 8);
      const virtualAddress = original.readUInt32LE(off + 12);
      end = Math.max(end, virtualAddress + alignUp(virtualSize, layout.sectionAlignment));
    }
    rsrcVa = alignUp(end, layout.sectionAlignment);
  }

  const output = Buffer.alloc(newRawPointer + alignedRawSize);
  original.copy(output, 0);
  padded.copy(output, newRawPointer);

  // Convert the section-relative blob offsets in every data entry into RVAs.
  patchDataEntryRvas(output, newRawPointer, rsrcVa, size);

  // Update the section header.
  let headerOffset;
  let sectionCount = layout.numberOfSections;
  if (existingRsrc) {
    headerOffset = existingRsrc.headerOffset;
  } else {
    headerOffset = layout.sectionTable + layout.numberOfSections * 40;
    const firstRaw = original.readUInt32LE(layout.sectionTable + 20);
    if (headerOffset + 40 > firstRaw) {
      throw new Error('no room in the PE headers for an extra section');
    }
    // Name: ".rsrc" padded to 8 bytes.
    output.write('.rsrc\0\0\0', headerOffset, 'latin1');
    output.writeUInt32LE(0, headerOffset + 24);   // PointerToRelocations
    output.writeUInt32LE(0, headerOffset + 28);   // PointerToLinenumbers
    output.writeUInt16LE(0, headerOffset + 32);   // NumberOfRelocations
    output.writeUInt16LE(0, headerOffset + 34);   // NumberOfLinenumbers
    output.writeUInt32LE(0x40000040, headerOffset + 36); // initialized data | read
    sectionCount += 1;
    output.writeUInt16LE(sectionCount, layout.pe + 6);
  }
  output.writeUInt32LE(size, headerOffset + 8);              // VirtualSize
  output.writeUInt32LE(rsrcVa, headerOffset + 12);           // VirtualAddress
  output.writeUInt32LE(alignedRawSize, headerOffset + 16);   // SizeOfRawData
  output.writeUInt32LE(newRawPointer, headerOffset + 20);    // PointerToRawData

  // SizeOfImage must cover the section.
  const required = rsrcVa + alignUp(size, layout.sectionAlignment);
  const current = output.readUInt32LE(layout.sizeOfImageOffset);
  if (required > current) output.writeUInt32LE(required, layout.sizeOfImageOffset);

  writeFileSync(outPath, output);
  log(`wrote ${outPath} (${output.length} bytes, .rsrc ${size} bytes at file offset ${newRawPointer}, VA 0x${rsrcVa.toString(16)})`);
  return { bytes: output.length, sectionSize: size, rawPointer: newRawPointer, rsrcVa, resources: kept.length };
}

/**
 * Rewrite each IMAGE_RESOURCE_DATA_ENTRY's OffsetToData from a section-relative
 * blob offset into an RVA.
 *
 * Works in the same section-relative convention as the reader: high bit set means
 * a subdirectory, clear means a data entry, and the section's raw pointer is added
 * only when touching the image bytes.
 *
 * @param {Buffer} image The output image.
 * @param {number} sectionRaw File offset of the section.
 * @param {number} rsrcVa Virtual address of the section.
 * @param {number} sectionSize Virtual size of the section.
 */
function patchDataEntryRvas(image, sectionRaw, rsrcVa, sectionSize) {
  const end = sectionRaw + sectionSize;
  const relative = (value) => (value & 0x80000000) ? (value & 0x7fffffff) : value;

  const walk = (rel, level) => {
    const header = sectionRaw + rel;
    if (header + 16 > end) return;
    const named = image.readUInt16LE(header + 12);
    const ids = image.readUInt16LE(header + 14);
    for (let i = 0; i < named + ids; i++) {
      const entryOffset = header + 16 + i * 8;
      if (entryOffset + 8 > end) return;
      const childRel = relative(image.readUInt32LE(entryOffset + 4));
      if (level < 2) {
        walk(childRel, level + 1);
      } else {
        // Leaf: the data entry's first dword becomes an RVA.
        const de = sectionRaw + childRel;
        if (de + 16 > end) continue;
        const blobRel = image.readUInt32LE(de);
        // Guard against an out-of-range value rather than letting a signed write
        // throw deep inside Buffer.
        const rva = rsrcVa + blobRel;
        if (rva <= 0xffffffff) image.writeUInt32LE(rva, de);
      }
    }
  };
  walk(0, 0);
}

/** Manifest that makes Windows always launch the exe elevated. */
export function requireAdministratorManifest(description = 'WeChat file cleaner') {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="WeChatFileCleaner" version="1.0.0.0" processorArchitecture="amd64"/>
  <description>${description}</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>
`;
}

/**
 * Read back the embedded RT_MANIFEST, for verification.
 * @param {string} exePath
 * @returns {string|null}
 */
export function readManifest(exePath) {
  const buf = readFileSync(exePath);
  const { entries } = readResources(buf);
  const manifest = entries.find((e) => e.type === RT_MANIFEST && e.id === MANIFEST_ID);
  return manifest ? manifest.data.toString('utf8').replace(/\0+$/, '') : null;
}
