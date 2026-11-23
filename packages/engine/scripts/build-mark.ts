/**
 * Builds the cuttingfloor mark's assets (packages/engine/assets/mark): the pieces, drawn as SVG
 * and rendered to alpha PNGs by headless Chrome, and a 60-second alpha loop per canvas shape
 * (landscape, portrait, square) laid out from a fixed seed and encoded as VP9 with alpha.
 * The image never runs this; it ships what this wrote.
 *
 *   node packages/engine/scripts/build-mark.ts --font-dir <dir with Archivo_800ExtraBold.ttf and
 *     Archivo_600SemiBold.ttf> [--chrome <path>] [--ffmpeg <path>] [--work <dir>]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    ffmpeg: { type: 'string', default: 'ffmpeg' },
    work: { type: 'string' },
  },
});
const fontDir = values['font-dir'];
if (!fontDir) throw new Error('--font-dir is required (Archivo ExtraBold and SemiBold TTFs)');

const OUT = new URL('../assets/mark/', import.meta.url).pathname;
const work = values.work ?? mkdtempSync(join(tmpdir(), 'cf-mark-'));
mkdirSync(join(OUT, 'pieces'), { recursive: true });
mkdirSync(work, { recursive: true });

// The brand: Archivo ExtraBold, the cut-square mark, warm white ink and the site's green.
const INK = '#F7F4EE';
const GREEN = '#2BD665';
const MARK = 'M4.4 4.4H24.4L4.4 24.4Z';
const MARK2 = 'M27.6 7.6V27.6H7.6Z';

/** The two-triangle mark, `size` px square, at x, y: green and ink, or one colour. */
function mark(x: number, y: number, size: number, a = GREEN, b = INK): string {
  const s = size / 32;
  return `<g transform="translate(${x},${y}) scale(${s})"><path d="${MARK}" fill="${a}"/><path d="${MARK2}" fill="${b}"/></g>`;
}

interface Piece {
  name: string;
  width: number;
  height: number;
  body: string;
  /** Angles (degrees) the loop may set it at. */
  angles: number[];
}

const text = (x: number, y: number, size: number, content: string, extra = '') =>
  `<text x="${x}" y="${y}" font-family="Archivo" font-weight="800" font-size="${size}" letter-spacing="${-size * 0.02}" fill="${INK}" ${extra}>${content}</text>`;

const PIECES: Piece[] = [
  {
    // The lockup, as on the site.
    name: 'wordmark',
    width: 1480,
    height: 280,
    body: `${mark(50, 46, 188)}${text(270, 196, 212, 'cuttingfloor')}`,
    angles: [-6, 0, 0, 6],
  },
  {
    name: 'badge',
    width: 1180,
    height: 380,
    body: `<rect x="30" y="30" width="1120" height="320" rx="160" fill="rgba(8,10,9,0.42)" stroke="${INK}" stroke-width="10"/>
      ${mark(118, 102, 176)}
      <text x="338" y="158" font-family="Archivo" font-weight="600" font-size="50" letter-spacing="14" fill="${INK}">MADE WITH</text>
      ${text(332, 272, 134, 'cuttingfloor')}`,
    angles: [-8, -4, 0, 4, 8],
  },
  {
    name: 'ribbon',
    width: 1340,
    height: 250,
    body: `<rect x="0" y="35" width="1340" height="180" fill="rgba(8,10,9,0.45)"/>
      <rect x="0" y="35" width="1340" height="7" fill="${INK}"/><rect x="0" y="208" width="1340" height="7" fill="${INK}"/>
      ${[0, 1]
        .map(
          (i) =>
            `${mark(40 + i * 660, 92, 66, GREEN, INK)}${text(128 + i * 660, 158, 92, 'cuttingfloor')}`,
        )
        .join('')}`,
    angles: [-16, -12, 12, 16],
  },
  {
    // A patch of the wordmark repeated as a brick pattern, fading out at its edges.
    name: 'tiles',
    width: 1300,
    height: 560,
    body: `<defs><radialGradient id="fade" cx="50%" cy="50%" r="55%"><stop offset="55%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></radialGradient>
      <mask id="m"><rect width="1300" height="560" fill="url(#fade)"/></mask></defs>
      <g mask="url(#m)">${[0, 1, 2, 3]
        .map((row) =>
          [-1, 0, 1, 2]
            .map((col) => {
              const x = col * 820 + (row % 2) * 410 + 60;
              const y = row * 150 + 95;
              return `${mark(x, y - 92, 92)}${text(x + 118, y, 116, 'cuttingfloor')}`;
            })
            .join(''),
        )
        .join('')}</g>`,
    angles: [-10, -5, 0, 5, 10],
  },
  {
    // A seal: the name around a ring, the mark in the middle.
    name: 'seal',
    width: 860,
    height: 860,
    body: `<defs><path id="ring" d="M430,430 m-292,0 a292,292 0 1,1 584,0 a292,292 0 1,1 -584,0"/></defs>
      <circle cx="430" cy="430" r="390" fill="rgba(8,10,9,0.38)" stroke="${INK}" stroke-width="12"/>
      <circle cx="430" cy="430" r="215" fill="none" stroke="${INK}" stroke-width="6"/>
      <text font-family="Archivo" font-weight="800" font-size="78" fill="${INK}" letter-spacing="6">
        <textPath href="#ring" textLength="1820" lengthAdjust="spacing">CUTTINGFLOOR • CUTTINGFLOOR • </textPath></text>
      ${mark(300, 300, 260)}`,
    angles: [-20, -10, 0, 10, 20],
  },
  {
    // The mark over the name.
    name: 'stacked',
    width: 960,
    height: 700,
    body: `${mark(310, 40, 340)}${text(480, 600, 176, 'cuttingfloor', 'text-anchor="middle"')}`,
    angles: [-8, 0, 8],
  },
];

