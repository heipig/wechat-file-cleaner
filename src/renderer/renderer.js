/**
 * Renderer: virtualised table over the scan result.
 *
 * Design notes
 * ------------
 * - The table is windowed. Only the rows intersecting the viewport exist in the
 *   DOM, so a folder with 200k files scrolls as smoothly as one with 50. The
 *   scroll container's height is reserved with a spacer element and the <table>
 *   is absolutely positioned at the window offset.
 * - Selection is the source of truth in `selection` (a Set of paths), not in the
 *   DOM, so re-filtering or re-sorting never loses or duplicates a selection.
 * - Column widths live in one array used by BOTH the header and the <colgroup>,
 *   which is what keeps them aligned; a ResizeObserver recomputes the filler
 *   column when the window changes width.
 */

const api = window.cleaner;

/**
 * Report a renderer-side problem to the main-process log.
 *
 * A crash in the renderer closes the window with nothing on disk to explain it,
 * and a packaged build has no console to inspect. `api.log` is a synchronous IPC
 * call precisely so a line survives a fatal error that follows it immediately.
 *
 * @param {string} tag
 * @param {string} message
 */
function rlog(tag, message) {
  try { api.log(tag, message); } catch { /* logging must never break the page */ }
}

// Surface anything that would otherwise kill the page silently.
window.addEventListener('error', (event) => {
  rlog('crash', `window error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  rlog('crash', `unhandled rejection: ${reason?.message ?? String(reason)}`);
});

rlog('boot', `renderer starting (readyState=${document.readyState})`);

const ROW_HEIGHT = 26;
const OVERSCAN = 8;

/** Column definitions: `key` doubles as the sort key. */
const COLUMNS = [
  { key: 'name', label: '文件名', width: 340, sortable: true, cls: 'name' },
  { key: 'size', label: '大小', width: 92, sortable: true, align: 'right', cls: 'mono' },
  { key: 'modifiedMs', label: '修改时间', width: 132, sortable: true, cls: 'mono' },
  { key: 'month', label: '月份', width: 76, sortable: true, cls: 'mono' },
  { key: 'kind', label: '类型', width: 68, sortable: true },
  { key: 'classification', label: '收发判定', width: 88, sortable: true },
  { key: 'backupStatus', label: '备份', width: 88, sortable: true },
  { key: 'backupPath', label: '备份位置', width: 420, sortable: false },
];

/** Application state owned by the renderer. */
const state = {
  all: [],                 // every scanned file
  view: [],                // filtered + sorted rows currently shown
  selection: new Set(),    // selected paths
  cursor: -1,              // keyboard cursor index into `view`
  anchor: -1,              // shift-selection anchor
  sortKey: 'modifiedMs',
  sortDir: 'desc',
  filterView: 'all',
  search: '',
  kind: '',
  month: '',
  minBytes: 0,
  settings: null,
  busy: false,
  popoverFor: null,
  theme: 'dark',
};

const $ = (id) => document.getElementById(id);

const els = {
  elevationBanner: $('elevation-banner'),
  folderPath: $('folder-path'),
  chkRecursive: $('chk-recursive'),
  chkVerify: $('chk-verify'),
  chkSize: $('chk-size'),
  minSize: $('min-size'),
  volumePicker: $('volume-picker'),
  progress: $('progress'),
  progressFill: $('progress-fill'),
  progressText: $('progress-text'),
  thead: $('thead'),
  colgroup: $('colgroup'),
  tbody: $('tbody'),
  tbodyPad: $('tbody-pad'),
  tbodyScroll: $('tbody-scroll'),
  table: $('vtable'),
  emptyState: $('empty-state'),
  search: $('search'),
  kindFilter: $('kind-filter'),
  monthFilter: $('month-filter'),
  deleteMode: $('delete-mode'),
  selCount: $('sel-count'),
  selSize: $('sel-size'),
  statusLeft: $('status-left'),
  statusSummary: $('status-summary'),
  statusIndex: $('status-index'),
  popover: $('popover'),
  popoverTitle: $('popover-title'),
  popoverBody: $('popover-body'),
  toast: $('toast'),
  btnCancel: $('btn-cancel'),
  btnMatch: $('btn-match'),
  btnScan: $('btn-scan'),
  btnIndex: $('btn-index'),
  scopeSelect: $('scope-select'),
  btnPickFolders: $('btn-pick-folders'),
  folderList: $('folder-list'),
  readyFolder: $('ready-folder'),
  readyIndex: $('ready-index'),
  readyMatch: $('ready-match'),
  readyProblem: $('ready-problem'),
  btnDiagnose: $('btn-diagnose'),
  btnViewLog: $('btn-view-log'),
  btnOpenLog: $('btn-open-log'),
  diagOutput: $('diag-output'),
  logOutput: $('log-output'),
  confirmOverlay: $('confirm-overlay'),
  confirmTitle: $('confirm-title'),
  confirmMessage: $('confirm-message'),
  confirmDetail: $('confirm-detail'),
  confirmOk: $('confirm-ok'),
  confirmCancel: $('confirm-cancel'),
  btnTheme: $('btn-theme'),
};

/** Mirror of the main process's index state, for the readiness panel. */
const readiness = {
  folder: false,
  indexFiles: 0,
  indexProblem: '',
  matched: null,     // null = not run yet
  matchedCount: 0,
};

/* ------------------------------------------------------------------ utils */

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function formatTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
function toast(message, kind = '') {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), kind === 'error' ? 8000 : 3600);
}

const CLASSIFICATION_LABEL = {
  sent: '发送件',
  received: '接收件',
  unknown: '不确定',
};

const BACKUP_LABEL = {
  confirmed: '已确认',
  candidate: '疑似',
  none: '无备份',
  unchecked: '未查',
  unverified: '未校验',
};

const KIND_LABEL = {
  document: '文档', image: '图片', video: '视频', audio: '音频',
  archive: '压缩包', executable: '可执行', other: '其他',
};

/* --------------------------------------------------------- column geometry */

/** Current pixel width per column, with the last column absorbing slack. */
function computeWidths() {
  const available = els.tbodyScroll.clientWidth || window.innerWidth;
  const fixed = COLUMNS.slice(0, -1).reduce((sum, c) => sum + c.width, 0);
  const last = Math.max(COLUMNS[COLUMNS.length - 1].width, available - fixed);
  return COLUMNS.map((c, i) => (i === COLUMNS.length - 1 ? last : c.width));
}

function renderHeader() {
  const widths = computeWidths();
  els.thead.replaceChildren();
  els.colgroup.replaceChildren();

  const row = document.createElement('div');
  row.className = 'thead-row';

  COLUMNS.forEach((col, i) => {
    const th = document.createElement('div');
    th.className = `th${col.align === 'right' ? ' right' : ''}${
      state.sortKey === col.key ? ' sorted' : ''}`;
    th.style.width = `${widths[i]}px`;
    th.dataset.key = col.key;
    const label = document.createElement('span');
    label.textContent = col.label;
    th.append(label);
    if (state.sortKey === col.key) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = state.sortDir === 'asc' ? '▲' : '▼';
      th.append(arrow);
    }
    if (col.sortable) th.addEventListener('click', () => toggleSort(col.key));
    row.append(th);

    const cg = document.createElement('col');
    cg.style.width = `${widths[i]}px`;
    els.colgroup.append(cg);
  });

  els.thead.append(row);
  els.table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
  // Re-apply the horizontal offset: a header rebuild resets its transform.
  els.thead.style.transform = `translateX(${-els.tbodyScroll.scrollLeft}px)`;
}

function toggleSort(key) {
  if (!COLUMNS.find((c) => c.key === key)?.sortable) return;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    // Sizes and times read best largest/newest first; names read best A→Z.
    state.sortDir = key === 'name' || key === 'month' || key === 'kind' ? 'asc' : 'desc';
  }
  applyFilters();
}

/* --------------------------------------------------------------- filtering */

const STATUS_RANK = { confirmed: 0, candidate: 1, unverified: 2, unchecked: 3, none: 4 };

function applyFilters() {
  const needle = state.search.trim().toLowerCase();
  const kind = state.kind;
  const month = state.month;
  const minBytes = state.minBytes;

  let rows = state.all;
  if (needle) rows = rows.filter((f) => f.name.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle));
  if (kind) rows = rows.filter((f) => f.kind === kind);
  if (month) rows = rows.filter((f) => f.month === month);
  if (minBytes > 0) rows = rows.filter((f) => f.size >= minBytes);

  switch (state.filterView) {
    case 'backed':
      rows = rows.filter((f) => f.backupCount > 0);
      break;
    case 'sent':
      rows = rows.filter((f) => f.classification === 'sent');
      break;
    case 'received':
      rows = rows.filter((f) => f.classification === 'received');
      break;
    case 'unchecked':
      rows = rows.filter((f) => !f.backupChecked);
      break;
    default:
      break;
  }

  const dir = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  const decorated = rows.map((f, i) => ({ f, i }));
  decorated.sort((a, b) => {
    let cmp;
    switch (key) {
      case 'name':
        cmp = a.f.name.localeCompare(b.f.name, 'zh-Hans-CN');
        break;
      case 'month':
        cmp = String(a.f.month ?? '').localeCompare(String(b.f.month ?? ''));
        break;
      case 'kind':
        cmp = String(a.f.kind).localeCompare(String(b.f.kind));
        break;
      case 'classification':
        cmp = String(a.f.classification).localeCompare(String(b.f.classification));
        break;
      case 'backupStatus':
        cmp = (STATUS_RANK[a.f.backupStatus] ?? 9) - (STATUS_RANK[b.f.backupStatus] ?? 9);
        break;
      case 'size':
        cmp = a.f.size - b.f.size;
        break;
      case 'modifiedMs':
        cmp = a.f.modifiedMs - b.f.modifiedMs;
        break;
      default:
        cmp = 0;
    }
    // Stable tiebreak on the original scan order so sorting is deterministic.
    return cmp !== 0 ? cmp * dir : a.i - b.i;
  });

  state.view = decorated.map((d) => d.f);
  if (state.cursor >= state.view.length) state.cursor = state.view.length - 1;
  els.tbodyScroll.scrollTop = Math.min(
    els.tbodyScroll.scrollTop,
    Math.max(0, state.view.length * ROW_HEIGHT - els.tbodyScroll.clientHeight),
  );
  renderBody();
  updateSelectionInfo();
  updateStatus();
}

/* ---------------------------------------------------------------- rendering */

function backupCellText(file) {
  if (!file.backupChecked) return '';
  if (file.backupCount > 0) {
    return file.backupCount === 1 ? '查看路径' : `${file.backupCount} 处路径`;
  }
  if (file.backupStatus === 'none') return '—';
  return '';
}

function buildRow(file, index, widths) {
  const tr = document.createElement('tr');
  tr.dataset.index = String(index);
  tr.dataset.path = file.path;
  if (state.selection.has(file.path)) tr.classList.add('selected');

  COLUMNS.forEach((col, ci) => {
    const td = document.createElement('td');
    td.style.width = `${widths[ci]}px`;
    if (col.align === 'right') td.classList.add('right');
    if (col.cls) td.classList.add(col.cls);

    switch (col.key) {
      case 'name':
        td.textContent = file.name;
        td.title = file.path;
        break;
      case 'size':
        td.textContent = formatSize(file.size);
        break;
      case 'modifiedMs':
        td.textContent = formatTime(file.modifiedMs);
        break;
      case 'month':
        td.textContent = file.month ?? '—';
        break;
      case 'kind':
        td.textContent = KIND_LABEL[file.kind] ?? file.kind;
        break;
      case 'classification': {
        const chip = document.createElement('span');
        chip.className = `chip chip-${file.classification}`;
        chip.textContent = CLASSIFICATION_LABEL[file.classification] ?? file.classification;
        chip.title = file.classifyReason ?? '';
        td.append(chip);
        break;
      }
      case 'backupStatus': {
        const chip = document.createElement('span');
        chip.className = `chip chip-${file.backupStatus}`;
        chip.textContent = BACKUP_LABEL[file.backupStatus] ?? file.backupStatus;
        td.append(chip);
        break;
      }
      case 'backupPath': {
        const text = backupCellText(file);
        if (text) {
          const link = document.createElement('span');
          link.className = 'link-cell';
          link.textContent = text;
          link.dataset.action = 'show-backups';
          td.append(link);
        } else if (!file.backupChecked) {
          td.textContent = '未查';
          td.style.color = 'var(--fg-faint)';
        } else {
          td.textContent = '—';
          td.style.color = 'var(--fg-faint)';
        }
        break;
      }
      default:
        break;
    }
    tr.append(td);
  });

  // Hovering the backup cell opens the popover after a short dwell, matching
  // the "mouse over it and see the path" requirement without flicker.
  tr.addEventListener('mouseover', (ev) => {
    const action = ev.target?.dataset?.action;
    if (action === 'show-backups') scheduleHoverPopover(file, ev.target);
  });
  tr.addEventListener('mouseout', (ev) => {
    if (ev.target?.dataset?.action === 'show-backups') cancelHoverPopover();
  });
  tr.addEventListener('click', (ev) => {
    const action = ev.target?.dataset?.action;
    if (action === 'show-backups') {
      ev.stopPropagation();
      showBackupPopover(file, ev.target);
      return;
    }
    // Let the browser's modifier keys drive range/toggle selection.
    state.cursor = index;
    if (ev.shiftKey && state.anchor >= 0) {
      selectRange(state.anchor, index, ev.ctrlKey);
    } else if (ev.ctrlKey || ev.metaKey) {
      toggleSelection(file.path);
      state.anchor = index;
    } else {
      state.selection.clear();
      state.selection.add(file.path);
      state.anchor = index;
    }
    renderBody();
    updateSelectionInfo();
  });
  tr.addEventListener('dblclick', (ev) => {
    if (ev.target?.dataset?.action === 'show-backups') return;
    api.reveal(file.path);
  });

  return tr;
}

/** Rebuild only the rows inside the viewport window. */
function renderBody() {
  const scrollTop = els.tbodyScroll.scrollTop;
  const viewportH = els.tbodyScroll.clientHeight;
  const total = state.view.length;

  els.tbodyPad.style.height = `${total * ROW_HEIGHT}px`;
  els.emptyState.classList.toggle('hidden', total > 0);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);

  // Measure the column widths once per render. Reading clientWidth per cell
  // would force a layout flush for every row built.
  const widths = computeWidths();
  const fragment = document.createDocumentFragment();
  for (let i = first; i < last; i++) fragment.append(buildRow(state.view[i], i, widths));

  els.tbody.replaceChildren(fragment);
  els.table.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
}

/* ---------------------------------------------------------------- selection */

function toggleSelection(path) {
  if (state.selection.has(path)) state.selection.delete(path);
  else state.selection.add(path);
}

function selectRange(from, to, additive) {
  if (!additive) state.selection.clear();
  const [a, b] = from <= to ? [from, to] : [to, from];
  for (let i = a; i <= b; i++) {
    const row = state.view[i];
    if (row) state.selection.add(row.path);
  }
}

function updateSelectionInfo() {
  els.selCount.textContent = String(state.selection.size);
  let bytes = 0;
  for (const f of state.all) if (state.selection.has(f.path)) bytes += f.size;
  els.selSize.textContent = formatSize(bytes);
}

function updateStatus() {
  const total = state.view.length;
  const all = state.all.length;
  const shown = total === all ? `${all} 个文件` : `${total} / ${all} 个文件`;
  let bytes = 0;
  let backed = 0;
  for (const f of state.view) {
    bytes += f.size;
    if (f.backupCount > 0) backed++;
  }
  els.statusSummary.textContent = `当前列表 ${shown} · ${formatSize(bytes)} · 其中有备份 ${backed}`;
}

/* ------------------------------------------------------------------ popover */

let hoverTimer = null;

function scheduleHoverPopover(file, anchorEl) {
  cancelHoverPopover();
  hoverTimer = setTimeout(() => showBackupPopover(file, anchorEl), 260);
}

function cancelHoverPopover() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
}

function showBackupPopover(file, anchorEl) {
  state.popoverFor = file.path;
  els.popoverTitle.textContent = `备份位置 · ${file.name}`;
  els.popoverBody.replaceChildren();

  const statusLine = document.createElement('div');
  statusLine.className = 'popover-note';
  statusLine.textContent = file.backupCount > 0
    ? `找到 ${file.backupCount} 处内容一致的副本（文件大小 ${formatSize(file.size)}）`
    : '没有找到内容一致的副本，删除前请确认里面没有需要保留的内容。';
  els.popoverBody.append(statusLine);

  if (file.backupCount > 0) {
    for (const backup of file.backups ?? []) {
      const row = document.createElement('div');
      row.className = 'backup-item';

      const path = document.createElement('span');
      path.className = 'backup-path';
      path.textContent = backup.path;

      const meta = document.createElement('span');
      meta.className = 'backup-meta';
      meta.textContent = formatTime(backup.modifiedMs);
      meta.title = `修改时间 ${formatTime(backup.modifiedMs)}`;

      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-ghost';
      openBtn.textContent = '定位';
      openBtn.title = '在资源管理器中选中此文件';
      openBtn.addEventListener('click', () => api.reveal(backup.path));

      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn btn-ghost';
      copyBtn.textContent = '复制路径';
      copyBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(backup.path);
        toast('已复制备份路径', 'ok');
      });

      row.append(path, meta, openBtn, copyBtn);
      els.popoverBody.append(row);
    }

    const sourceRow = document.createElement('div');
    sourceRow.className = 'backup-item';
    const label = document.createElement('span');
    label.className = 'backup-meta';
    label.textContent = '微信副本：';
    const src = document.createElement('span');
    src.className = 'backup-path';
    src.style.color = 'var(--fg-faint)';
    src.textContent = file.path;
    sourceRow.append(label, src);
    els.popoverBody.append(sourceRow);
  } else {
    const hint = document.createElement('div');
    hint.className = 'backup-item';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '在全盘索引中重新查找';
    btn.addEventListener('click', () => runMatch([file.path]));
    hint.append(btn);
    els.popoverBody.append(hint);
  }

  // Anchor under the clicked cell, clamped inside the window.
  const rect = anchorEl.getBoundingClientRect();
  els.popover.classList.remove('hidden');
  const popW = els.popover.offsetWidth;
  const popH = els.popover.offsetHeight;
  const left = Math.min(Math.max(8, rect.left - 40), window.innerWidth - popW - 8);
  const top = rect.bottom + popH + 8 > window.innerHeight
    ? Math.max(8, rect.top - popH - 6)
    : rect.bottom + 4;
  els.popover.style.left = `${left}px`;
  els.popover.style.top = `${top}px`;
}

function hidePopover() {
  els.popover.classList.add('hidden');
  state.popoverFor = null;
}

/* ------------------------------------------------------------------- tasks */

function setBusy(busy, label = '') {
  state.busy = busy;
  els.btnCancel.classList.toggle('hidden', !busy);
  for (const btn of [els.btnScan, els.btnIndex, els.btnMatch]) btn.disabled = busy;
  if (busy) {
    els.statusLeft.textContent = label || '处理中…';
  }
}

function showProgress(text, ratio = null) {
  els.progress.classList.remove('hidden');
  els.progressText.textContent = text;
  if (ratio === null) {
    els.progressFill.classList.add('indeterminate');
    els.progressFill.style.width = '';
  } else {
    els.progressFill.classList.remove('indeterminate');
    els.progressFill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  }
}

function hideProgress(delayMs = 700) {
  setTimeout(() => els.progress.classList.add('hidden'), delayMs);
}

async function runScan() {
  const root = els.folderPath.value.trim();
  if (!root) { toast('请先选择微信文件夹', 'error'); return; }
  setBusy(true, '正在扫描文件夹…');
  showProgress('正在枚举文件…', null);
  try {
    const scan = await api.startScan({
      root,
      recursive: els.chkRecursive.checked,
      graceDays: state.settings?.graceDays ?? 2,
    });
    state.all = scan.files;
    state.selection.clear();
    state.cursor = -1;
    state.anchor = -1;
    rebuildMonthFilter();
    const s = scan.summary;
    toast(`扫描完成：${s.files} 个文件，判定发送件 ${s.sent} 个`, 'ok');
    els.statusLeft.textContent = `已扫描 ${scan.root}`;
    applyFilters();
    readiness.folder = true;
    renderReadiness();
  } catch (err) {
    toast(`扫描失败：${err.message}`, 'error');
  } finally {
    setBusy(false);
    hideProgress();
  }
}

async function runIndex() {
  const scope = els.scopeSelect.value;
  const volumes = [...els.volumePicker.querySelectorAll('input:checked')].map((i) => i.value);
  const folders = state.settings?.fallbackFolders ?? [];

  if (scope === 'mft' && !volumes.length) { toast('请至少选择一个盘符', 'error'); return; }
  if (scope === 'folders' && !folders.length) {
    toast('文件夹索引模式需要先点“选择文件夹…”添加至少一个位置', 'error');
    return;
  }

  setBusy(true, scope === 'folders' ? '正在索引指定文件夹…' : '正在建立全盘索引…');
  showProgress(scope === 'folders' ? '正在遍历文件夹…' : '正在读取 NTFS 主文件表…', null);
  try {
    const stats = await api.buildIndex({ volumes, scope, folders });
    const failed = stats.volumes.filter((v) => v.error);
    if (failed.length) {
      toast(`索引不完整，这些盘读取失败：${failed.map((v) => `${v.volume}: ${v.error}`).join('；')}`, 'error');
    } else if (!stats.files) {
      toast('索引里没有任何文件，请检查所选范围后重试', 'error');
    } else {
      const secs = Math.max(...stats.volumes.map((v) => v.elapsedMs ?? 0), 0) / 1000;
      toast(`索引完成：${stats.files} 个文件，用时 ${secs.toFixed(1)} 秒`, 'ok');
    }
    updateIndexStatus(stats);
    readiness.indexFiles = stats.files;
    readiness.indexProblem = stats.files ? '' : '索引为空，不能用于查备份。';
    renderReadiness();
  } catch (err) {
    readiness.indexProblem = `建立索引失败：${err.message}`;
    renderReadiness();
    toast(`建立索引失败：${err.message}`, 'error');
  } finally {
    setBusy(false);
    hideProgress();
  }
}

async function runMatch(onlyPaths) {
  if (!state.all.length) { toast('请先扫描微信文件夹', 'error'); return; }

  // The main process will build an index on demand when it can. Only refuse when
  // there is no possible source: no elevation for the MFT path, and no folder
  // configured for the folder path. Refusing blindly would block the folder mode,
  // which needs no index at all.
  let snapshot = null;
  try {
    snapshot = await api.getState();
  } catch { /* the pre-flight check is advisory */ }

  if (snapshot) {
    const stats = snapshot.index;
    const usable = (stats?.files ?? 0) > 0;
    const folderMode = (snapshot.settings?.searchScope ?? 'mft') === 'folders';
    const hasFolders = (snapshot.settings?.fallbackFolders ?? []).length > 0;
    const canBuildFolders = folderMode && hasFolders;

    if (!usable && !canBuildFolders) {
      const failed = (stats?.volumes ?? []).filter((v) => v.error);
      const text = failed.length
        ? `盘读取失败：${failed.map((v) => `${v.volume}: ${v.error}`).join('；')}`
        : '索引为空';
      toast(
        `${text}。请任选其一后重试：\n`
        + '· 以管理员身份重启（用 NTFS 主文件表建整盘索引）\n'
        + '· 或把“备份索引”切换为“只索引指定文件夹”，并添加你要查找备份的文件夹',
        'error',
      );
      readiness.indexProblem = text;
      renderReadiness();
      return;
    }
  }

  setBusy(true, '正在比对备份…');
  showProgress('准备索引并比对…', 0);
  try {
    const result = await api.startMatch({ onlyPaths });
    if (result.index) updateIndexStatus(result.index);
    const byPath = new Map(result.updates.map((u) => [u.path, u]));
    for (const file of state.all) {
      const update = byPath.get(file.path);
      if (!update) continue;
      file.backupStatus = update.backupStatus;
      file.backupCount = update.backupCount;
      file.backups = update.backups;
      file.backupChecked = true;
    }
    const { withBackup, total } = result.summary;
    readiness.matched = true;
    readiness.matchedCount = withBackup;
    if (result.index) {
      readiness.indexFiles = result.index.files ?? 0;
      readiness.indexProblem = '';
    }
    renderReadiness();

    const note = result.indexNote ? `${result.indexNote} ` : '';
    if (withBackup === 0) {
      toast(
        `${note}已比对 ${total} 个文件，没有找到内容一致的备份。\n`
        + '若你确认别处有副本：请检查索引范围是否覆盖了那个位置'
        + (readiness.indexFiles ? '' : '，或先建立索引'),
        'error',
      );
    } else {
      toast(`${note}查备份完成：${total} 个文件中 ${withBackup} 个找到备份`, 'ok');
    }
    applyFilters();
  } catch (err) {
    toast(`查备份失败：${err.message}`, 'error');
  } finally {
    setBusy(false);
    hideProgress();
  }
}

/**
 * Ask the user to confirm a deletion, inside the app window.
 *
 * This replaced a native `dialog.showMessageBox`. On one machine that dialog
 * appeared but never resolved — the log showed "showing confirmation" followed by
 * two minutes of silence and then a fresh app start — so the app looked frozen or
 * crashed when it was really waiting on an invisible modal. An in-page dialog
 * renders inside the window the user is already looking at and cannot do that.
 *
 * @param {{count:number, sizeText:string, mode:'recycle'|'permanent',
 *   confirmed?:boolean}} request
 * @returns {Promise<boolean>} true when the user confirms.
 */
function confirmDelete({ count, sizeText, mode }) {
  const permanent = mode === 'permanent';
  els.confirmTitle.textContent = permanent ? '确认永久删除' : '确认移到回收站';
  els.confirmMessage.textContent = permanent
    ? `即将永久删除 ${count} 个文件（${sizeText}），此操作无法撤销。`
    : `将 ${count} 个文件（${sizeText}）移到回收站？`;
  els.confirmDetail.textContent = permanent
    ? '如果你希望可以恢复，请改用“移到回收站”。'
    : '回收站里的文件可以随时还原。';
  els.confirmOk.textContent = permanent ? '永久删除' : '移到回收站';

  // Focus the safe button so a stray Enter cancels rather than deletes.
  els.confirmOverlay.classList.remove('hidden');
  els.confirmCancel.focus();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      els.confirmOverlay.classList.add('hidden');
      document.removeEventListener('keydown', onKey, true);
      els.confirmOk.removeEventListener('click', onOk);
      els.confirmCancel.removeEventListener('click', onCancel);
      els.confirmOverlay.removeEventListener('mousedown', onBackdrop);
      resolve(answer);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (event) => { if (event.target === els.confirmOverlay) finish(false); };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
      else if (event.key === 'Enter') { event.stopPropagation(); finish(true); }
    };
    els.confirmOk.addEventListener('click', onOk);
    els.confirmCancel.addEventListener('click', onCancel);
    els.confirmOverlay.addEventListener('mousedown', onBackdrop);
    // Captured so Escape/Enter are handled here before the table's shortcuts.
    document.addEventListener('keydown', onKey, true);
  });
}

/**
 * Just the file name, for logging.
 *
 * Logs travel with the program and get shared when something goes wrong, so a full
 * path would disclose the user's directory layout and WeChat account id. The file
 * name alone is enough to correlate a log line with what the user was doing.
 *
 * @param {string} path
 * @returns {string}
 */
function leafName(path) {
  const parts = String(path ?? '').split(/[\\/]/);
  return parts[parts.length - 1] || '(unknown)';
}

async function runDelete() {
  const paths = [...state.selection];
  rlog('delete', `clicked: selected=${state.selection.size} mode=${els.deleteMode.value}`);
  if (!paths.length) { toast('请先选中要删除的文件', 'error'); return; }
  const mode = els.deleteMode.value;

  // Confirm in-app before anything reaches the main process. The main process still
  // enforces its own confirmation when it is told `confirmed` is false, so a direct
  // API call cannot bypass this.
  let sizeBytes = 0;
  for (const file of state.all) if (state.selection.has(file.path)) sizeBytes += file.size;
  const sizeText = formatSize(sizeBytes);
  rlog('delete', `asking for confirmation (count=${paths.length} size=${sizeText})`);
  const confirmed = await confirmDelete({ count: paths.length, sizeText, mode });
  rlog('delete', `confirmation result: ${confirmed}`);
  if (!confirmed) { toast('已取消删除'); return; }

  try {
    // File names only: the full path would put the user's directory layout and
    // WeChat account id into a log file that travels with the program.
    rlog('delete', `invoking api.deleteFiles with ${paths.length} paths (first=${leafName(paths[0])})`);
    const result = await api.deleteFiles({ paths, mode, confirmed: true });
    rlog('delete', `api returned: ok=${result?.ok} canceled=${result?.canceled} succeeded=${(result?.succeeded ?? []).length} failed=${(result?.failed ?? []).length}`);
    if (result.canceled) { toast('已取消删除'); return; }
    const okCount = (result.succeeded ?? []).length;
    const failCount = (result.failed ?? []).length;
    const removed = new Set((result.succeeded ?? []).map((s) => s.path));
    state.all = state.all.filter((f) => !removed.has(f.path));
    for (const path of removed) state.selection.delete(path);
    rebuildMonthFilter();
    applyFilters();

    if (failCount) {
      // Group by reason so ten identical "file in use" failures read as one line.
      const reasons = new Map();
      for (const item of result.failed) {
        const key = `${item.errorType ? `[${item.errorType}] ` : ''}${item.error}`;
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      const summary = [...reasons.entries()]
        .map(([reason, count]) => `${count} 个：${reason}`)
        .join('；');
      toast(`成功删除 ${okCount} 个，失败 ${failCount} 个 —— ${summary}`, 'error');
      console.warn('delete failures:', result.failed);
    } else {
      const readOnlyFixed = (result.succeeded ?? []).filter((s) => s.readOnlyCleared).length;
      const extra = readOnlyFixed ? `（其中 ${readOnlyFixed} 个先清除了只读属性）` : '';
      toast(`已${mode === 'recycle' ? '移到回收站' : '永久删除'} ${okCount} 个文件${extra}`, 'ok');
    }
    if (result.errors?.length) toast(result.errors.join('；'), 'error');
  } catch (err) {
    toast(`删除失败：${err.message}`, 'error');
  }
}

function updateIndexStatus(stats) {
  if (!stats) { els.statusIndex.textContent = ''; return; }
  const files = stats.files ?? 0;
  const volumes = stats.volumes ?? [];
  // Three outcomes, not two: indexed, genuinely unreadable, and "cannot be indexed
  // by design" (a drive with no NTFS master file table). Only the middle one is a
  // fault, so colouring them alike made a healthy run with a USB stick look broken.
  const failed = volumes.filter((v) => v.error && v.status !== 'unsupported');
  const unsupported = volumes.filter((v) => v.status === 'unsupported');
  const ok = volumes.filter((v) => !v.error);
  const parts = ok.map((v) => `${v.volume}: ${(v.elapsedMs / 1000).toFixed(1)}s`);

  let text = `索引 ${files} 个文件${parts.length ? `（${parts.join('，')}）` : ''}`;
  if (failed.length) text += ` · ${failed.map((v) => `${v.volume}: 盘读取失败`).join('，')}`;
  if (unsupported.length) text += ` · 跳过非 NTFS：${unsupported.map((v) => v.volume).join('，')}`;

  els.statusIndex.textContent = text;
  els.statusIndex.style.color = failed.length ? 'var(--danger)' : files === 0 ? 'var(--warn)' : '';

  if (failed.length) {
    const detail = failed.map((v) => `${v.volume}: ${v.error}`).join('\n');
    els.statusIndex.title = detail;
    toast(`盘读取失败，索引不完整：\n${detail}`, 'error');
  } else if (files === 0) {
    els.statusIndex.title = '索引为空时“查备份”会把所有文件都判为无备份';
    toast(unsupported.length
      ? '所选盘符都不是 NTFS 格式，无法读取主文件表。请改选 NTFS 磁盘，或使用“只索引指定文件夹”模式。'
      : '索引里没有任何文件，“查备份”会全部显示为无备份。请先以管理员身份建立索引。', 'error');
  } else {
    els.statusIndex.title = unsupported.length
      ? `已跳过非 NTFS 盘符：${unsupported.map((v) => v.volume).join('、')}（这类盘没有主文件表）`
      : '';
    if (unsupported.length) {
      toast(`已跳过非 NTFS 盘符：${unsupported.map((v) => v.volume).join('、')}（这类盘无法用主文件表索引）`);
    }
  }
}

/* -------------------------------------------------------------- UI plumbing */

function rebuildMonthFilter() {
  const months = [...new Set(state.all.map((f) => f.month).filter(Boolean))].sort().reverse();
  els.monthFilter.replaceChildren(new Option('全部月份', ''));
  for (const m of months) els.monthFilter.append(new Option(m, m));
  if (state.month && !months.includes(state.month)) state.month = '';
  els.monthFilter.value = state.month;
}

/** Build the volume checkboxes from the drives the host actually reported. */
function buildVolumePicker(drives, selected) {
  els.volumePicker.replaceChildren();
  // Removable media (DriveType 2) is rarely a backup target but is still offered;
  // non-filesystem entries (optical, network) are skipped.
  const usable = drives.filter((d) => d.type === '3' || d.type === '2' || d.type === 3 || d.type === 2);
  for (const drive of usable) {
    const label = document.createElement('label');
    label.className = 'chk';
    label.title = drive.type === '3' || drive.type === 3 ? '本地固定磁盘' : '可移动磁盘';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = drive.letter;
    box.checked = selected.includes(drive.letter);
    box.addEventListener('change', () => {
      const picked = [...els.volumePicker.querySelectorAll('input:checked')].map((i) => i.value);
      api.saveSettings({ volumes: picked });
    });
    label.append(box, document.createTextNode(`${drive.letter}:`));
    els.volumePicker.append(label);
  }
  if (!usable.length) {
    const note = document.createElement('span');
    note.style.color = 'var(--fg-faint)';
    note.textContent = '（未检测到可用磁盘）';
    els.volumePicker.append(note);
  }
}

function selectBy(predicate) {
  state.selection.clear();
  for (const f of state.view) if (predicate(f)) state.selection.add(f.path);
  renderBody();
  updateSelectionInfo();
}

/** Render the configured backup-search folders for "folders" index mode. */
function renderFolderList() {
  const folders = state.settings?.fallbackFolders ?? [];
  els.folderList.replaceChildren();
  const folderMode = (state.settings?.searchScope ?? 'mft') === 'folders';
  els.folderList.classList.toggle('hidden', !folderMode);
  if (!folderMode) return;

  if (!folders.length) {
    const hint = document.createElement('span');
    hint.className = 'folder-hint';
    hint.textContent = '还没有选择文件夹。点“选择文件夹…”添加你要在其中查找备份的位置，然后建立索引。';
    els.folderList.append(hint);
    return;
  }
  for (const folder of folders) {
    const chip = document.createElement('span');
    chip.className = 'folder-chip';
    const label = document.createElement('span');
    label.textContent = folder;
    label.title = folder;
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = '移除这个文件夹';
    remove.addEventListener('click', async () => {
      const next = (state.settings.fallbackFolders ?? []).filter((f) => f !== folder);
      state.settings = await api.saveSettings({ fallbackFolders: next });
      renderFolderList();
      // A changed folder list invalidates the index.
      readiness.indexFiles = 0;
      readiness.indexProblem = '文件夹列表已变化，需要重建索引。';
      renderReadiness();
    });
    chip.append(label, remove);
    els.folderList.append(chip);
  }
}

/** Show the right index controls for the selected scope. */
function applyScopeUi(scope) {
  const folderMode = scope === 'folders';
  els.btnPickFolders.classList.toggle('hidden', !folderMode);
  els.volumePicker.classList.toggle('hidden', folderMode);
  els.btnIndex.textContent = folderMode ? '建立文件夹索引' : '建立全盘索引';
  renderFolderList();
}

/**
 * Render the three-step readiness panel.
 *
 * The single most confusing failure this tool can produce is "查备份 found
 * nothing", which is indistinguishable from "the index was empty". Making the
 * prerequisites explicit and colour-coded removes that ambiguity.
 */
function renderReadiness() {
  const set = (el, state, text) => {
    el.classList.remove('done', 'pending', 'blocked');
    el.classList.add(state);
    el.textContent = text;
  };

  set(els.readyFolder, readiness.folder ? 'done' : 'pending',
    readiness.folder ? '① 微信文件夹已扫描' : '① 选择微信文件夹并扫描');

  if (readiness.indexProblem) {
    set(els.readyIndex, 'blocked', '② 索引不可用');
  } else if (readiness.indexFiles > 0) {
    set(els.readyIndex, 'done', `② 索引已就绪（${readiness.indexFiles} 个文件）`);
  } else {
    set(els.readyIndex, 'pending', '② 建立备份索引');
  }

  if (readiness.matched === null) {
    set(els.readyMatch, readiness.indexFiles > 0 && readiness.folder ? 'pending' : 'pending',
      '③ 查备份');
  } else {
    set(els.readyMatch, 'done', `③ 已查备份（${readiness.matchedCount} 个找到备份）`);
  }

  if (readiness.indexProblem) {
    els.readyProblem.textContent = readiness.indexProblem;
    els.readyProblem.className = 'ready-problem error';
    els.readyProblem.classList.remove('hidden');
  } else {
    els.readyProblem.classList.add('hidden');
  }
}

function setDiagOutput(text) {
  els.diagOutput.textContent = text;
  els.diagOutput.classList.toggle('hidden', !text);
}

/** Update the readiness panel from a main-process state snapshot. */
function syncReadiness(snapshot) {
  if (!snapshot) return;
  if (snapshot.scan?.files?.length) readiness.folder = true;
  const stats = snapshot.index;
  readiness.indexFiles = stats?.files ?? 0;

  const failed = (stats?.volumes ?? []).filter((v) => v.error);
  if (!stats) {
    readiness.indexProblem = '';
  } else if (readiness.indexFiles === 0) {
    readiness.indexProblem = failed.length
      ? `索引为空：${failed.map((v) => `${v.volume}: 盘读取失败（${v.error}）`).join('；')}`
      : (snapshot.settings?.searchScope === 'folders'
        ? '索引为空：请确认已选择用于查找备份的文件夹，然后重建索引。'
        : '索引为空：未以管理员身份运行时读不到 NTFS 主文件表，请改用“只索引指定文件夹”模式。');
  } else if (failed.length) {
    readiness.indexProblem = `部分盘读取失败：${failed.map((v) => `${v.volume}: ${v.error}`).join('；')}`;
  } else {
    readiness.indexProblem = '';
  }
  renderReadiness();
}

/**
 * Render a structured error for the diagnostics panel.
 *
 * `lastError` is an object ({stage, message, name, code}); naive interpolation
 * prints "[object Object]", which hides the one line that matters.
 */
function formatError(err) {
  if (!err) return '(none)';
  if (typeof err === 'string') return err;
  const parts = [];
  if (err.stage) parts.push(`阶段=${err.stage}`);
  if (err.at) parts.push(`时间=${err.at}`);
  if (err.name) parts.push(`类型=${err.name}`);
  if (err.code) parts.push(`代码=${err.code}`);
  const head = parts.length ? `${parts.join(' ')}\n` : '';
  return `${head}消息=${err.message ?? JSON.stringify(err)}`;
}

/**
 * Run a self-check in the main process and print the raw results.
 *
 * Without this, a user hitting "建立索引失败" has to guess which of elevation,
 * drive selection, folder configuration, or a packaged-build path is at fault.
 */
async function runDiagnose() {
  els.btnDiagnose.disabled = true;
  setDiagOutput('正在自检…');
  try {
    const r = await api.selfTest();
    const lines = [];
    lines.push(`时间: ${new Date().toLocaleString()}`);
    lines.push(`管理员权限: ${r.elevated ? '是' : '否  ← 读 NTFS 主文件表需要它'}`);
    lines.push(`打包运行: ${r.appIsPackaged ? '是' : '否（开发模式）'}`);
    lines.push(`磁盘: ${(r.drives ?? []).map((d) => `${d.letter}:(类型${d.type})`).join(' ') || '未检测到'}`);
    for (const v of r.volumeAccess ?? []) {
      lines.push(`  ${v.letter}: ${v.ok
        ? `可读 (cluster=${v.clusterSize ?? v.boot?.clusterSize} record=${v.recordSize ?? v.boot?.recordSize})`
        : `不可读 → ${v.error}`}`);
    }

    if (r.paths) {
      lines.push('');
      lines.push('关键路径:');
      lines.push(`  MFT 助手: ${r.paths.helperScript ?? '(未知)'}`);
      lines.push(`    存在? ${r.paths.helperExists ? '是' : '否  ← 子进程读不了 asar，助手必须在 asar 外'}`);
      lines.push(`  Node 运行时: ${r.paths.nodeRuntime ?? '未找到  ← 需要它来读原始卷'}`);
      lines.push(`  删除脚本: ${r.paths.deleteScript ?? '(未知)'} (存在? ${r.paths.deleteScriptExists ? '是' : '否'})`);
      lines.push(`  资源目录: ${r.paths.resourcesPath ?? '(未知)'}`);
    }

    if (r.index) {
      lines.push('');
      lines.push(`当前索引: ${r.index.files} 个文件，桶 ${r.index.buckets}${r.index.engine ? `，引擎=${r.index.engine}` : ''}`);
      for (const v of r.index.volumes ?? []) {
        lines.push(`  盘 ${v.volume}: 文件=${v.files} 记录=${v.records} 用时=${v.elapsedMs}ms`
          + `${v.engine ? ` 引擎=${v.engine}` : ''}${v.error ? ` 错误=${v.error}` : ''}`);
      }
    }
    if (r.searchScope === 'folders') {
      lines.push('');
      lines.push(`文件夹索引模式，已选 ${r.fallbackFolders?.length ?? 0} 个文件夹：`);
      for (const f of r.fallbackFolders ?? []) lines.push(`  ${f}`);
    }
    if (r.lastError) {
      lines.push('');
      lines.push('最近一次错误:');
      lines.push(`  ${formatError(r.lastError)}`);
    }
    if (r.logFile) {
      lines.push('');
      lines.push(`完整日志: ${r.logFile}`);
    }
    setDiagOutput(lines.join('\n'));
    els.logOutput.classList.add('hidden');
  } catch (err) {
    setDiagOutput(`自检失败: ${err.message}`);
  } finally {
    els.btnDiagnose.disabled = false;
  }
}

/**
 * Show the program's logs in-app.
 *
 * This exists because diagnosing a problem on another machine previously meant
 * going to find `%APPDATA%\...\logs\app.log` on that machine — not somewhere a user
 * can be expected to look, and the source of "I can't give you the error" more than
 * once. The log now also travels next to the program, and this shows every
 * destination from inside the app.
 */
async function viewLogs() {
  els.btnViewLog.disabled = true;
  setLogOutput('正在读取日志…');
  try {
    const result = await api.readLogs();
    const sources = result?.sources ?? [];
    if (!sources.length) {
      setLogOutput('没有找到日志文件。\n\n'
        + '可能原因：日志目录不可写（比如程序放在 Program Files 下）。\n'
        + `检查的目录：\n${(result?.dirs ?? []).join('\n') || '(无)'}`);
      return;
    }
    const blocks = sources.map((source) => {
      const lines = source.text.split('\n');
      // Only the tail is useful for orientation; the whole file would flood the
      // panel after a long session.
      return `===== ${source.file} =====\n${lines.slice(-400).join('\n')}`;
    });
    setLogOutput(blocks.join('\n\n'));
  } catch (err) {
    setLogOutput(`读取日志失败：${err.message}`);
  } finally {
    els.btnViewLog.disabled = false;
  }
}

function setLogOutput(text) {
  els.logOutput.textContent = text;
  const empty = !text;
  els.logOutput.classList.toggle('hidden', empty);
  // Keep the two diagnostic panels from competing for the same space.
  if (!empty) els.diagOutput.classList.add('hidden');
}

/**
 * Apply a colour theme.
 *
 * The whole palette lives in CSS variables, so switching is one attribute on
 * `<html>`. The button label always names the theme it will switch TO, which is
 * less ambiguous than showing the current one.
 *
 * @param {'dark'|'light'} theme
 */
function applyTheme(theme) {
  const resolved = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
  state.theme = resolved;
  if (els.btnTheme) els.btnTheme.textContent = resolved === 'light' ? '深色' : '浅色';
}

/** Switch to the other theme and remember the choice. */
function toggleTheme() {
  const next = state.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  api.saveSettings({ theme: next });
  toast(`已切换到${next === 'light' ? '浅色' : '深色'}主题`, 'ok');
}

function wireEvents() {
  $('btn-browse').addEventListener('click', async () => {
    const picked = await api.pickFolder(els.folderPath.value.trim());
    if (picked) {
      els.folderPath.value = picked;
      api.saveSettings({ lastFolder: picked });
    }
  });

  els.btnScan.addEventListener('click', runScan);
  els.btnIndex.addEventListener('click', runIndex);

  els.scopeSelect.addEventListener('change', async () => {
    state.settings = await api.saveSettings({ searchScope: els.scopeSelect.value });
    applyScopeUi(els.scopeSelect.value);
    if (els.scopeSelect.value === 'folders') {
      toast('已切换到文件夹索引模式：需要先选择文件夹，再建立索引。');
    }
    // Changing the index source invalidates whatever index existed.
    readiness.indexFiles = 0;
    readiness.indexProblem = '';
    readiness.matched = null;
    renderReadiness();
  });

  els.btnDiagnose.addEventListener('click', runDiagnose);
  els.btnTheme.addEventListener('click', toggleTheme);
  els.btnViewLog.addEventListener('click', viewLogs);
  els.btnOpenLog.addEventListener('click', async () => {
    const file = await api.revealLog();
    toast(file ? `日志位置：${file}` : '没有找到日志文件');
  });

  els.btnPickFolders.addEventListener('click', async () => {
    const picked = await api.pickFolders();
    if (!picked?.length) return;
    const merged = [...new Set([...(state.settings.fallbackFolders ?? []), ...picked])];
    state.settings = await api.saveSettings({ fallbackFolders: merged });
    renderFolderList();

    // Adding a folder has to rebuild the index, otherwise "查备份" keeps using
    // the old (possibly empty) index and the newly added location appears to be
    // ignored. Do it automatically rather than relying on the user to click again.
    if (els.scopeSelect.value !== 'folders') {
      els.scopeSelect.value = 'folders';
      state.settings = await api.saveSettings({ searchScope: 'folders' });
      applyScopeUi('folders');
    }
    toast(`已添加 ${picked.length} 个文件夹，正在重建索引…`, 'ok');
    await runIndex();
  });
  els.btnMatch.addEventListener('click', () => runMatch());
  $('btn-verify-visible').addEventListener('click', () => {
    const paths = state.view.map((f) => f.path);
    if (!paths.length) { toast('当前列表为空', 'error'); return; }
    runMatch(paths);
  });
  $('btn-delete').addEventListener('click', runDelete);
  els.btnCancel.addEventListener('click', async () => {
    await api.cancel();
    toast('已请求取消，正在收尾…');
  });

  $('btn-select-all').addEventListener('click', () => {
    state.selection = new Set(state.view.map((f) => f.path));
    renderBody(); updateSelectionInfo();
  });
  $('btn-select-none').addEventListener('click', () => {
    state.selection.clear();
    renderBody(); updateSelectionInfo();
  });
  $('btn-invert').addEventListener('click', () => {
    const next = new Set();
    for (const f of state.view) if (!state.selection.has(f.path)) next.add(f.path);
    state.selection = next;
    renderBody(); updateSelectionInfo();
  });
  $('btn-select-backed').addEventListener('click', () => selectBy((f) => f.backupCount > 0));
  $('btn-select-no-backup').addEventListener('click', () => selectBy((f) => f.backupChecked && f.backupCount === 0));

  els.search.addEventListener('input', () => {
    state.search = els.search.value;
    applyFilters();
  });
  els.kindFilter.addEventListener('change', () => { state.kind = els.kindFilter.value; applyFilters(); });
  els.monthFilter.addEventListener('change', () => { state.month = els.monthFilter.value; applyFilters(); });
  els.chkSize.addEventListener('change', () => {
    els.minSize.disabled = !els.chkSize.checked;
    state.minBytes = els.chkSize.checked ? (Number(els.minSize.value) || 0) * 1024 * 1024 : 0;
    applyFilters();
  });
  els.minSize.addEventListener('input', () => {
    if (!els.chkSize.checked) return;
    state.minBytes = (Number(els.minSize.value) || 0) * 1024 * 1024;
    applyFilters();
  });
  els.chkVerify.addEventListener('change', () => api.saveSettings({ verifyHash: els.chkVerify.checked }));
  els.deleteMode.addEventListener('change', () => {
    api.saveSettings({ deleteMode: els.deleteMode.value });
    if (els.deleteMode.value === 'permanent') {
      toast('已切换到永久删除，操作无法撤销', 'error');
    }
  });

  for (const seg of document.querySelectorAll('.seg')) {
    seg.addEventListener('click', () => {
      document.querySelectorAll('.seg').forEach((s) => s.classList.remove('active'));
      seg.classList.add('active');
      state.filterView = seg.dataset.view;
      applyFilters();
    });
  }

  els.tbodyScroll.addEventListener('scroll', () => {
    // Keep the absolutely-positioned header in sync with horizontal scrolling.
    els.thead.style.transform = `translateX(${-els.tbodyScroll.scrollLeft}px)`;
    renderBody();
  });

  $('popover-close').addEventListener('click', hidePopover);
  document.addEventListener('mousedown', (ev) => {
    if (els.popover.classList.contains('hidden')) return;
    if (els.popover.contains(ev.target)) return;
    if (ev.target?.dataset?.action === 'show-backups') return;
    hidePopover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { hidePopover(); return; }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (typing) return;

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!state.view.length) return;
      const delta = ev.key === 'ArrowDown' ? 1 : -1;
      const next = Math.min(Math.max(0, state.cursor + delta), state.view.length - 1);
      state.cursor = next;
      if (ev.shiftKey && state.anchor >= 0) selectRange(state.anchor, next, false);
      else { state.selection.clear(); state.selection.add(state.view[next].path); state.anchor = next; }
      scrollRowIntoView(next);
      renderBody(); updateSelectionInfo();
      return;
    }
    if (ev.key === ' ') {
      ev.preventDefault();
      const row = state.view[state.cursor];
      if (row) { toggleSelection(row.path); state.anchor = state.cursor; renderBody(); updateSelectionInfo(); }
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      state.selection = new Set(state.view.map((f) => f.path));
      renderBody(); updateSelectionInfo();
      return;
    }
    if (ev.ctrlKey && ev.key.toLowerCase() === 'c') {
      const row = state.view[state.cursor];
      if (row) { navigator.clipboard.writeText(row.path); toast('已复制文件路径', 'ok'); }
      return;
    }
    if (ev.key === 'Delete') {
      ev.preventDefault();
      runDelete();
      return;
    }
    if (ev.key === 'F5') {
      ev.preventDefault();
      runScan();
    }
  });

  // Ctrl+wheel zooms the row height, which is handy on dense folders.
  els.tbodyScroll.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    const current = Number(getComputedStyle(document.documentElement).getPropertyValue('--row-h').replace('px', '')) || ROW_HEIGHT;
    const next = Math.min(48, Math.max(18, current + (ev.deltaY < 0 ? 2 : -2)));
    document.documentElement.style.setProperty('--row-h', `${next}px`);
  }, { passive: false });

  new ResizeObserver(() => { renderHeader(); renderBody(); }).observe(els.tbodyScroll);

  window.addEventListener('resize', hidePopover);
}

function scrollRowIntoView(index) {
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  const viewTop = els.tbodyScroll.scrollTop;
  const viewBottom = viewTop + els.tbodyScroll.clientHeight;
  if (top < viewTop) els.tbodyScroll.scrollTop = top;
  else if (bottom > viewBottom) els.tbodyScroll.scrollTop = bottom - els.tbodyScroll.clientHeight;
}

function wireProgress() {
  api.onScanProgress((p) => {
    if (p.phase === 'walking') {
      showProgress(`正在枚举… 已发现 ${p.files ?? 0} 个文件（已进入 ${p.dirsSeen ?? 0} 个目录）`, null);
    } else if (p.phase === 'done') {
      showProgress(`扫描完成：${p.files} 个文件，发送件 ${p.sent} 个`, 1);
    }
  });
  api.onIndexProgress((p) => {
    if (p.phase === 'enumerate' && p.totalRecords) {
      showProgress(`读取 ${p.volume}: 主文件表 ${p.recordsRead} / ${p.totalRecords} 条记录`, p.recordsRead / p.totalRecords);
    } else if (p.phase === 'volume-done') {
      showProgress(`${p.volume}: 盘完成，索引 ${p.files} 个文件（${(p.elapsedMs / 1000).toFixed(1)} 秒）`, 1);
    } else if (p.phase === 'done') {
      showProgress(`索引完成：共 ${p.files} 个文件`, 1);
      updateIndexStatus(p);
    } else if (p.phase === 'walk') {
      showProgress(`遍历目录… 已索引 ${p.files ?? 0} 个文件`, null);
    }
  });
  api.onMatchProgress((p) => {
    if (p.phase === 'start') showProgress(`正在比对 ${p.total} 个文件的备份…`, 0);
    else if (p.phase === 'hashing') showProgress(`哈希校验中 ${p.done} / ${p.total}`, p.total ? p.done / p.total : null);
    else if (p.phase === 'done') showProgress(`比对完成：${p.withBackup} / ${p.total} 个文件找到备份`, 1);
  });
}

/** Detect the fixed drives so the volume picker reflects reality. */
function loadVolumes(drives, selected) {
  buildVolumePicker(drives ?? [], selected ?? []);
}

/* -------------------------------------------------------------- bootstrap */

async function boot() {
  wireEvents();
  wireProgress();

  let snapshot;
  try {
    snapshot = await api.getState();
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'error');
    return;
  }

  state.settings = snapshot.settings;
  // Applied before anything else so the first paint is already themed.
  applyTheme(snapshot.settings.theme);
  els.chkRecursive.checked = snapshot.settings.recursive !== false;
  els.chkVerify.checked = snapshot.settings.verifyHash !== false;
  els.deleteMode.value = snapshot.settings.deleteMode ?? 'recycle';
  if (snapshot.settings.lastFolder) els.folderPath.value = snapshot.settings.lastFolder;

  if (!snapshot.elevated) els.elevationBanner.classList.remove('hidden');
  $('btn-relaunch').addEventListener('click', async () => {
    toast('正在请求管理员权限…');
    await api.relaunchElevated();
  });

  await loadVolumes(snapshot.drives, snapshot.settings.volumes ?? ['C', 'D']);
  els.scopeSelect.value = snapshot.settings.searchScope ?? 'mft';
  applyScopeUi(els.scopeSelect.value);
  updateIndexStatus(snapshot.index);

  // Without elevation the MFT path cannot work at all. Defaulting to it would
  // present a broken mode as the primary one, so switch to the folder path (which
  // needs no elevation) and say why. The user can still switch back deliberately.
  if (!snapshot.elevated && els.scopeSelect.value === 'mft') {
    els.scopeSelect.value = 'folders';
    state.settings = await api.saveSettings({ searchScope: 'folders' });
    applyScopeUi('folders');
    toast(
      '未以管理员身份运行：整盘索引不可用，已切换到“只索引指定文件夹”模式。\n'
      + '请点“选择文件夹…”添加你要查找备份的位置，之后会自动建立索引。',
      'error',
    );
  }

  if (snapshot.scan) {
    state.all = snapshot.scan.files;
    rebuildMonthFilter();
    applyFilters();
    toast(`已恢复上次扫描结果：${snapshot.scan.summary.files} 个文件`, 'ok');
  } else {
    renderHeader();
    applyFilters();
  }

  // The index lives in the main process, so after a window reload the renderer
  // would otherwise show files with no way to know an index still exists.
  if (snapshot.index?.files) {
    toast(`已有索引：${snapshot.index.files} 个文件，可直接点“查备份”`, 'ok');
  }

  // Reflect the real prerequisite state, and say so out loud when the chosen
  // mode cannot work in this process (no elevation => no MFT access).
  syncReadiness(snapshot);
  if (readiness.indexProblem) {
    setDiagOutput([
      '检测到索引问题：',
      `  ${readiness.indexProblem}`,
      '',
      '可点“自检”查看逐项结果。若提示读不到主文件表，请以管理员身份重启，',
      '或把上方“备份索引”切换为“只索引指定文件夹”。',
    ].join('\n'));
  }

  els.statusLeft.textContent = '就绪';
}

boot();
