import { barToBeats, beatsToBar, beatsToSeconds, secondsToBeats } from '@cuttingfloor/core';
import type { ScoreDoc } from '@cuttingfloor/schema';
import { drawText, fillRect, type Raster, type Rgb, textHeight, textWidth } from './raster.ts';
import {
  blankPicture,
  COLOURS,
  drawGrid,
  type Grid,
  HIGH_PITCH,
  LOW_PITCH,
  type SoundLayout,
  soundLayout,
  xOf,
  yOf,
} from './sound-axes.ts';

// A piano roll of a score's notes on the same axes as the spectrogram (sound-axes.ts): time in
// seconds left to right, one row per semitone, one colour per part, a note's fill as strong as
// its velocity. The notes are the ones the score plays: each notes region plays its source's
// notes that start inside its window, every region that shares a source plays them, and a note
// that starts outside the window is stored but silent, so it is not drawn.

/** A note as it sounds, in score seconds. `part` indexes the parts list it came with. */
export interface RollNote {
  part: number;
  pitch: number;
  start: number;
  end: number;
  velocity: number;
  /** In beats, as the score places it. */
  at: number;
  length: number;
}

/** Where a score's music ends, in beats: the last region's end or the last note's, whichever is later. */
export function scoreEndBeats(doc: ScoreDoc): number {
  let end = 0;
  for (const part of doc.parts) {
    for (const region of part.regions) {
      if (region.type === 'notes') {
        end = Math.max(end, region.start + region.length);
        for (const n of doc.sources[region.source]?.notes ?? []) {
          if (n.at >= region.offset && n.at < region.offset + region.length) {
            end = Math.max(end, region.start + (n.at - region.offset) + n.length);
          }
        }
      } else if (region.fit_beats) {
        end = Math.max(end, region.start + region.fit_beats);
      } else {
        const startS = beatsToSeconds(doc.tempo, region.start);
        end = Math.max(end, secondsToBeats(doc.tempo, startS + (region.until - region.from)));
      }
    }
  }
  return end;
}

/**
 * The notes `parts` (part ids, in the order given) play that sound at any time in
 * [fromBeats, untilBeats), with their times in seconds from the score's tempo map.
 */
