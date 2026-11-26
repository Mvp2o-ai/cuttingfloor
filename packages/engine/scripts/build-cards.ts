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
    button: false,
    ask: 'Ask your agent for a clean copy',
    foot: '',
  },
  end: {
    eyebrow: 'Ready to post it?',
    title: 'Get the clean copy.',
    // The button drawn as the video's page shows it, so it is recognised there.
    body: 'You can remove this card and the watermark by asking your agent for a clean copy, or by clicking:',
    button: true,
    ask: 'Or scan this to release it on your phone',
    foot: '',
  },
} as const;

const CANVASES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;

// Each card twice: plain, and `-qr` with room for the file's QR code (src/card-qr.ts draws it at
// CARD_QR when the review copy is made) in a warm white tile. The code is a convenience, not the
// way: it sits in a row as the alternative to asking the assistant, joined by "or", and the text
// gives way to that row.
const QR_TILE_PAD = 20;
for (const [shape, { width, height }] of Object.entries(CANVASES) as Array<
  [CardShape, { width: number; height: number }]
>) {
  for (const qr of [false, true]) {
    // Type scales with the short side; a tall canvas has room for larger type than its width says.
    const u =
      (Math.min(width, height) / 1080) *
      (shape === 'portrait' ? 1.3 : shape === 'square' && qr ? 0.78 : 1);
    const measure =
      shape === 'landscape' ? (qr ? 1000 : 1300) : shape === 'portrait' ? 700 : qr ? 820 : 900;
    const box = CARD_QR[shape];
    const tileTop = box.y - QR_TILE_PAD;
    const tileLeft = box.x - QR_TILE_PAD;
    const tileSide = box.size + 2 * QR_TILE_PAD;
    // Where the text may go: left of the row on a wide card, above it on a tall or square one.
    const area = !qr
      ? 'margin: 0 auto;'
      : shape === 'landscape'
        ? 'margin: 0 0 0 120px;'
        : `margin: 0 auto 0 ${shape === 'square' ? 0 : 'auto'}; height: ${tileTop - (shape === 'portrait' ? 40 : 24)}px;`;
    // The row: the ask, "or", then the code. Stacked over the code on a wide card, beside it
    // otherwise.
    const ask =
      shape === 'landscape'
        ? { left: tileLeft - 60, top: 150, width: tileSide + 120, height: 230, align: 'center' }
        : {
            left: 96 * u,
            top: tileTop,
            width: tileLeft - 96 * u - (shape === 'portrait' ? 110 : 90),
            height: tileSide,
            align: 'left',
          };
    const or =
      shape === 'landscape'
        ? { x: tileLeft + tileSide / 2, y: tileTop - 50 }
        : { x: tileLeft - (shape === 'portrait' ? 55 : 45), y: tileTop + tileSide / 2 };
    const askSize = shape === 'portrait' ? 44 : shape === 'square' ? 32 : 40;
    for (const [name, card] of Object.entries(CARDS)) {
      const row = qr
        ? `<div class="ask" style="left:${ask.left}px;top:${ask.top}px;width:${ask.width}px;height:${ask.height}px;text-align:${ask.align};justify-content:${ask.align === 'center' ? 'flex-end' : 'center'};font-size:${askSize}px">${card.ask}</div>
${card.button ? '' : `<div class="or" style="left:${or.x - 40}px;top:${or.y - 40}px">or</div>`}
<div class="tile" style="left:${tileLeft}px;top:${tileTop}px;width:${tileSide}px;height:${tileSide}px"></div>
${card.button ? '' : `<div class="scan" style="left:${tileLeft - 100}px;top:${tileTop + tileSide + 12}px;width:${tileSide + 200}px">scan to release it here</div>`}`
        : '';
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
h1 { margin: 0; font-weight: 800; font-size: ${78 * u}px; line-height: 1.02; letter-spacing: -0.03em; }
p { margin: 0; font-weight: 600; font-size: ${44 * u}px; line-height: 1.3; color: ${DIM}; }
p b { color: ${INK}; }
.foot { margin-top: ${24 * u}px; font-weight: 800; font-size: ${58 * u}px; color: ${GREEN}; letter-spacing: -0.01em; }
.tile { position: absolute; background: ${INK}; border-radius: ${QR_TILE_PAD}px; }
.scan { position: absolute; text-align: center; font-weight: 600; font-size: ${shape === 'square' ? 22 : 28}px; letter-spacing: 0.02em; color: ${DIM}; }
.btn { display: inline-block; font-weight: 600; font-size: ${40 * u}px; padding: ${20 * u}px ${32 * u}px; border-radius: ${16 * u}px; background: ${GREEN}; color: #fff; box-shadow: 0 ${8 * u}px ${32 * u}px rgba(43,214,101,0.25); }
.ask { position: absolute; display: flex; flex-direction: column; font-weight: 800; line-height: 1.15; letter-spacing: -0.01em; color: ${INK}; text-wrap: balance; }
.or { position: absolute; width: 80px; height: 80px; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: ${shape === 'square' ? 28 : 36}px; color: ${GREEN}; letter-spacing: 0.16em; text-transform: uppercase; }
</style><main>
<div class="lockup">${MARK}<span>cuttingfloor</span></div>
<div class="eyebrow">${card.eyebrow}</div>
<h1>${card.title}</h1>
<p>${card.body}</p>
${card.button ? '<div><span class="btn">Remove the watermark</span></div>' : ''}
${card.foot ? `<div class="foot">${card.foot}</div>` : ''}
</main>${row}`,
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