const chrome = values.chrome;
for (const p of PIECES) {
  // A soft dark halo under the ink, so the mark reads on white footage as on black.
  const pad = 40;
  const w = p.width + pad * 2;
  const h = p.height + pad * 2;
  const html = `<!doctype html><html><head><style>
    @font-face { font-family: Archivo; font-weight: 800; src: url(${pathToFileURL(join(fontDir, 'Archivo_800ExtraBold.ttf')).href}); }
    @font-face { font-family: Archivo; font-weight: 600; src: url(${pathToFileURL(join(fontDir, 'Archivo_600SemiBold.ttf')).href}); }
    html, body { margin: 0; background: transparent; overflow: hidden; }
    svg { display: block; }
  </style></head><body>
  <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><filter id="halo" x="-10%" y="-20%" width="120%" height="140%">
      <feMorphology in="SourceAlpha" operator="dilate" radius="6" result="d"/>
      <feGaussianBlur in="d" stdDeviation="11" result="b"/>
      <feFlood flood-color="#000" flood-opacity="0.9"/>
      <feComposite in2="b" operator="in" result="s"/>
      <feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter></defs>
    <g filter="url(#halo)" transform="translate(${pad},${pad})">${p.body}</g>
  </svg></body></html>`;
  const page = join(work, `${p.name}.html`);
  writeFileSync(page, html);
  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    '--virtual-time-budget=3000',
    `--window-size=${w},${h}`,
    `--screenshot=${join(OUT, 'pieces', `${p.name}.png`)}`,
    pathToFileURL(page).href,
  ]);
  p.width = w;
  p.height = h;
}

// The loop: a fixed seed, so every build lays out the same minute.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOOP = 60;
const FPS = 24;
const FADE = 0.8;
const CANVASES = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;

interface Placement {
  piece: string;
  start: number;
  end: number;
  angle: number;
  /** √area of the piece over the canvas's short side. */
  size: number;
  opacity: number;
  /** Zone of a 3 × 3 grid, 0 top left to 8 bottom right. */
  zone: number;
}

/**
 * When each piece shows: fades in, holds, fades out; a new one every 2.5–3.5 s, each on screen
 * about 5 s, so one or two are always showing and the picture is never without a piece.
 */
