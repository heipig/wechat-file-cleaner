# WeChat File Cleaner

**English** | [简体中文](README.md)

Clean up the files WeChat for Windows has accumulated: it tells you which ones
**you sent** and which ones **still exist elsewhere on your disk**, then deletes
them in bulk to free the space back.

- Portable — unzip and run, no installation
- No Node.js, Python or .NET needed
- Works with WeChat 4.x (`xwechat_files`) and 3.x (`WeChat Files`)
- Fully offline: it never connects to the network and never uploads your files

> Status: it works, but it was written around one user's real situation. Read
> [Requirements](#requirements) first.

## The problem it solves

A file WeChat **received** was probably saved somewhere else by you at the time —
and you have long forgotten where. A file you **sent** already existed on your
PC, so WeChat's copy is pure duplication.

Telling those two cases apart by hand is hopeless, and Windows' built-in search is
far too slow to check thousands of files.

This tool does the whole thing in seconds.

## Download

1. Open the [Releases page](https://github.com/heipig/wechat-file-cleaner/releases/latest)
2. Download `wechat-file-cleaner-portable.zip` (~133 MB)
3. Unzip anywhere — Desktop, D:, a USB stick. **Non-ASCII characters and spaces in the path are fine.**
4. Run `微信收发文件清理器.exe`
5. Click **Yes** on the UAC prompt

> Why administrator rights? To build a whole-volume index in seconds the tool
> reads the NTFS Master File Table directly, which Windows treats as an
> administrative operation. You can also run it without elevation — see the
> [FAQ](#faq).

---

## Using it: three steps

The status line at the top of the window shows `① 选择微信文件夹`, `② 建立备份索引`
and `③ 查备份`. Follow those three markers and you cannot skip a step. Results are
only trustworthy once all three are done.

### Step 1 — Point it at your WeChat folder

Click 「浏览…」 (Browse) and select the folder that holds the transfers:

| Your WeChat | Folder to select |
|---|---|
| 4.x (current) | `C:\Users\<user>\Documents\xwechat_files\<wxid>_<suffix>\msg\file` |
| 3.x (older) | `C:\Users\<user>\Documents\WeChat Files\<wxid>\FileStorage\File` |

**Not sure where it is?** Open WeChat →「设置」→「文件管理」; it shows the storage
location and has an "open folder" button. If you moved the storage location to
another drive, look for the same `msg\file` folder there.

- 「包含子文件夹」 (include subfolders) is on by default and sweeps every month
  folder (`2024-01`, `2024-02`, …). **Leave it on.**
- Cleaning only videos? Point it at `msg\video` (3.x: `FileStorage\Video`) instead.

Then click **「开始扫描」** (Start scan). The list fills immediately with size,
modified time, month, and a first-pass sent/received guess.

### Step 2 — Build the backup index

This is how the tool learns what else is on your disks.

- **Default: whole volume (NTFS Master File Table).** Tick the drives you want,
  click 「建立全盘索引」. A few hundred thousand files take about 2–6 seconds.
- Only NTFS volumes can be indexed this way; FAT32 / exFAT volumes are skipped
  automatically and nothing breaks.

### Step 3 — Find the backups

Click **「查备份」**. The tool first narrows candidates by name + size, then
confirms each one by **content hash**, so a same-name same-size different file is
never mistaken for a backup.

When it finishes, the 备份 column says whether a copy exists and the 备份位置
column tells you exactly where it is.

---

## Reading the results

| Column | Meaning |
|---|---|
| 文件名 / 大小 / 修改时间 / 月份 | The file itself; 月份 is the `2024-01` folder it sits in |
| 类型 | document / image / video / audio / archive / executable / other |
| 收发判定 | **发送件** (sent — mtime clearly predates its month folder), **接收件** (received), or unknown |
| 备份 | **有备份** (a verified copy exists), **无备份**, **未查** |
| 备份位置 | Where the other copy is; click the cell for the full path |

**The rows worth deleting are the ones judged 接收件 with 备份 = 有备份** — you saved
that file somewhere else back then, so WeChat's copy is redundant.

Filtering and sorting:

- Top row switches between 「全部文件 / 仅有备份 / 仅发送件 / 仅接收件 / 未查备份」
- The filename box filters as you type
- Also filter by type, month, and size (larger than N MB)
- Click a column header to sort

Selection: **Shift** for a range, **Ctrl** to pick scattered rows — same as
Explorer. There are also `全选`, `反选`, `选中有备份` and `选中无备份` shortcuts, and
the bottom left shows how many files and how many bytes you have selected.

## Deleting

Pick a mode on the right, then click **「删除选中」**:

- **移到回收站** (Recycle Bin, default) — recoverable if you change your mind
- **永久删除** (permanent) — skips the Recycle Bin, frees the space immediately,
  **cannot be undone**

A confirmation dialog is drawn inside the app window (not a native one). The
read-only attribute WeChat puts on every payload is handled for you.

> On your first run, use the Recycle Bin, verify nothing was lost, and only then
> consider permanent deletion.

## FAQ

**It says 「未以管理员身份运行」(not running as administrator).**
Click 「以管理员身份重启」 in the banner, or close it and right-click the exe →
"Run as administrator".

**Can I use it without administrator rights?**
Yes. Switch 备份索引 to 「只索引指定文件夹（不需管理员）」, click 「选择文件夹…」, and
add the folders where backups might live (e.g. `D:\Documents`, `D:\Downloads`).
Slower, but no elevation needed.

**Indexing failed, or a volume could not be read.**
Usually missing elevation. Check the yellow banner, or click 「自检」 — it reports
which step is stuck.

**Why was one of my drives skipped?**
It is not NTFS (typically an exFAT external drive or a FAT32 stick). Reading the
Master File Table is an NTFS-only capability; use folder mode for those.

**A file is marked as sent, but I remember receiving it.**
The judgement is based on modification time — a heuristic, not official WeChat
data. That is exactly why 收发判定 and 备份 are **two independent columns**: read
them together and never delete on one column alone.

**Antivirus flags it.**
The binary is unsigned (code-signing certificates cost money for a personal
project), so some scanners produce false positives. The full source is public —
audit it or build it yourself. Whitelist it once you are satisfied.

**What are the log buttons for?**
For troubleshooting on another machine: 「查看日志」 shows the app log, 「打开日志
文件夹」 reveals the file. Logs are also written to `logs\app.log` next to the exe,
so they travel with the program.

**The UI is too bright / too dark.**
The 浅色 / 深色 button at the far right of the status line switches themes; the
first run follows your system theme, afterwards your choice is remembered.

**Does it upload my files anywhere?**
No. It is fully offline, the UI itself forbids all network requests, and every
decision is made on your machine.

## Requirements

| | |
|---|---|
| OS | Windows 10/11, 64-bit |
| Privileges | Administrator recommended (needed for the whole-volume index); works without |
| Filesystem | NTFS for the whole-volume index |
| Other | nothing |

## Known limitations

- **Sent/received is a heuristic.** A file received and re-sent in the same month
  looks received. That is what the 备份 column is for.
- **The whole-volume index is rebuilt on every launch** (~2–6 s).
- **64-bit Windows only.**
- **Files above 64 MB are compared by sampling** (exact size plus several spread
  samples) rather than a full hash, so a miss is theoretically possible.

## Building / implementation notes

See [DEVELOPING.md](DEVELOPING.md) (Chinese).

## License

[MIT](LICENSE).
