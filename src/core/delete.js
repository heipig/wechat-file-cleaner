/**
 * File deletion: Recycle Bin or permanent.
 *
 * Two independent mechanisms, chosen for reliability on machines this was not
 * built on:
 *
 *   - Permanent: Node's own `fs.rmSync(..., { force: true })`, which clears a
 *     read-only attribute (every WeChat payload has one) and needs no external
 *     program at all.
 *   - Recycle Bin: Windows Script Host, invoked as `cscript.exe //nologo //B` with
 *     a generated `.vbs`. WSH's `FileSystemObject.DeleteFile(path, True)` routes
 *     through the shell's recycle machinery, so the item stays restorable.
 *
 * Why not PowerShell: the previous implementation shelled out to
 * `powershell.exe -File delete-files.ps1`, which depends on PowerShell being
 * present, permitted by execution policy (including any Group Policy override),
 * allowed by the installed antivirus, and carrying the `Microsoft.VisualBasic`
 * assembly for recycle support. Each of those varies between machines, and a
 * failure there looked like the app vanishing. `cscript.exe` has none of those
 * dependencies, starts far faster, and is subject to no execution policy.
 *
 * Paths travel as command-line arguments rather than through a pipe or a JSON
 * file, because passing non-ASCII paths through a console pipe once corrupted them
 * (a Chinese filename arrived as mojibake, and the existing file was then reported
 * as already missing).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VBScript that moves files to the Recycle Bin and reports what happened.
 *
 * The report is written as UTF-16 with per-path failure detail, so failures can be
 * attributed to individual files instead of the whole batch failing anonymously.
 * Note that `IIf` is evaluated eagerly in VBScript, so it is only used for its
 * value here, never for its side effects.
 */
export const RECYCLE_SCRIPT = [
  "Option Explicit",
  "' Move each path given on the command line to the Recycle Bin.",
  "' Usage: cscript //nologo //B recycle-files.vbs <report-path> <file> [file...]",
  "Dim args, reportPath, fso, ts, i, p, deleted, failures, sep",
  "Set args = WScript.Arguments",
  "If args.Count < 2 Then WScript.Quit 2",
  "reportPath = args(0)",
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  "Set ts = fso.CreateTextFile(reportPath, True, True)",
  "deleted = 0",
  'failures = ""',
  "For i = 1 To args.Count - 1",
  "  p = args(i)",
  "  On Error Resume Next",
  "  Err.Clear",
  "  If fso.FileExists(p) Then",
  "    fso.DeleteFile p, True",
  "    If Err.Number <> 0 Then",
  '      sep = ""',
  '      If failures <> "" Then sep = "|"',
  '      failures = failures & sep & p & " <= " & Err.Description',
  "      Err.Clear",
  "    ElseIf fso.FileExists(p) Then",
  '      sep = ""',
  '      If failures <> "" Then sep = "|"',
  '      failures = failures & sep & p & " <= still present after delete"',
  "    Else",
  "      deleted = deleted + 1",
  "    End If",
  "  ElseIf fso.FolderExists(p) Then",
  '    sep = ""',
  '    If failures <> "" Then sep = "|"',
  '    failures = failures & sep & p & " <= not a file"',
  "  Else",
  "    ' Already gone: counts as success so a repeated cleanup is idempotent.",
  "    deleted = deleted + 1",
  "  End If",
  "  On Error GoTo 0",
  "Next",
  'ts.WriteLine "D=" & deleted',
  'ts.WriteLine "F=" & failures',
  "ts.Close",
  "WScript.Quit 0",
].join('\r\n');

/** Directory for generated support scripts; set by the app, temp otherwise. */
let scriptDir = null;

/**
 * Point the module at a writable directory for its generated scripts.
 * @param {string} dir
 */
export function setDeleteScriptDir(dir) {
  scriptDir = dir;
}