function timeline(rand: () => number): Array<Omit<Placement, 'zone'>> {
  for (;;) {
    const out: Array<Omit<Placement, 'zone'>> = [];
    let t = 0.5;
    let last = '';
    while (true) {
      const hold = 3.2 + rand() * 1;
      const end = t + FADE + hold + FADE;
      if (end > LOOP - 0.2) break;
      let piece = last;
      while (piece === last) piece = PIECES[Math.floor(rand() * PIECES.length)]?.name ?? '';
      const def = PIECES.find((p) => p.name === piece) as Piece;
      out.push({
        piece,
        start: round(t),
        end: round(end),
        angle: def.angles[Math.floor(rand() * def.angles.length)] ?? 0,
        size: round(0.2 + rand() * 0.14),
        opacity: round(0.25 + rand() * 0.1),
      });
      last = piece;
      t += 2.5 + rand();
    }
    // The seam: round from the last piece's end to the first's start, only a moment is empty.
    const seam = LOOP - (out.at(-1)?.end ?? 0) + (out[0]?.start ?? 0);
    const kinds = new Set(out.map((p) => p.piece));
    if (seam >= 0.3 && seam <= 0.8 && kinds.size === PIECES.length) return out;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

const rand = mulberry32(0x6375_7474); // "cutt"
const times = timeline(rand);
const manifest: {
  loop: number;
  fps: number;
  fade: number;
  pieces: Array<{ name: string; width: number; height: number; angles: number[] }>;
  loops: Record<string, { file: string; width: number; height: number; placements: Placement[] }>;
} = {
  loop: LOOP,
  fps: FPS,
  fade: FADE,
  pieces: PIECES.map(({ name, width, height, angles }) => ({ name, width, height, angles })),
  loops: {},
};

for (const [shape, canvas] of Object.entries(CANVASES)) {
  const short = Math.min(canvas.width, canvas.height);
  const placements: Placement[] = [];
  let prev = [-1, -1];
  for (const t of times) {
    // Never the spot of either of the last two; the middle only now and then.
    let zone = 4;
    do zone = Math.floor(rand() * 9);
    while (prev.includes(zone) || (zone === 4 && rand() < 0.6));
    prev = [prev[1] ?? -1, zone];
    placements.push({ ...t, zone });
  }
  const inputs: string[] = [];
  const chains: string[] = [
    `color=c=black@0:s=${canvas.width}x${canvas.height}:r=${FPS}:d=${LOOP},format=rgba[c0]`,
  ];
  placements.forEach((p, i) => {
    const def = PIECES.find((d) => d.name === p.piece) as Piece;
    const k = (p.size * short) / Math.sqrt(def.width * def.height);
    const w = even(def.width * k);
    const h = even(def.height * k);
    const a = (p.angle * Math.PI) / 180;
    const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    // A spot in its zone, inside a 6% margin, jittered so no two land alike.
    const col = p.zone % 3;
    const row = Math.floor(p.zone / 3);
    const mx = canvas.width * 0.06;
    const my = canvas.height * 0.06;
    const cx = mx + ((canvas.width - 2 * mx) * (col + 0.5 + (rand() - 0.5) * 0.5)) / 3;
    const cy = my + ((canvas.height - 2 * my) * (row + 0.5 + (rand() - 0.5) * 0.5)) / 3;
    const x = Math.round(clamp(cx - bw / 2, mx, canvas.width - mx - bw));
    const y = Math.round(clamp(cy - bh / 2, my, canvas.height - my - bh));
    inputs.push(
      '-loop',
      '1',
      '-framerate',
      String(FPS),
      '-t',
      String(LOOP),
      '-i',
      join(OUT, 'pieces', `${p.piece}.png`),
    );
    const n = i + 1;
    chains.push(
      `[${i}:v]format=rgba,scale=${w}:${h}:flags=lanczos,rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=none,` +
        `colorchannelmixer=aa=${p.opacity},` +
        `fade=t=in:st=${p.start}:d=${FADE}:alpha=1,fade=t=out:st=${round(p.end - FADE)}:d=${FADE}:alpha=1[p${n}]`,
      `[c${i}][p${n}]overlay=x=${x}:y=${y}:format=rgb:enable='between(t,${p.start},${p.end})'[c${n}]`,
    );
  });
  const file = `loop-${shape}.webm`;
  execFileSync(values.ffmpeg, [
    '-v',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    chains.join(';'),
    '-map',
    `[c${placements.length}]`,
    '-t',
    String(LOOP),
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-b:v',
    '0',
    '-crf',
    '32',
    '-deadline',
    'good',
    '-cpu-used',
    '2',
    '-row-mt',
    '1',
    '-auto-alt-ref',
    '0',
    '-g',
    String(FPS * 2),
    '-metadata',
    'title=cuttingfloor mark',
    join(OUT, file),
  ]);
  manifest.loops[shape] = { file, ...canvas, placements };
  console.log(`${file}: ${(statSync(join(OUT, file)).size / 1024).toFixed(0)} KB`);
}

writeFileSync(join(OUT, 'mark.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// In the repo's own JSON style, so the check passes on it.
execFileSync('npx', ['biome', 'format', '--write', join(OUT, 'mark.json')]);
if (!values.work) rmSync(work, { recursive: true, force: true });

function even(n: number) {
  return Math.max(2, Math.round(n / 2) * 2);
}
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
