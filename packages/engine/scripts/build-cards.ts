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
import { CARD_QR, type CardShape } from '../src/card-qr.ts';

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

// Each card twice: plain, and `-qr` with room for the file's QR code (src/card-qr.ts draws it at
// CARD_QR when the review copy is made) in a warm white tile, captioned. The text gives way to it.
const QR_TILE_PAD = 20;
for (const [shape, { width, height }] of Object.entries(CANVASES) as Array<
  [CardShape, { width: number; height: number }]
>) {
  for (const qr of [false, true]) {
    // Type scales with the short side; a tall canvas has room for larger type than its width says.
    const u =
      (Math.min(width, height) / 1080) *
      (shape === 'portrait' ? 1.3 : shape === 'square' && qr ? 0.82 : 1);
    const measure =
      shape === 'landscape' ? (qr ? 1000 : 1300) : shape === 'portrait' ? 700 : qr ? 640 : 900;
    const box = CARD_QR[shape];
    // Where the text may go beside the code: left of it on a wide card, above it on a tall one.
    const area = !qr
      ? 'margin: 0 auto;'
      : shape === 'landscape'
        ? `margin: 0 0 0 ${120}px;`
        : shape === 'portrait'
          ? `margin: 0 auto; height: ${box.y - QR_TILE_PAD - 20}px;`
          : `margin: 0; justify-content: flex-start; padding-top: ${72}px;`;
    const tile = qr
      ? `<div class="tile" style="left:${box.x - QR_TILE_PAD}px;top:${box.y - QR_TILE_PAD}px;width:${box.size + 2 * QR_TILE_PAD}px;height:${box.size + 2 * QR_TILE_PAD}px"></div>
<div class="scan" style="left:${box.x - 160}px;top:${box.y + box.size + QR_TILE_PAD + 14}px;width:${box.size + 320}px">Scan to release a clean copy</div>`
      : '';
    for (const [name, card] of Object.entries(CARDS)) {
      const page = join(work, `${name}-${shape}${qr ? '-qr' : ''}.html`);
      writeFileSync(
        page,
        `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Archivo; font-weight: 800; src: url("${pathToFileURL(join(fontDir, 'Archivo_800ExtraBold.ttf')).href}"); }
@font-face { font-family: Archivo; font-weight: 600; src: url("${pathToFileURL(join(fontDir, 'Archivo_600SemiBold.ttf')).href}"); }
html, body { margin: 0; width: ${width}px; height: ${height}px; background: ${BG}; color: ${INK}; font-family: Archivo; overflow: hidden; }
main { box-sizing: border-box; height: 100%; padding: ${96 * u}px; display: flex; flex-direction: column; justify-content: center; gap: ${36 * u}px; max-width: ${measure * u + 192 * u}px; ${area} }
.lockup { display: flex; align-items: center; gap: ${18 * u}px; font-weight: 800; font-size: ${54 * u}px; letter-spacing: -0.02em; }
.lockup svg { width: ${64 * u}px; height: ${64 * u}px; }
.eyebrow { font-weight: 600; font-size: ${34 * u}px; letter-spacing: 0.16em; text-transform: uppercase; color: ${GREEN}; margin-top: ${40 * u}px; }
h1 { margin: 0; font-weight: 800; font-size: ${104 * u}px; line-height: 1.02; letter-spacing: -0.03em; }
p { margin: 0; font-weight: 600; font-size: ${44 * u}px; line-height: 1.3; color: ${DIM}; }
p b { color: ${INK}; }
.foot { margin-top: ${24 * u}px; font-weight: 800; font-size: ${58 * u}px; color: ${GREEN}; letter-spacing: -0.01em; }
.tile { position: absolute; background: ${INK}; border-radius: ${QR_TILE_PAD}px; }
.scan { position: absolute; text-align: center; font-weight: 600; font-size: ${shape === 'square' ? 24 : 30}px; letter-spacing: 0.02em; color: ${DIM}; }
</style><main>
<div class="lockup">${MARK}<span>cuttingfloor</span></div>
<div class="eyebrow">${card.eyebrow}</div>
<h1>${card.title}</h1>
<p>${card.body}</p>
${card.foot ? `<div class="foot">${card.foot}</div>` : ''}
</main>${tile}`,
      );
      execFileSync(values.chrome, [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--virtual-time-budget=3000',
        `--window-size=${width},${height}`,
        `--screenshot=${join(OUT, `${name}-${shape}${qr ? '-qr' : ''}.png`)}`,
        pathToFileURL(page).href,
      ]);
      console.log(`${name}-${shape}${qr ? '-qr' : ''}.png`);
    }
  }
}

if (!values.work) rmSync(work, { recursive: true, force: true });
