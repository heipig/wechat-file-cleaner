/**
 * Preload bridge: the only channel between the sandboxed renderer and the host.
 *
 * CommonJS on purpose — Electron loads sandboxed preloads as CJS, and `require`
 * is the only module system available there.
 *
 * Every exposed method is a thin wrapper over a named IPC channel; the renderer
 * never sees `ipcRenderer` itself.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Wrap a channel so renderer code calls a plain async function. */
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

/** Subscribe to a main-process stream; returns an unsubscribe function. */
function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('cleaner', {
  // --- state ---
  getState: call('app:state'),
  saveSettings: call('app:settings'),

  // --- picking folders ---
  pickFolder: call('dialog:pickFolder'),
  pickFolders: call('dialog:pickFolders'),

  // --- pipeline ---
  startScan: call('scan:start'),
  buildIndex: call('index:build'),
  startMatch: call('match:start'),
  cancel: call('task:cancel'),

  // --- acting on files ---
  deleteFiles: call('files:delete'),
  openFolder: call('shell:openFolder'),
  reveal: call('shell:reveal'),
  statFile: call('file:stat'),

  // --- diagnostics ---
  relaunchElevated: call('app:relaunchElevated'),
  selfTest: call('self:test'),
  /** Read every log file for the in-app viewer. */
  readLogs: call('log:read'),
  /** Reveal the primary log in Explorer. */
  revealLog: call('log:reveal'),

  /**
   * Diagnostic logging from the renderer.
   *
   * The renderer has no filesystem access and `console.log` is invisible in a
   * packaged build, so without this a renderer-side problem is undiagnosable.
   * Synchronous on purpose: a line written immediately before a fatal error must
   * reach disk before the page goes away.
   */
  log: (tag, message) => {
    try {
      ipcRenderer.sendSync('renderer:log', String(tag ?? 'renderer'), String(message ?? ''));
    } catch {
      /* logging must never break the caller */
    }
  },

  // --- progress streams ---
  onScanProgress: (handler) => on('scan:progress', handler),
  onIndexProgress: (handler) => on('index:progress', handler),
  onMatchProgress: (handler) => on('match:progress', handler),
});
