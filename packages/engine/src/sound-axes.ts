import {
  drawText,
  fillRect,
  newRaster,
  type Raster,
  type Rgb,
  textHeight,
  textWidth,
} from './raster.ts';

// The axes render.spectrogram and render.notes share, so the two pictures of the same span line
// up pixel for pixel: time left to right (seconds, linear), one row per semitone from C1 at the
// bottom to B9 at the top (MIDI 24 to 131, A4 = 440 Hz = 69), note names and a keyboard up the
// left side, bar numbers along the top, seconds along the bottom and a key line under them.

/** The lowest and highest rows: C1 (32.7 Hz) and B9 (15.8 kHz), as MIDI numbers. */
export const LOW_PITCH = 24;
export const HIGH_PITCH = 131;
export const PITCH_ROWS = HIGH_PITCH - LOW_PITCH + 1;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The note name of a whole MIDI number (60 is C4). */
export function pitchRowName(pitch: number): string {
  const p = Math.round(pitch);
  return `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
}

/** Frequency of a MIDI number in equal temperament, A4 (69) = 440 Hz. */
export function pitchHz(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

export const COLOURS = {
  page: [0x10, 0x12, 0x16] as Rgb,
  text: [0xe6, 0xe8, 0xec] as Rgb,
  dim: [0x8a, 0x91, 0x9c] as Rgb,
  white: [0xff, 0xff, 0xff] as Rgb,
  whiteKey: [0xd4, 0xd7, 0xdc] as Rgb,
  blackKey: [0x26, 0x29, 0x2f] as Rgb,
  bar: [0x7d, 0xd3, 0xfc] as Rgb,
};

/** Where everything sits in a picture of [from, until) seconds `longEdge` pixels wide. */
export interface SoundLayout {
  width: number;
  height: number;
  /** Font scale: 1 is a 5×7 pixel font. */
  scale: number;
  /** The plot: the area with time across and pitch rows down. */
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  /** Pixels per semitone row. */
  rowPx: number;
  from: number;
  until: number;
  /** Top of the bottom key line (the legend under the time labels). */
  keyTop: number;
}

export function soundLayout(longEdge: number, from: number, until: number): SoundLayout {
  const scale = longEdge >= 1000 ? 2 : 1;
  const th = textHeight(scale);
  const rowPx = Math.max(2, Math.round((longEdge * 0.5) / PITCH_ROWS));
  const labels = textWidth('C#10', scale);
  const keys = 5 * scale + 2;
  const left = 4 * scale + labels + 3 * scale + keys;
  const top = th + 6 * scale;
  const right = 6 * scale;
  const plotHeight = rowPx * PITCH_ROWS;
  const timeLine = th + 6 * scale;
  const keyLine = th + 6 * scale;
  return {
    width: longEdge,
    height: top + plotHeight + timeLine + keyLine,
    scale,
    left,
    top,
    plotWidth: longEdge - left - right,
    plotHeight,
    rowPx,
    from,
    until,
    keyTop: top + plotHeight + timeLine,
  };
}

/** The x of a time, in pixels (fractional). */
export function xOf(l: SoundLayout, seconds: number): number {
  return l.left + ((seconds - l.from) / (l.until - l.from)) * l.plotWidth;
}

/** The top of the row a pitch sits in, in pixels: a whole MIDI number fills its row exactly. */
export function yOf(l: SoundLayout, pitch: number): number {
  return l.top + (HIGH_PITCH - pitch) * l.rowPx;
}

/** Bars and beats to draw, in the picture's seconds. */
export interface Grid {
  bars: Array<{ bar: number; seconds: number }>;
  beats: number[];
}

/** A blank picture: the page, the plot filled with `plotFill`, and the keyboard and note names. */
export function blankPicture(l: SoundLayout, plotFill: (pitch: number) => Rgb): Raster {
  const img = newRaster(l.width, l.height, COLOURS.page);
  for (let p = LOW_PITCH; p <= HIGH_PITCH; p++) {
    fillRect(img, l.left, yOf(l, p), l.plotWidth, l.rowPx, plotFill(p));
  }
  drawPitchSide(img, l);
  return img;
}

function isBlack(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

/** The keyboard strip beside the plot and the note names beside it. */
function drawPitchSide(img: Raster, l: SoundLayout): void {
  const s = l.scale;
  const th = textHeight(s);
  const keys = 5 * s + 2;
  const kx = l.left - keys - 1;
  for (let p = LOW_PITCH; p <= HIGH_PITCH; p++) {
    fillRect(img, kx, yOf(l, p), keys, l.rowPx, isBlack(p) ? COLOURS.blackKey : COLOURS.whiteKey);
  }
  // A dark seam where white keys meet (B|C and E|F) once rows are tall enough to show it.
  if (l.rowPx >= 4) {
    for (let p = LOW_PITCH; p <= HIGH_PITCH; p++) {
      const n = ((p % 12) + 12) % 12;
      if (n === 0 || n === 5) fillRect(img, kx, yOf(l, p) + l.rowPx - 1, keys, 1, COLOURS.blackKey);
    }
  }
  // Names as often as they fit: every row, else C E A, else C and F#, else C alone.
  const fits = (step: number) => step * l.rowPx >= th + 3;
  const named = fits(1)
    ? () => true
    : fits(3)
      ? (n: number) => n === 0 || n === 4 || n === 9
      : fits(6)
        ? (n: number) => n === 0 || n === 6
        : (n: number) => n === 0;
  for (let p = LOW_PITCH; p <= HIGH_PITCH; p++) {
    const n = ((p % 12) + 12) % 12;
    if (!named(n)) continue;
    const name = pitchRowName(p);
    const y = yOf(l, p) + l.rowPx / 2 - th / 2;
    const x = kx - 3 * s - textWidth(name, s);
    drawText(
      img,
      x,
      Math.max(0, Math.min(l.height - th, y)),
      name,
      n === 0 ? COLOURS.text : COLOURS.dim,
      s,
    );
  }
}

/** A step for labels at least `minPx` apart: 1, 2, 5 times a power of ten. */
function niceStep(span: number, plotWidth: number, minPx: number): number {
  const raw = (span * minPx) / plotWidth;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function secondsLabel(t: number, step: number): string {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${t.toFixed(digits)}s`;
}