/** The directory used for generated scripts and reports. */
export function deleteWorkDir() {
  const dir = scriptDir ?? join(process.env.TEMP ?? '.', 'wechat-file-cleaner');
  try { mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return dir;
}

/**
 * Ensure the recycle helper exists on disk and return its path.
 * @returns {string}
 */
export function recycleScriptPath() {
  const path = join(deleteWorkDir(), 'recycle-files.vbs');
  // WSH reads a .vbs as ANSI unless it carries a UTF-16 BOM, so it is written as
  // UTF-16LE. The content is pure ASCII, but the BOM makes that independent of the
  // machine's ANSI code page.
  writeFileSync(path, `\ufeff${RECYCLE_SCRIPT}`, 'utf16le');
  return path;
}

/** Result shape for an empty request. */
const EMPTY_RESULT = { ok: true, succeeded: [], failed: [], errors: [] };

/**
 * Delete a batch of files.
 *
 * @param {object} options
 * @param {string[]} options.paths Absolute file paths. Directories are refused.
 * @param {'recycle'|'permanent'} [options.mode]
 * @param {string} [options.tempDir] Directory for the recycle report and script.
 * @returns {Promise<{ok:boolean, mode:string, recycled:boolean,
 *   succeeded:Array<{path:string, note:string}>, failed:Array<{path:string, error:string}>,
 *   errors:string[]}>}
 */
export async function deleteFiles({ paths, mode = 'recycle', tempDir }) {
  if (!paths?.length) {
    return { ...EMPTY_RESULT, mode, recycled: mode === 'recycle' };
  }
  const targets = paths.map(String);
  return mode === 'permanent'
    ? deletePermanently(targets)
    : deleteToRecycleBin(targets, tempDir ?? deleteWorkDir());
}

/**
 * Permanent deletion via Node's own fs.
 *
 * `force: true` is what makes this work on WeChat's files: every payload carries
 * FILE_ATTRIBUTE_READONLY, and deleting a read-only file without clearing that bit
 * fails with "access denied". Node clears it for us.
 *
 * @param {string[]} paths
 * @returns {Promise<object>}
 */
async function deletePermanently(paths) {
  const succeeded = [];
  const failed = [];
  for (const path of paths) {
    try {
      if (!existsSync(path)) {
        succeeded.push({ path, note: 'already-missing' });
        continue;
      }
      rmSync(path, { force: true });
      if (existsSync(path)) throw new Error('still-present-after-delete');
      succeeded.push({ path, note: 'deleted' });
    } catch (err) {
      failed.push({ path, error: err?.message ?? String(err), errorType: err?.code ?? err?.name });
    }
  }
  return {
    ok: failed.length === 0,
    mode: 'permanent',
    recycled: false,
    succeeded,
    failed,
    errors: [],
  };
}

/**
 * Recycle Bin deletion through Windows Script Host.
 *
 * @param {string[]} paths
 * @param {string} work
 * @returns {Promise<object>}
 */
function deleteToRecycleBin(paths, work) {
  return new Promise((resolve) => {
    let script;
    let reportPath;
    try {
      script = recycleScriptPath();
      reportPath = join(work, `recycle-report-${process.pid}-${Date.now()}.txt`);
    } catch (err) {
      resolve({
        ...EMPTY_RESULT, ok: false, mode: 'recycle', recycled: false,
        errors: [`无法生成回收站脚本：${err.message}`],
      });
      return;
    }

    // Use the absolute path so a broken PATH cannot make this fail.
    const cscript = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'cscript.exe')
      : 'cscript.exe';

    let child;
    try {
      child = spawn(cscript, ['//nologo', '//B', script, reportPath, ...paths], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      resolve({
        ...EMPTY_RESULT, ok: false, mode: 'recycle', recycled: false,
        errors: [`无法启动回收站助手：${err.message}`],
      });
      return;
    }

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d) => { stderr += d; });

    const fail = (message) => {
      try { unlinkSync(reportPath); } catch { /* may not exist */ }
      resolve({ ...EMPTY_RESULT, ok: false, mode: 'recycle', recycled: false, errors: [message] });
    };

    child.on('error', (err) => fail(`回收站助手启动失败：${err.message}`));

    child.on('close', (code) => {
      let report = null;
      try { report = parseReport(reportPath); } catch { /* handled below */ }
      try { unlinkSync(reportPath); } catch { /* may not exist */ }

      if (!report) {
        fail(`回收站助手异常退出（退出码 ${code}）${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''}`);
        return;
      }

      const failedPaths = new Map();
      for (const entry of report.failures) {
        const splitAt = entry.indexOf(' <= ');
        if (splitAt > 0) failedPaths.set(entry.slice(0, splitAt), entry.slice(splitAt + 4));
        else failedPaths.set(entry, '未知原因');
      }

      const succeeded = [];
      const failed = [];
      for (const path of paths) {
        if (failedPaths.has(path)) failed.push({ path, error: failedPaths.get(path) });
        else succeeded.push({ path, note: 'recycled' });
      }
      resolve({
        ok: failed.length === 0, mode: 'recycle', recycled: true, succeeded, failed, errors: [],
      });
    });
  });
}

