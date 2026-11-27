/**
 * Builds the cuttingfloor mark (packages/engine/assets/mark/card.png): one translucent card,
 * drawn as HTML and rendered to an alpha PNG by headless Chrome. burnMark bounces it around the
 * picture. The image never runs this; it ships what this wrote.
 *
 *   node packages/engine/scripts/build-mark.ts --font-dir <dir with Archivo_800ExtraBold.ttf and
 *     Archivo_600SemiBold.ttf> [--chrome <path>] [--work <dir>]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'font-dir': { type: 'string' },
    chrome: {
      type: 'string',
      default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    },
    work: { type: 'string' },
  },
});
const fontDir = values['font-dir'];
if (!fontDir) throw new Error('--font-dir is required (Archivo ExtraBold and SemiBold TTFs)');

const OUT = new URL('../assets/mark/', import.meta.url).pathname;
const work = values.work ?? mkdtempSync(join(tmpdir(), 'cf-mark-'));
mkdirSync(OUT, { recursive: true });
mkdirSync(work, { recursive: true });

// The brand, as on the cards: Archivo, the cut-square mark, warm white ink, the site's green.
const INK = '#F7F4EE';
const DIM = 'rgba(247,244,238,0.72)';
const GREEN = '#2BD665';
const MARK = `<svg viewBox="0 0 32 32"><path d="M4.4 4.4H24.4L4.4 24.4Z" fill="${GREEN}"/><path d="M27.6 7.6V27.6H7.6Z" fill="${INK}"/></svg>`;

// Drawn large and scaled down at marking. Its own opacity is the card's: a dark glass the
// picture shows through, and type a step brighter, so it reads on any footage without hiding it.
const WIDTH = 1200;
const HEIGHT = 440;
const page = join(work, 'card.html');
writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Archivo; font-weight: 800; src: url("${pathToFileURL(join(fontDir, 'Archivo_800ExtraBold.ttf')).href}"); }
@font-face { font-family: Archivo; font-weight: 600; src: url("${pathToFileURL(join(fontDir, 'Archivo_600SemiBold.ttf')).href}"); }
html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; background: transparent; overflow: hidden; font-family: Archivo; color: ${INK}; }
.card { box-sizing: border-box; position: absolute; inset: 10px; border-radius: 56px; padding: 44px 60px;
  background: linear-gradient(135deg, rgba(8,10,9,0.58), rgba(8,10,9,0.42));
  border: 3px solid rgba(247,244,238,0.28); display: flex; flex-direction: column; justify-content: center; gap: 14px; }
.lockup { display: flex; align-items: center; gap: 14px; font-weight: 800; font-size: 44px; letter-spacing: -0.02em; }
.lockup svg { width: 52px; height: 52px; }
h1 { margin: 0; font-weight: 800; font-size: 92px; line-height: 1; letter-spacing: -0.035em; }
.url { font-weight: 800; font-size: 72px; line-height: 1; color: ${GREEN}; letter-spacing: -0.02em; }
.apps { font-weight: 600; font-size: 30px; color: ${DIM}; letter-spacing: 0.01em; }
</style><div class="card">
<div class="lockup">${MARK}<span>cuttingfloor</span></div>
<h1>AI video editing, solved.</h1>
<div class="url">cuttingfloor.ai</div>
<div class="apps">MCP api.cuttingfloor.ai/mcp &nbsp;·&nbsp; Works in ChatGPT · Claude · Kazi</div>
</div>`,
);
execFileSync(values.chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--default-background-color=00000000',
  '--virtual-time-budget=3000',
  `--window-size=${WIDTH},${HEIGHT}`,
  `--screenshot=${join(OUT, 'card.png')}`,
  pathToFileURL(page).href,
]);
if (!values.work) rmSync(work, { recursive: true, force: true });
console.log(`wrote ${join(OUT, 'card.png')} (${WIDTH}x${HEIGHT})`);
