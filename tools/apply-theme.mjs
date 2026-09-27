/**
 * Variableise the renderer's colours and add a light theme.
 *
 * The stylesheet already used CSS variables for the base palette, but a long tail
 * of literal hex values (chips, buttons, shadows, hovers) was hardcoded. Those are
 * extracted into semantic variables first, so the light theme only has to override
 * one block instead of chasing literals through the file.
 *
 * Usage: node tools/apply-theme.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '..', 'src', 'renderer', 'styles.css');
let css = readFileSync(cssPath, 'utf8');

if (css.includes('--chip-sent-bg')) {
  process.stdout.write('already themed; nothing to do\n');
  process.exit(0);
}

/** Replacements, longest/most specific first so no prefix matches first. */
const replacements = [
  // Banner
  ['#3a2e12', 'var(--warn-bg)'],
  ['#5c4a1c', 'var(--warn-border)'],
  ['#241a05', 'var(--warn-icon-fg)'],
  ['#d8c48a', 'var(--warn-fg)'],
  // Brand mark keeps its own greens
  ['#06240f', 'var(--brand-mark-fg)'],
  // Diagnostic panel
  ['#0b0e13', 'var(--bg-code)'],
  // Buttons
  ['#44506a', 'var(--border-hover)'],
  ['#6fb0ff', 'var(--accent-bright)'],
  ['#6d2622', 'var(--danger-bg)'],
  ['#8f3630', 'var(--danger-border)'],
  ['#ffd9d6', 'var(--danger-fg)'],
  ['#83302a', 'var(--danger-bg-hover)'],
  ['#6b5313', 'var(--warn-btn-bg)'],
  ['#916f1c', 'var(--warn-btn-border)'],
  ['#ffeec4', 'var(--warn-btn-fg)'],
  ['#3f7ad0', 'var(--accent-border)'],
  ['#eaf2ff', 'var(--accent-fg)'],
  ['#3470c4', 'var(--accent-hover)'],
  // Progress
  ['#12182150', 'var(--progress-bg)'],
  ['#232a36', 'var(--progress-track)'],
  // Action bar and table chrome
  ['#131820', 'var(--bg-bar)'],
  ['#bcd6ff', 'var(--th-sorted)'],
  ['#1a1f28', 'var(--grid-line)'],
  ['#1a212c', 'var(--row-hover)'],
  ['#24466c', 'var(--row-selected-hover)'],
  // Chips
  ['#1d3a2a', 'var(--chip-sent-bg)'],
  ['#7ee2ab', 'var(--chip-sent-fg)'],
  ['#2c5a40', 'var(--chip-sent-border)'],
  ['#2a3346', 'var(--chip-received-bg)'],
  ['#9fb4d6', 'var(--chip-received-fg)'],
  ['#3a465e', 'var(--chip-received-border)'],
  ['#2c2a22', 'var(--chip-unknown-bg)'],
  ['#cbbd8e', 'var(--chip-unknown-fg)'],
  ['#443f2c', 'var(--chip-unknown-border)'],
  ['#14372a', 'var(--chip-confirmed-bg)'],
  ['#58d69d', 'var(--chip-confirmed-fg)'],
  ['#235c45', 'var(--chip-confirmed-border)'],
  ['#33301c', 'var(--chip-candidate-bg)'],
  ['#d8c56a', 'var(--chip-candidate-fg)'],
  ['#514a26', 'var(--chip-candidate-border)'],
  ['#2a2028', 'var(--chip-none-bg)'],
  ['#b58f9c', 'var(--chip-none-fg)'],
  ['#453039', 'var(--chip-none-border)'],
  ['#22262f', 'var(--chip-unchecked-bg)'],
  ['#7e8798', 'var(--chip-unchecked-fg)'],
  ['#333944', 'var(--chip-unchecked-border)'],
  ['#3a2a1c', 'var(--chip-unverified-bg)'],
  ['#e0a86a', 'var(--chip-unverified-fg)'],
  ['#5a4128', 'var(--chip-unverified-border)'],
  // Links
  ['#8fb8f0', 'var(--link)'],
  ['#b9d4ff', 'var(--link-hover)'],
  // Popover
  ['#0009', 'var(--shadow-popover)'],
  ['#1b212b', 'var(--bg-popover-head)'],
  ['#cfe0f7', 'var(--fg-path)'],
  // Modal and toast
  ['#000a', 'var(--overlay)'],
  ['#000b', 'var(--shadow-modal)'],
  ['#20262f', 'var(--toast-bg)'],
  ['#0008', 'var(--shadow-toast)'],
  ['#2f1c1a', 'var(--toast-error-bg)'],
  ['#ffcac6', 'var(--toast-error-fg)'],
  ['#14261d', 'var(--toast-ok-bg)'],
  ['#b6f0d2', 'var(--toast-ok-fg)'],
];

