/**
 * Verify the theme switch really repaints.
 *
 * Checking the `data-theme` attribute alone would pass even if a stylesheet rule
 * were misnamed and nothing changed visually. This reads the computed background and
 * text colours of the real elements before and after the switch and requires them to
 * differ, and it checks that the light theme is actually light (a high-luminance
 * background with dark text) rather than merely different.
 *
 * Usage: electron.exe tools/probe-theme.cjs
 */
const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

// Derived from this script's location: hardcoding the checkout path would leak the
// layout of a private machine into a public repository.
const ROOT = join(__dirname, '..');

const out = (s) => process.stdout.write(`THEME ${s}\n`);
let failures = 0;
const check = (label, ok, detail = '') => {
  out(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

app.whenReady().then(async () => {
  try {
    await import(`file:///${join(ROOT, 'src', 'main', 'main.js').replace(/\\/g, '/')}`);
    let win = null;
    for (let i = 0; i < 80 && !win; i++) {
      win = BrowserWindow.getAllWindows()[0] ?? null;
      if (!win) await new Promise((r) => setTimeout(r, 250));
    }
    check('a window was created', Boolean(win));
    if (!win) { app.exit(1); return; }
    win.show();
    await new Promise((r) => setTimeout(r, 1800));
    const api = (e) => win.webContents.executeJavaScript(e, true);

    /** Perceived luminance of a computed rgb()/rgba() colour. */
    const LUM = `(css) => {
      const m = String(css).match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)/);
      if (!m) return null;
      return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
    }`;

    // Sample the colours that carry the theme.
    const sample = `(() => {
      const lum = ${LUM};
      const body = getComputedStyle(document.body);
      const cell = document.querySelector('#tbody td') || document.body;
      return {
        theme: document.documentElement.dataset.theme || '(unset)',
        buttonLabel: document.getElementById('btn-theme')?.textContent ?? '',
        bodyBg: body.backgroundColor,
        bodyFg: body.color,
        bodyBgLum: lum(body.backgroundColor),
        bodyFgLum: lum(body.color),
        cellBorder: getComputedStyle(cell).borderBottomColor,
      };
    })()`;

    const dark = await api(sample);
    out(`dark  : theme=${dark.theme} bg=${dark.bodyBg} (lum ${dark.bodyBgLum?.toFixed(2)}) fg=${dark.bodyFg} (lum ${dark.bodyFgLum?.toFixed(2)}) button="${dark.buttonLabel}"`);
    check('the app reports a theme', dark.theme === 'dark' || dark.theme === 'light', dark.theme);
    check('the toggle button names the other theme',
      dark.buttonLabel === '浅色' || dark.buttonLabel === '深色', dark.buttonLabel);

    // Click the toggle in the real UI.
    await api(`document.getElementById('btn-theme').click()`);
    await new Promise((r) => setTimeout(r, 600));
    const light = await api(sample);
    out(`after : theme=${light.theme} bg=${light.bodyBg} (lum ${light.bodyBgLum?.toFixed(2)}) fg=${light.bodyFg} (lum ${light.bodyFgLum?.toFixed(2)}) button="${light.buttonLabel}"`);

    check('the theme actually switched', light.theme !== dark.theme, `${dark.theme} -> ${light.theme}`);
    check('the background colour changed', light.bodyBg !== dark.bodyBg, `${dark.bodyBg} -> ${light.bodyBg}`);
    check('the text colour changed', light.bodyFg !== dark.bodyFg, `${dark.bodyFg} -> ${light.bodyFg}`);
    check('the button label flipped', light.buttonLabel !== dark.buttonLabel,
      `${dark.buttonLabel} -> ${light.buttonLabel}`);

    // The light theme must be genuinely light: pale background, dark text.
    const lightIsLight = light.bodyBgLum > 0.8 && light.bodyFgLum < 0.4;
    check('the light theme is light on dark text', lightIsLight,
      `bg lum ${light.bodyBgLum?.toFixed(2)}, fg lum ${light.bodyFgLum?.toFixed(2)}`);
    const darkIsDark = dark.bodyBgLum < 0.25;
    if (dark.theme === 'dark') {
      check('the dark theme is dark', darkIsDark, `bg lum ${dark.bodyBgLum?.toFixed(2)}`);
    }

    // Switch back and confirm it round-trips.
    await api(`document.getElementById('btn-theme').click()`);
    await new Promise((r) => setTimeout(r, 500));
    const back = await api(sample);
    check('switching back restores the original theme', back.theme === dark.theme, back.theme);
    check('switching back restores the original background', back.bodyBg === dark.bodyBg,
      `${dark.bodyBg} -> ${back.bodyBg}`);

    // The choice must persist so the next launch starts in the chosen theme.
    const saved = await api(`(async () => {
      const s = await window.cleaner.getState();
      return s.settings.theme ?? null;
    })()`);
    out(`persisted theme setting: ${JSON.stringify(saved)}`);
    check('the choice is persisted', saved === dark.theme, String(saved));
  } catch (err) {
    check('probe ran without errors', false, err.message);
  }
  out(failures === 0 ? 'RESULT ALL PASSED' : `RESULT ${failures} FAILED`);
  app.exit(failures === 0 ? 0 : 1);
});