/**
 * Read the WSH report file.
 *
 * The file is UTF-16LE with a BOM (WSH writes it that way), so the encoding is set
 * explicitly rather than relying on the platform default.
 *
 * @param {string} reportPath
 * @returns {{deleted:number, failures:string[]}|null}
 */
export function parseReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  const text = readFileSync(reportPath, 'utf16le').replace(/^\ufeff/, '');
  let deleted = 0;
  let failures = [];
  let sawAny = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('D=')) { deleted = Number(line.slice(2)) || 0; sawAny = true; }
    else if (line.startsWith('F=')) {
      const raw = line.slice(2).trim();
      failures = raw ? raw.split('|') : [];
      sawAny = true;
    }
  }
  return sawAny ? { deleted, failures } : null;
}

/**
 * Map a raw failure message to user-facing Chinese text.
 *
 * The messages now come from two very different sources (Node's fs and WSH), so the
 * mapping covers both vocabularies.
 *
 * @param {string} message
 * @returns {string}
 */
export function localizeDeleteError(message) {
  if (!message) return '未知错误';
  const text = String(message);
  if (text.includes('still-present-after-delete')) return '删除后文件仍然存在（可能被占用）';
  if (text.includes('not a file')) return '该路径不是文件，已跳过';
  if (text.includes('Permission denied') || text.includes('EPERM')) return '权限不足，无法删除（可能被占用）';
  if (text.includes('being used by another process') || text.includes('EBUSY') || text.includes('正由另一进程使用')) {
    return '文件正被其他程序占用（例如微信仍在运行），请关闭微信后重试';
  }
  if (text.includes('Access is denied') || text.includes('EACCES') || text.includes('拒绝访问') || text.includes('is denied')) {
    return '访问被拒绝：文件被占用或权限不足';
  }
  if (text.includes('Could not find file') || text.includes('ENOENT') || text.includes('找不到')) return '文件已不存在';
  if (text.includes('path is too long') || text.includes('ENAMETOOLONG')) return '路径过长，无法删除';
  return text;
}

/**
 * Describe the error class for the failure tooltip.
 * @param {string} errorType
 * @returns {string}
 */
export function localizeErrorType(errorType) {
  const map = {
    EPERM: '权限错误',
    EACCES: '权限错误',
    EBUSY: '文件被占用',
    ENOENT: '文件不存在',
    ENOTDIR: '路径非法',
    EISDIR: '这是目录',
    ENAMETOOLONG: '路径过长',
    UnauthorizedAccessException: '权限/占用错误',
    IOException: '占用或磁盘错误',
    FileNotFoundException: '文件不存在',
  };
  return map[errorType] ?? errorType ?? '';
}