for (const [literal, variable] of replacements) {
  css = css.split(literal).join(variable);
}

/** Dark palette: the original values, now named. */
const darkVars = `
  /* Semantic colours extracted from literals so a second theme can override them. */
  --bg-code: #0b0e13;
  --bg-bar: #131820;
  --bg-popover-head: #1b212b;
  --toast-bg: #20262f;
  --toast-error-bg: #2f1c1a;
  --toast-error-fg: #ffcac6;
  --toast-ok-bg: #14261d;
  --toast-ok-fg: #b6f0d2;
  --overlay: #000a;
  --shadow-popover: 0 12px 34px #0009;
  --shadow-modal: 0 18px 48px #000b;
  --shadow-toast: 0 8px 24px #0008;
  --brand-mark-fg: #06240f;
  --border-hover: #44506a;
  --accent-bright: #6fb0ff;
  --accent-border: #3f7ad0;
  --accent-fg: #eaf2ff;
  --accent-hover: #3470c4;
  --danger-bg: #6d2622;
  --danger-bg-hover: #83302a;
  --danger-border: #8f3630;
  --danger-fg: #ffd9d6;
  --warn-bg: #3a2e12;
  --warn-border: #5c4a1c;
  --warn-fg: #d8c48a;
  --warn-icon-fg: #241a05;
  --warn-btn-bg: #6b5313;
  --warn-btn-border: #916f1c;
  --warn-btn-fg: #ffeec4;
  --progress-bg: #12182150;
  --progress-track: #232a36;
  --th-sorted: #bcd6ff;
  --grid-line: #1a1f28;
  --row-hover: #1a212c;
  --row-selected-hover: #24466c;
  --link: #8fb8f0;
  --link-hover: #b9d4ff;
  --fg-path: #cfe0f7;
  --chip-sent-bg: #1d3a2a;
  --chip-sent-fg: #7ee2ab;
  --chip-sent-border: #2c5a40;
  --chip-received-bg: #2a3346;
  --chip-received-fg: #9fb4d6;
  --chip-received-border: #3a465e;
  --chip-unknown-bg: #2c2a22;
  --chip-unknown-fg: #cbbd8e;
  --chip-unknown-border: #443f2c;
  --chip-confirmed-bg: #14372a;
  --chip-confirmed-fg: #58d69d;
  --chip-confirmed-border: #235c45;
  --chip-candidate-bg: #33301c;
  --chip-candidate-fg: #d8c56a;
  --chip-candidate-border: #514a26;
  --chip-none-bg: #2a2028;
  --chip-none-fg: #b58f9c;
  --chip-none-border: #453039;
  --chip-unchecked-bg: #22262f;
  --chip-unchecked-fg: #7e8798;
  --chip-unchecked-border: #333944;
  --chip-unverified-bg: #3a2a1c;
  --chip-unverified-fg: #e0a86a;
  --chip-unverified-border: #5a4128;
`;