export function playedNotes(
  doc: ScoreDoc,
  partIds: string[],
  fromBeats: number,
  untilBeats: number,
): RollNote[] {
  const out: RollNote[] = [];
  for (const [index, id] of partIds.entries()) {
    const part = doc.parts.find((p) => p.id === id);
    if (!part) continue;
    for (const region of part.regions) {
      if (region.type !== 'notes') continue;
      for (const n of doc.sources[region.source]?.notes ?? []) {
        if (n.at < region.offset || n.at >= region.offset + region.length) continue;
        const at = region.start + (n.at - region.offset);
        const endBeats = at + n.length;
        if (endBeats <= fromBeats || at >= untilBeats) continue;
        out.push({
          part: index,
          pitch: n.pitch,
          start: beatsToSeconds(doc.tempo, at),
          end: beatsToSeconds(doc.tempo, endBeats),
          velocity: n.velocity,
          at,
          length: n.length,
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
}

/** The bar and beat lines of a score over [fromBeats, untilBeats), in seconds (beats are the meter's own unit). */
export function scoreGrid(
  doc: ScoreDoc,
  fromBeats: number,
  untilBeats: number,
): Grid & { barBeats: number[] } {
  const meters = [...doc.meter].sort((a, b) => a.bar - b.bar);
  const bars: Grid['bars'] = [];
  const barBeats: number[] = [];
  const beats: number[] = [];
  let bar = beatsToBar(doc.meter, fromBeats).bar;
  for (;;) {
    const at = barToBeats(doc.meter, bar);
    if (at >= untilBeats - 1e-9) break;
    const meter = meters.findLast((m) => m.bar <= bar) ?? meters[0];
    if (!meter) break;
    const unit = 4 / meter.unit;
    for (let k = 0; k < meter.beats; k++) {
      const b = at + k * unit;
      if (b >= fromBeats - 1e-9 && b < untilBeats - 1e-9) beats.push(beatsToSeconds(doc.tempo, b));
    }
    if (at >= fromBeats - 1e-9) {
      bars.push({ bar, seconds: beatsToSeconds(doc.tempo, at) });
      barBeats.push(at);
    }
    bar += 1;
  }
  return { bars, beats, barBeats };
}

// One colour a part, bright enough on the dark plot and apart from each other; after ten they repeat.
export const PART_COLOURS: Rgb[] = [
  [0x4f, 0xc3, 0xf7],
  [0xff, 0xb7, 0x4d],
  [0x81, 0xc7, 0x84],
  [0xf0, 0x62, 0x92],
  [0xba, 0x68, 0xc8],
  [0xff, 0xf1, 0x76],
  [0x4d, 0xb6, 0xac],
  [0xe5, 0x73, 0x73],
  [0xa1, 0x88, 0x7f],
  [0x90, 0xa4, 0xae],
];

export function partColour(index: number): Rgb {
  return PART_COLOURS[index % PART_COLOURS.length] as Rgb;
}

export function hex(c: Rgb): string {
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const PLOT: Rgb = [0x1a, 0x1d, 0x23];
const PLOT_SHARP: Rgb = [0x13, 0x15, 0x1a];

export interface PianoRoll {
  image: Raster;
  layout: SoundLayout;
  bars: Array<{ bar: number; seconds: number; x: number }>;
  /** Beat lines drawn (none when closer than 4 pixels). */
  beatLines: number;
  /** Notes drawn, and notes outside the rows (below C1 or above B9), which are not. */
  drawn: number;
  outside: number;
}

/** The fill strength of a velocity (1–127): a soft note is faint, a hard one solid. */
export function velocityAlpha(velocity: number): number {
  return 0.25 + (0.75 * velocity) / 127;
}

/** Draws `notes` over [from, until) seconds `longEdge` pixels wide, with part names in a key along the bottom. */
export function drawPianoRoll(
  notes: RollNote[],
  partNames: string[],
  options: { from: number; until: number; longEdge: number; grid?: Grid | null },
): PianoRoll {
  const l = soundLayout(options.longEdge, options.from, options.until);
  const img = blankPicture(l, (p) => ([1, 3, 6, 8, 10].includes(p % 12) ? PLOT_SHARP : PLOT));
  const { bars, beatLines } = drawGrid(img, l, options.grid ?? null);
  let drawn = 0;
  let outside = 0;
  const right = l.left + l.plotWidth;
  for (const n of notes) {
    if (n.pitch < LOW_PITCH - 0.5 || n.pitch > HIGH_PITCH + 0.5) {
      outside++;
      continue;
    }
    const x0 = Math.max(l.left, Math.round(xOf(l, n.start)));
    const x1 = Math.min(right, Math.max(x0 + 1, Math.round(xOf(l, n.end))));
    if (x1 <= x0) continue;
    const y = Math.round(yOf(l, n.pitch));
    const h = l.rowPx;
    const c = partColour(n.part);
    fillRect(img, x0, y, x1 - x0, h, c, velocityAlpha(n.velocity));
    if (h >= 4 && x1 - x0 >= 3) {
      // An edge in the part's colour, so a soft note still shows whose it is, and a white start
      // so notes struck again on one row stay apart.
      fillRect(img, x0, y, x1 - x0, 1, c);
      fillRect(img, x0, y + h - 1, x1 - x0, 1, c);
      fillRect(img, x1 - 1, y, 1, h, c);
    }
    if (xOf(l, n.start) >= l.left) fillRect(img, x0, y, 1, h, COLOURS.white);
    drawn++;
  }
  drawPartKey(img, l, partNames);
  return { image: img, layout: l, bars, beatLines, drawn, outside };
}

/** Part names with their colours along the bottom, as many as fit, then how many more there are. */
function drawPartKey(img: Raster, l: SoundLayout, names: string[]): void {
  const s = l.scale;
  const th = textHeight(s);
  const y = l.keyTop + 2 * s;
  let x = l.left;
  const end = l.left + l.plotWidth;
  for (const [i, name] of names.entries()) {
    const w = th + 3 * s + textWidth(name, s) + 10 * s;
    const more = `+${names.length - i} more`;
    if (x + w > end - (i < names.length - 1 ? textWidth(more, s) : 0)) {
      drawText(img, x, y, more, COLOURS.dim, s);
      return;
    }
    fillRect(img, x, y, th, th, partColour(i));
    drawText(img, x + th + 3 * s, y, name, COLOURS.text, s);
    x += w;
  }
}
