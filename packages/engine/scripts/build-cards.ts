/**
 * Builds the review copy's cards (packages/engine/assets/mark/cards): an opening card and an end
 * card per canvas shape (landscape, portrait, square), drawn as HTML and rendered to PNGs by
 * headless Chrome. burnMark puts them before and after a watermarked video. The image never runs
 * this; it ships what this wrote.
 *
 *   node packages/engine/scripts/build-cards.ts --font-dir <dir with Archivo_800ExtraBold.ttf and
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

const OUT = new URL('../assets/mark/cards/', import.meta.url).pathname;
const work = values.work ?? mkdtempSync(join(tmpdir(), 'cf-cards-'));
mkdirSync(OUT, { recursive: true });
mkdirSync(work, { recursive: true });

// The brand, as in build-mark.ts: Archivo, the cut-square mark, warm white ink, the site's green.
const BG = '#080A09';
const INK = '#F7F4EE';
const DIM = 'rgba(247,244,238,0.62)';
const GREEN = '#2BD665';
const MARK = `<svg viewBox="0 0 32 32"><path d="M4.4 4.4H24.4L4.4 24.4Z" fill="${GREEN}"/><path d="M27.6 7.6V27.6H7.6Z" fill="${INK}"/></svg>`;

const CARDS = {
  open: {
    eyebrow: 'Review copy',
    title: 'Keep editing until it’s right.',
    body: 'Making is free and unlimited: change it as often as you like. When it’s finished, release a clean copy.',
    foot: '',
  },
  end: {
    eyebrow: 'Ready to post it?',
    title: 'Get the clean copy.',
    body: 'Press <b>Remove the watermark</b> on this video’s page, or tell your assistant to use cuttingfloor to release a clean copy.',
    foot: 'cuttingfloor.ai',
  },
} as const;

const CANVASES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;

for (const [shape, { width, height }] of Object.entries(CANVASES)) {
  // Type scales with the short side; a tall canvas has room for larger type than its width says.
  const u = (Math.min(width, height) / 1080) * (shape === 'portrait' ? 1.3 : 1);
  const measure = shape === 'landscape' ? 1300 : shape === 'portrait' ? 700 : 900;
  for (const [name, card] of Object.entries(CARDS)) {
    const page = join(work, `${name}-${shape}.html`);
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Archivo; font-weight: 800; src: url("${pathToFileURL(join(fontDir, 'Archivo_800ExtraBold.ttf')).href}"); }
@font-face { font-family: Archivo; font-weight: 600; src: url("${pathToFileURL(join(fontDir, 'Archivo_600SemiBold.ttf')).href}"); }
html, body { margin: 0; width: ${width}px; height: ${height}px; background: ${BG}; color: ${INK}; font-family: Archivo; overflow: hidden; }
main { box-sizing: border-box; height: 100%; padding: ${96 * u}px; display: flex; flex-direction: column; justify-content: center; gap: ${36 * u}px; max-width: ${measure * u + 192 * u}px; margin: 0 auto; }
.lockup { display: flex; align-items: center; gap: ${18 * u}px; font-weight: 800; font-size: ${54 * u}px; letter-spacing: -0.02em; }
.lockup svg { width: ${64 * u}px; height: ${64 * u}px; }
.eyebrow { font-weight: 600; font-size: ${34 * u}px; letter-spacing: 0.16em; text-transform: uppercase; color: ${GREEN}; margin-top: ${40 * u}px; }
h1 { margin: 0; font-weight: 800; font-size: ${104 * u}px; line-height: 1.02; letter-spacing: -0.03em; }
p { margin: 0; font-weight: 600; font-size: ${44 * u}px; line-height: 1.3; color: ${DIM}; }
p b { color: ${INK}; }
.foot { margin-top: ${24 * u}px; font-weight: 800; font-size: ${58 * u}px; color: ${GREEN}; letter-spacing: -0.01em; }
</style><main>
<div class="lockup">${MARK}<span>cuttingfloor</span></div>
<div class="eyebrow">${card.eyebrow}</div>
<h1>${card.title}</h1>
<p>${card.body}</p>
${card.foot ? `<div class="foot">${card.foot}</div>` : ''}
</main>`,
    );
    execFileSync(values.chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=3000',
      `--window-size=${width},${height}`,
      `--screenshot=${join(OUT, `${name}-${shape}.png`)}`,
      pathToFileURL(page).href,
    ]);
    console.log(`${name}-${shape}.png`);
  }
}

if (!values.work) rmSync(work, { recursive: true, force: true });