/**
 * Octave lines (at each C), bar and beat lines over the plot, bar numbers along the top and
 * seconds along the bottom. Beats closer than 4 pixels are left out; bar numbers are thinned to
 * every 2nd, 4th, 8th… bar when they would touch. Returns where each bar line was drawn.
 */
export function drawGrid(
  img: Raster,
  l: SoundLayout,
  grid: Grid | null,
): { bars: Array<{ bar: number; seconds: number; x: number }>; beatLines: number } {
  const s = l.scale;
  const th = textHeight(s);
  const bottom = l.top + l.plotHeight;
  for (let p = LOW_PITCH; p <= HIGH_PITCH; p++) {
    if (((p % 12) + 12) % 12 === 0)
      fillRect(img, l.left, yOf(l, p) + l.rowPx - 1, l.plotWidth, 1, COLOURS.white, 0.16);
  }
  // Seconds along the bottom.
  const span = l.until - l.from;
  const step = niceStep(span, l.plotWidth, textWidth('00.00s', s) + 8 * s);
  for (let t = Math.ceil(l.from / step - 1e-9) * step; t <= l.until + 1e-9; t += step) {
    const x = Math.round(xOf(l, t));
    if (x > l.left + l.plotWidth) break;
    fillRect(img, x, bottom, s, 3 * s, COLOURS.dim);
    const label = secondsLabel(t, step);
    const w = textWidth(label, s);
    const lx = Math.min(Math.max(x - w / 2, l.left - w / 2), l.width - w - 2);
    drawText(img, lx, bottom + 4 * s, label, COLOURS.dim, s);
  }
  const drawn: Array<{ bar: number; seconds: number; x: number }> = [];
  if (!grid) return { bars: drawn, beatLines: 0 };
  const inside = (t: number) => t >= l.from - 1e-9 && t < l.until - 1e-9;
  const pxPerSecond = l.plotWidth / span;
  const beatGap =
    grid.beats.length > 1
      ? Math.min(...grid.beats.slice(1).map((b, i) => b - (grid.beats[i] ?? 0))) * pxPerSecond
      : Infinity;
  let beatLines = 0;
  if (beatGap >= 4) {
    for (const t of grid.beats) {
      if (!inside(t)) continue;
      fillRect(img, Math.round(xOf(l, t)), l.top, 1, l.plotHeight, COLOURS.white, 0.28);
      beatLines++;
    }
  }
  const bars = grid.bars.filter((b) => inside(b.seconds));
  const widest = Math.max(0, ...bars.map((b) => textWidth(String(b.bar), s)));
  const barGap =
    bars.length > 1
      ? Math.min(...bars.slice(1).map((b, i) => b.seconds - (bars[i]?.seconds ?? 0))) * pxPerSecond
      : Infinity;
  let every = 1;
  while (every * barGap < widest + 6 * s && every < 1 << 20) every *= 2;
  for (const b of bars) {
    const x = Math.round(xOf(l, b.seconds));
    fillRect(img, x, l.top, Math.max(1, s), l.plotHeight, COLOURS.bar, 0.6);
    fillRect(img, x, l.top - 3 * s, Math.max(1, s), 3 * s, COLOURS.bar);
    drawn.push({ bar: b.bar, seconds: b.seconds, x });
    if ((b.bar - 1) % every === 0 || every === 1) {
      const label = String(b.bar);
      drawText(
        img,
        Math.min(x + 2 * s, l.width - textWidth(label, s) - 1),
        l.top - 3 * s - th - s,
        label,
        COLOURS.bar,
        s,
      );
    }
  }
  return { bars: drawn, beatLines };
}
