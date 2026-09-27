# WeChat File Cleaner

**English** | [简体中文](README.md)

A Windows desktop tool for cleaning up the files WeChat sends and receives: it
classifies each file as **sent** or **received**, finds out whether a copy exists
elsewhere on your disk, and lets you delete in bulk.

> Status: works, but shaped by one specific machine's needs. Read
> [Requirements](#requirements) before expecting it to run as-is.

## Download

Grab `微信收发文件清理器-portable.zip` from the
[Releases page](https://github.com/heipig/wechat-file-cleaner/releases/latest), unzip anywhere, and run
`微信收发文件清理器.exe`. Everything is bundled (Electron, a Node runtime, the MFT
helper); no installation and no Node.js required. Administrator rights are needed
for the whole-volume index, as explained below.

The repository itself contains only source. Build output lives in Releases because
it is ~319 MB unpacked and would bloat every clone.

---

## The problem it solves

WeChat's PC client stores file transfers under month folders. Where depends on
which generation of WeChat you have:

| WeChat | Default root |
|---|---|
| **4.x** (current, `xwechat_files`) | `C:\Users\<user>\Documents\xwechat_files\` |
| **3.x** (older, `WeChat Files`) | `C:\Users\<user>\Documents\WeChat Files\` |

Inside that root, transfers are split per account and per month:

```
WeChat 4.x:
C:\Users\<user>\Documents\xwechat_files\<wxid>_<suffix>\
    msg\file\<yyyy-MM>\     documents, archives, installers, ...
    msg\video\<yyyy-MM>\    video
    msg\attach\<hash>\      images and voice, chunked by content hash

WeChat 3.x:
C:\Users\<user>\Documents\WeChat Files\<wxid>\
    FileStorage\File\<yyyy-MM>\
    FileStorage\Video\<yyyy-MM>\
    FileStorage\Image\<yyyy-MM>\
```

The storage location can be moved to another drive inside WeChat's settings
(3.x: 设置 → 文件管理; 4.x: possible since 4.0.1.17), which is why this tool does
not guess a path — it asks you to **pick the folder yourself**. Point it at
`msg\file` (or `FileStorage\File` on 3.x) and it recognises the `<yyyy-MM>` month
folders below.

Two things make manual cleanup painful:

1. **You cannot tell which files are still needed.** A file you *sent* almost
   certainly exists somewhere else on your disk (you sent your own copy). A file
   you *received* may or may not have been saved elsewhere — and if it was, you
   have forgotten where.
2. **Windows search is far too slow** to check "do I have another copy of these
   four thousand files" on a multi-terabyte disk.

This tool answers both in seconds.

## How it decides

**Sent vs received — by timestamps.** The month folder is named for when WeChat
handled the message, while each file keeps the modification time it had at that
moment. A file you received was written by WeChat then, so its mtime falls inside
that month. A file you sent already existed, so its mtime usually predates the
folder — sometimes by years. A file modified long before its month folder is
therefore very likely something you sent.

This is a heuristic and is treated as one: it is shown next to a *second,
independent* signal rather than being trusted alone.

**Backups — by whole-volume indexing.** The tool parses the NTFS Master File
Table to build an in-memory index of every file on the selected volumes
(name, size, mtime). That takes about two seconds for 300,000 files, because
reading the MFT avoids walking directories entirely. Candidate matches are then
confirmed by comparing content hashes, so a same-name same-size different-file
pair is never reported as a backup.

The two signals are shown in separate columns on purpose. The interesting row is
*"judged received, but a backup exists"* — that is a file you saved somewhere and
forgot about.

## Requirements

| | |
|---|---|
| OS | Windows 10/11, 64-bit |
| Filesystem | **NTFS** for the whole-volume index (no MFT on FAT32/exFAT) |
| Privileges | **Administrator**, to open `\\.\X:` and read the MFT |
| Node.js | Bundled in the portable build; not needed to run it |

**Without Administrator** the app still works: it switches to
"index only these folders" mode, where you point it at the places backups might
live. Slower to set up, no elevation needed.

## Building

```powershell
npm install
npm start                 # run in development
node tools/build-portable.mjs   # produce dist\微信收发文件清理器-win32-x64\
```

The build is fully offline: it assembles the bundle from the Electron copy
already in `node_modules` and packs the app with `@electron/asar`. It verifies
the result as it goes and fails rather than producing a broken bundle.

## What is interesting in here

Not the UI — the parts that had to be worked around.

### 1. Electron's bundled Node cannot read a raw volume

Reading the NTFS MFT means opening `\\.\D:` and reading raw bytes. That works in
Node 22+, but **not** in the Node 20 that Electron 33 embeds: the device opens,
`fstat` reports it as a directory, and every read fails with `EISDIR`. The same
code read a 232 MB MFT fine under `node.exe` 24.

So the app tries the in-process path first and, when that fails, delegates the
scan to a real `node.exe` child process (`tools/mft-helper.mjs`), which streams
records back as JSONL. `src/core/volume-source.js` owns that decision.

### 2. Child processes cannot read inside an asar

Node cannot read into `app.asar`, and Electron only patches its own `fs` layer —
a spawned interpreter sees a normal filesystem. So the MFT helper, its imports,
and a Node runtime all ship **outside** the archive under `resources/helper/` and
`resources/runtime/`. Handing a spawned process an `app.asar` path fails with
"cannot find module".

### 3. The launcher embeds its own elevation manifest

Windows reads the requested execution level from the manifest of the executable
the user double-clicks, and a portable Electron app's insides cannot request
elevation for it. `tools/pe-manifest.mjs` and `tools/pe-resources.mjs` are a small
PE resource editor that adds an `RT_MANIFEST` with `requireAdministrator` to the
packaged exe, rebuilding the resource section and repointing the section header.

Two traps are documented in the code: the fixed 512-byte update-sequence stride
(not the volume sector size), and the fact that a manifest omitting
`requestedExecutionLevel` or `supportedOS` makes Windows 11 reject the image with
error 193.

### 4. Deletion avoids PowerShell deliberately

The first implementation shelled out to a PowerShell script. That depends on
PowerShell being present, permitted by execution policy (Group Policy can override
`-ExecutionPolicy Bypass`), tolerated by the installed antivirus, and carrying the
`Microsoft.VisualBasic` assembly for Recycle Bin support — and each of those
varies between machines. One user's log showed a native confirmation dialog appear
and then never resolve, which looked exactly like the app crashing.

Deletion now uses:

- **Permanent:** Node's `fs.rmSync(..., { force: true })`, which also clears the
  read-only attribute every WeChat payload carries.
- **Recycle Bin:** a `.vbs` generated at runtime and run by `cscript.exe`, present
  on every Windows and subject to no execution policy.

Confirmation is drawn in-page rather than by `dialog.showMessageBox`, with a
time-boxed native fallback.

### 5. Everything is logged to a file that travels with the program

A packaged app has no console, and `%APPDATA%` is not somewhere a user can be
asked to look. Logs go to **both** `logs\app.log` next to the executable and the
userData directory, and the UI can display and reveal them.

## Verification

The project carries a lot of test infrastructure because its failure modes were
mostly invisible: "no backups found" and "the app vanished" look identical whether
the cause is a broken index, a missing helper, or a hung dialog.

```
npm test                          # 98 unit/integration tests
node tools/verify-asar.mjs        # the shipped archive contains the fixes
node tools/verify-packaged.mjs    # every runtime path resolves
node tools/verify-zip.mjs         # the distributable extracts and works
node tools/probe-packaged-flow.mjs   # drives the packaged app end to end
node tools/probe-relocate.mjs     # still works from a moved folder
node tools/probe-theme.cjs        # the theme switch really repaints
```

`probe-packaged-flow.mjs` is the interesting one: the shipped exe requires
elevation and cannot be spawned by a script, so it clones the bundle, rewrites
only the manifest to drop that requirement, and drives the real UI over the
DevTools protocol — clicking 删除 and answering the in-page confirmation without a
human present.

## Known limitations

- **The sent/received heuristic is a heuristic.** A file created and sent in the
  same month looks received. The backup column exists to compensate.
- **`$STANDARD_INFORMATION` timestamps are used**, not the `$FILE_NAME` copies
  served to Explorer's list view. On healthy systems these can differ by hours.
- **Files inside an `$ATTRIBUTE_LIST` extension record** may report a size from the
  `$FILE_NAME` cache rather than the unnamed `$DATA` attribute.
- **x64 only.** The bundled Node runtime and the manifest are amd64.
- **The index is in memory** and is rebuilt on each launch (~2-6 s).
- **The UI is Chinese.** The tool was written for a Chinese Windows user.

## License

[MIT](LICENSE).

The app bundles Electron and a Node.js runtime, which carry their own licenses;
`dist/` contains the relevant notices when built.
