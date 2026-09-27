/**
 * End-to-end reproduction of the user's full sequence, unattended.
 *
 * Runs the real main process module and drives the real UI: scan -> index (folder
 * mode) -> look up backups -> select rows -> CLICK THE DELETE BUTTON -> answer the
 * in-app confirmation -> verify the files are gone and the app survived.
 *
 * This exists because the shipped delete flow kept failing in ways only a real click
 * could reveal. The confirmation is drawn in the page (the previous native
 * dialog.showMessageBox appeared but never resolved on one machine, which looked
 * like a crash), so this probe requires no interaction.
 *
 * The delete targets read-only samples with awkward names (Chinese, commas,
 * parentheses) in a scratch folder; pass a directory as the first argument to use
 * real files instead. No real WeChat data is ever modified.
 *
 * Usage: electron.exe tools/repro-full-flow.cjs [--recycle] [--count N]
 */
const { app, BrowserWindow, dialog } = require('electron');
const { join } = require('node:path');
const {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');

// Both paths are derived from this script's location; hardcoding the checkout or a
// WeChat account id would leak private machine details into a public repository.
const ROOT = join(__dirname, '..');
const useRecycle = process.argv.includes('--recycle');
const countArg = process.argv.indexOf('--count');
const howMany = countArg > -1 ? Number(process.argv[countArg + 1]) : 10;

const out = (s) => process.stdout.write(`FLOW ${s}\n`);
let failures = 0;
const check = (label, ok, detail = '') => {
  out(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
process.on('uncaughtException', (err) => { out(`UNCAUGHT ${err.name}: ${err.message}`); failures++; });
process.on('unhandledRejection', (r) => { out(`UNHANDLED ${r?.message ?? r}`); failures++; });

/**
 * Record every native dialog call.
 *
 * The in-app confirmation must be used, so a native dialog appearing at all is a
 * regression — and if one is shown, it must not be allowed to block the run.
 */
let nativeDialogCalls = 0;
dialog.showMessageBox = async (...args) => {
  nativeDialogCalls++;
  const opts = args.length > 1 ? args[1] : args[0];
  out(`native dialog #${nativeDialogCalls} was shown: "${opts?.title}"`);
  return { response: 0, checkboxChecked: false };
};

app.whenReady().then(async () => {
  const started = Date.now();
  let work = null;
  // Only this run's log lines are examined: reading the tail would let a line from an
  // earlier run satisfy (or break) an assertion.
  const logFile = join(app.getPath('userData'), 'logs', 'app.log');
  const logSizeBefore = existsSync(logFile) ? statSync(logFile).size : 0;
  try {
    out(`electron ${process.versions.electron} (node ${process.versions.node}) mode=${useRecycle ? 'recycle' : 'permanent'} count=${howMany}`);

    // --- prepare a scratch scan folder holding read-only samples --------------
    // Samples are synthesised with the properties that matter (read-only, Chinese
    // names, commas, parentheses) unless the caller supplies a real directory, so no
    // WeChat account id has to live in this file.
    work = join(tmpdir(), `wxflow-${process.pid}`);
    const scanRoot = join(work, 'msg', '2022-09');
    mkdirSync(scanRoot, { recursive: true });
    const { prepareSamples, sampleDirFrom } = await import(
      `file:///${join(ROOT, 'tools', 'paths.mjs').replace(/\\/g, '/')}`
    );
    const prepared = await prepareSamples({
      count: howMany,
      destDir: scanRoot,
      sourceDir: sampleDirFrom(process.argv.slice(2)),
    });
    const copies = prepared.files;
    check(prepared.synthetic ? 'prepared read-only synthetic samples' : 'prepared read-only copies of real WeChat files',
      copies.length === howMany,
      `${copies.length} files, e.g. ${copies[0]?.split('\\').pop()}`);

    // Boot the real application.
    await import(`file:///${join(ROOT, 'src', 'main', 'main.js').replace(/\\/g, '/')}`);
    let win = null;
    for (let i = 0; i < 80 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] ?? null;
      if (!win) await new Promise((r) => setTimeout(r, 250));
    }
    check('main process created a window', Boolean(win));
    if (!win) { app.exit(1); return; }
    win.show();
    await new Promise((r) => setTimeout(r, 1500));
    const api = (expression) => win.webContents.executeJavaScript(expression, true);

    // Collect page-level errors so a rendering failure is attributable here rather
    // than surfacing as an unexplained empty table.
    await api(`(() => {
      window.__errors = [];
      window.addEventListener('error', (e) => window.__errors.push('error: ' + e.message));
      window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
      return true;
    })()`);

    // --- 1..3. drive the UI end to end ---------------------------------------
    // Everything goes through the on-screen controls, exactly as a user would. An
    // earlier version of this probe called the IPC API directly, which updated the
    // main process's state but left the renderer's own table empty — so the probe
    // was testing a situation no user can reach.
    out('--- clicking 扫描 / 建立索引 / 查备份 in the real UI ---');
    const driven = await api(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      document.getElementById('folder-path').value = ${JSON.stringify(join(work, 'msg'))};
      document.getElementById('btn-scan').click();
      await wait(3000);

      // Folder mode needs no elevation, so the index can be built in this process.
      const scope = document.getElementById('scope-select');
      scope.value = 'folders';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);

      const pick = document.getElementById('btn-pick-folders');
      // The real picker opens a dialog, so seed the folder list through the same
      // settings channel the picker uses, then rebuild the index.
      await window.cleaner.saveSettings({ fallbackFolders: [${JSON.stringify(scanRoot)}], searchScope: 'folders' });
      document.getElementById('btn-index').click();
      await wait(3000);

      document.getElementById('btn-match').click();
      await wait(4000);

      return {
        rows: document.querySelectorAll('#tbody tr').length,
        statusSummary: document.getElementById('status-summary').textContent,
        errors: window.__errors ?? [],
      };
    })()`);
    check('scan and index populated the table', Number(driven.rows) === howMany,
      `rows=${driven.rows} status="${driven.statusSummary}" errors=${JSON.stringify(driven.errors)}`);

    // --- 4. select the rows and CLICK DELETE through the real UI -------------
    out('--- selecting rows and clicking 删除 ---');
    const click = await api(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const rows = document.querySelectorAll('#tbody tr');
      if (!rows.length) return { error: 'no rows rendered' };
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 1; i < rows.length; i++) {
        rows[i].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
      }
      await wait(250);
      const modeSel = document.getElementById('delete-mode');
      modeSel.value = ${JSON.stringify(useRecycle ? 'recycle' : 'permanent')};
      modeSel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btn-delete').click();
      // The in-app confirmation must appear.
      await wait(500);
      const overlay = document.getElementById('confirm-overlay');
      return {
        rows: rows.length,
        selected: document.getElementById('sel-count').textContent,
        confirmVisible: Boolean(overlay) && !overlay.classList.contains('hidden'),
        confirmTitle: document.getElementById('confirm-title')?.textContent ?? '',
        confirmMessage: document.getElementById('confirm-message')?.textContent ?? '',
      };
    })()`);
    check('rows selected before delete', !click.error && Number(click.selected) === howMany,
      click.error ?? `rows=${click.rows} selected=${click.selected}`);
    check('the in-app confirmation appeared', click.confirmVisible === true,
      click.confirmTitle ?? 'overlay not visible');
    check('the confirmation names the correct mode',
      (click.confirmMessage ?? '').includes(useRecycle ? '回收站' : '永久删除'),
      click.confirmMessage ?? '');

    // --- 5. answer the confirmation ------------------------------------------
    out('--- answering the confirmation ---');
    const answered = await api(`(async () => {
      const ok = document.getElementById('confirm-ok');
      if (!ok) return { error: 'confirm button missing' };
      ok.click();
      return { clicked: true };
    })()`);
    check('the confirmation was answered', answered.clicked === true, answered.error ?? '');

    // Give the deletion time to run.
    await new Promise((r) => setTimeout(r, 10000));

    const pageAlive = await api('document.getElementById("btn-delete") !== null').catch(() => false);
    check('the app window survived the delete', pageAlive,
      pageAlive ? '' : 'the page is gone (renderer or process died)');
    check('no native dialog was used', nativeDialogCalls === 0, `calls=${nativeDialogCalls}`);

    const left = copies.filter((p) => existsSync(p)).length;
    check('every copy was deleted', left === 0, `remaining=${left}`);

    // --- 6. log evidence -----------------------------------------------------
    if (existsSync(logFile)) {
      const tail = readFileSync(logFile, 'utf8').slice(logSizeBefore);
      check('the renderer logged the click', tail.includes('[renderer:delete] clicked'));
      check('the renderer logged the confirmation result', /\[renderer:delete\] confirmation result: true/.test(tail));
      check('the main process received the request', tail.includes('[delete] requested'));
      check('the deletion engine reported a result', tail.includes('deletion engine returned'));
      // Match the current wording with its timeout, so this cannot be satisfied by a
      // stale line from an earlier run.
      check('no native confirmation was shown',
        !/showing (permanent|recycle) confirmation natively/.test(tail));
      check('no crash recorded', !tail.includes('[crash]'));
      out('--- relevant log lines ---');
      for (const line of tail.split('\n')
        .filter((l) => /\[delete\]|\[renderer:delete\]|\[crash\]/.test(l))
        .slice(-14)) out(`    ${line}`);
    }
  } catch (err) {
    out(`HARNESS ERROR ${err.message}\n${err.stack ?? ''}`);
    failures++;
  } finally {
    if (work) { try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  out(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
  out(failures === 0 ? 'RESULT ALL PASSED' : `RESULT ${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