/** Light palette: same roles, tuned for a white background. */
const lightTheme = `
/* ---------- light theme ---------- */

[data-theme="light"] {
  --bg: #f2f4f7;
  --bg-raised: #ffffff;
  --bg-input: #ffffff;
  --bg-hover: #eaeef4;
  --bg-selected: #d6e6fb;
  --border: #d8dee7;
  --border-strong: #c2cbd8;
  --border-hover: #a9b6c7;
  --fg: #1d2430;
  --fg-dim: #5a6675;
  --fg-faint: #8593a3;
  --accent: #1d6fe0;
  --accent-dim: #dbe9fd;
  --accent-border: #a9c9f5;
  --accent-fg: #12457f;
  --accent-hover: #cfe1fb;
  --accent-bright: #3d8bfd;
  --ok: #14875a;
  --warn: #b8791a;
  --danger: #c0392f;

  --bg-code: #f7f9fb;
  --bg-bar: #fafbfd;
  --bg-popover-head: #f4f6f9;
  --toast-bg: #ffffff;
  --toast-error-bg: #fdecea;
  --toast-error-fg: #8c2b23;
  --toast-ok-bg: #e8f8ef;
  --toast-ok-fg: #12603f;
  --overlay: #1d243055;
  --shadow-popover: 0 12px 30px #1d243026;
  --shadow-modal: 0 18px 42px #1d243033;
  --shadow-toast: 0 8px 22px #1d243020;
  --brand-mark-fg: #06240f;

  --danger-bg: #fbe3e1;
  --danger-bg-hover: #f7d3d0;
  --danger-border: #e2a9a3;
  --danger-fg: #8c2b23;
  --warn-bg: #fdf3de;
  --warn-border: #e6cd97;
  --warn-fg: #7a5714;
  --warn-icon-fg: #3a2a06;
  --warn-btn-bg: #fdf3de;
  --warn-btn-border: #e6cd97;
  --warn-btn-fg: #7a5714;

  --progress-bg: #f2f4f780;
  --progress-track: #e2e7ee;
  --th-sorted: #12457f;
  --grid-line: #e9edf3;
  --row-hover: #eff3f8;
  --row-selected-hover: #c3dcfa;

  --link: #1d6fe0;
  --link-hover: #12457f;
  --fg-path: #1d4e8a;

  --chip-sent-bg: #e2f6eb;
  --chip-sent-fg: #106b45;
  --chip-sent-border: #a9dfc4;
  --chip-received-bg: #e8eef8;
  --chip-received-fg: #3b506f;
  --chip-received-border: #c3d1e5;
  --chip-unknown-bg: #f6f1e2;
  --chip-unknown-fg: #6f5717;
  --chip-unknown-border: #ddcf9f;
  --chip-confirmed-bg: #e2f6eb;
  --chip-confirmed-fg: #0f6b44;
  --chip-confirmed-border: #a6dec2;
  --chip-candidate-bg: #f8f2dd;
  --chip-candidate-fg: #7a5c11;
  --chip-candidate-border: #e0cf94;
  --chip-none-bg: #f6ecef;
  --chip-none-fg: #8a4a5a;
  --chip-none-border: #e3c4cd;
  --chip-unchecked-bg: #eef1f5;
  --chip-unchecked-fg: #64707f;
  --chip-unchecked-border: #d5dbe3;
  --chip-unverified-bg: #fbf0e2;
  --chip-unverified-fg: #8a5314;
  --chip-unverified-border: #ecd0a8;
}
`;

// Insert the semantic variables at the end of the :root block.
css = css.replace(/\n\}\n/, `${darkVars}}\n`);
css += lightTheme;

writeFileSync(cssPath, css, 'utf8');

const remaining = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
  .map((m) => m[0])
  .filter((value) => !css.includes(`: ${value};`));
process.stdout.write(`themed stylesheet written (${css.length} bytes)\n`);
process.stdout.write(`literals not declared as a variable: ${remaining.length ? [...new Set(remaining)].join(', ') : '(none)'}\n`);
