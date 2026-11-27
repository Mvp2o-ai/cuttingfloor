import type { ScoreDoc } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';
import {
  colourLevel,
  drawPianoRoll,
  drawSpectrogram,
  HIGH_PITCH,
  LOW_PITCH,
  partColour,
  pitchHz,
  pixelAt,
  playedNotes,
  type Raster,
  type Rgb,
  type SoundLayout,
  SPECTROGRAM_RATE,
  scoreEndBeats,
  scoreGrid,
  soundLayout,
  velocityAlpha,
  xOf,
  yOf,
} from '../src/index.ts';

// Pictures of sound, read back pixel by pixel: the spectrogram's colours turned back into dB
// with its own scale, and the piano roll's notes found by colour.

const R = SPECTROGRAM_RATE;

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(R * seconds));
}

/** Adds a sine of `hz` from `at` for `seconds` at amplitude `amp`. */
function addTone(x: Float32Array, hz: number, at: number, seconds: number, amp = 0.5): void {
  const i0 = Math.round(at * R);
  const n = Math.round(seconds * R);
  for (let i = 0; i < n && i0 + i < x.length; i++) {
    x[i0 + i] = (x[i0 + i] as number) + amp * Math.sin((2 * Math.PI * hz * i) / R);
  }
}

/** The level a pixel row of the picture shows at time t, read from its colour. */
function levelAt(img: Raster, l: SoundLayout, pitch: number, t: number): number {
  const x = Math.round(xOf(l, t));
  const y = Math.round(yOf(l, pitch) + l.rowPx / 2);
  return colourLevel(pixelAt(img, x, y));
}

/** Every row's level at time t, lowest row first. */
function column(img: Raster, l: SoundLayout, t: number): number[] {
  const out: number[] = [];
  for (let p = LOW_PITCH; p <= HIGH_PITCH; p++) out.push(levelAt(img, l, p, t));
  return out;
}

function loudestRow(levels: number[]): number {
  let best = 0;
  for (let i = 1; i < levels.length; i++)
    if ((levels[i] as number) > (levels[best] as number)) best = i;
  return LOW_PITCH + best;
}

describe('spectrogram on a pitch scale', () => {
  it('a sine at A4 lights the A4 row and no other', () => {
    const x = silence(4);
    addTone(x, 440, 0, 4);
    const s = drawSpectrogram(x, 0, { from: 1, until: 3, longEdge: 1280 });
    const col = column(s.image, s.layout, 2);
    expect(loudestRow(col)).toBe(69);
    const a4 = col[69 - LOW_PITCH] as number;
    // A sine of amplitude 0.5 is -6 dBFS on its row.
    expect(a4).toBeGreaterThan(-8);
    expect(a4).toBeLessThan(-4);
    // The rows beside it show the window's spread, far down; every other row is near black.
    for (let p = LOW_PITCH; p <= HIGH_PITCH; p++) {
      const v = col[p - LOW_PITCH] as number;
      if (p === 69) continue;
      if (Math.abs(p - 69) === 1) expect(a4 - v).toBeGreaterThan(24);
      else expect(a4 - v).toBeGreaterThan(55);
    }
  });

  it('a rising chromatic scale steps up one row a semitone', () => {
    const x = silence(7);
    // C4 to B4, 0.5 s each.
    for (let k = 0; k < 12; k++) addTone(x, pitchHz(60 + k), 0.5 + k * 0.5, 0.5);
    const s = drawSpectrogram(x, 0, { from: 0, until: 7, longEdge: 1280 });
    for (let k = 0; k < 12; k++) {
      expect(loudestRow(column(s.image, s.layout, 0.75 + k * 0.5))).toBe(60 + k);
    }
  });

  it('a low thump lands at the bottom and a noise burst at the top', () => {
    const x = silence(3);
    // Kick-like: a sine gliding 110 Hz down to 45 Hz, dying away over 0.3 s, at 0.5 s.
    let phase = 0;
    for (let i = 0; i < 0.3 * R; i++) {
      const t = i / R;
      phase += (2 * Math.PI * (45 + 65 * Math.exp(-t / 0.04))) / R;
      x[Math.round(0.5 * R) + i] = 0.9 * Math.exp(-t / 0.08) * Math.sin(phase);
    }
    // Hi-hat-like: white noise, high-passed by differencing three times, 40 ms at 2 s.
    let seed = 1;
    const noise = Array.from({ length: Math.round(0.04 * R) + 3 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31 - 0.5;
    });
    let hp = noise;
    for (let k = 0; k < 3; k++) hp = hp.slice(1).map((v, i) => v - (hp[i] as number));
    for (const [i, v] of hp.entries())
      x[Math.round(2 * R) + i] = 0.1 * v * Math.exp(-i / (0.015 * R));
    const s = drawSpectrogram(x, 0, { from: 0, until: 3, longEdge: 1280 });
    const kick = column(s.image, s.layout, 0.55);
    const hat = column(s.image, s.layout, 2.01);
    // The thump: loudest below C3, and nothing at the top.
    expect(loudestRow(kick)).toBeLessThan(48);
    expect(Math.max(...kick.slice(96 - LOW_PITCH))).toBeLessThan(-60);
    // The burst: loudest above C7, and nothing at the bottom.
    expect(loudestRow(hat)).toBeGreaterThanOrEqual(96);
    expect(Math.max(...hat.slice(0, 48 - LOW_PITCH))).toBeLessThan(Math.max(...hat) - 40);
    // A hit is short at the top: half a second later the top rows are dark again.
    expect(Math.max(...column(s.image, s.layout, 2.5).slice(96 - LOW_PITCH))).toBeLessThan(-80);
  });

  it('two bass notes a semitone apart at C2 sit on rows of their own', () => {
    const alone = silence(6);
    addTone(alone, pitchHz(36), 0, 6, 0.3);
    const pair = silence(6);
    addTone(pair, pitchHz(36), 0, 6, 0.3);
    addTone(pair, pitchHz(37), 0, 6, 0.3);
    const a = drawSpectrogram(alone, 0, { from: 2, until: 4, longEdge: 1280 });
    const b = drawSpectrogram(pair, 0, { from: 2, until: 4, longEdge: 1280 });
    const ca = column(a.image, a.layout, 3);
    const cb = column(b.image, b.layout, 3);
    const row = (c: number[], p: number) => c[p - LOW_PITCH] as number;
    // C2 alone: its own row, C#2 far below it.
    expect(loudestRow(ca)).toBe(36);
    expect(row(ca, 36) - row(ca, 37)).toBeGreaterThan(24);
    // Both: two rows lit alike, the rows either side far below.
    expect(Math.abs(row(cb, 36) - row(cb, 37))).toBeLessThan(2);
    expect(row(cb, 36) - row(cb, 35)).toBeGreaterThan(24);
    expect(row(cb, 37) - row(cb, 38)).toBeGreaterThan(24);
  });

  it('draws bar lines where the grid puts them, and numbers the bars', () => {
    const x = silence(9);
    // 120 BPM in 4/4: a bar every 2 s from 0.5 s.
    const bars = [0, 1, 2, 3].map((k) => ({ bar: k + 1, seconds: 0.5 + 2 * k }));
    const beats = Array.from({ length: 16 }, (_, k) => 0.5 + 0.5 * k);
    const s = drawSpectrogram(x, 0, { from: 0, until: 8, longEdge: 1280, grid: { bars, beats } });
    expect(s.bars.map((b) => b.bar)).toEqual([1, 2, 3, 4]);
    const l = s.layout;
    const mid = l.top + Math.round(l.plotHeight / 2) + 1;
    for (const b of s.bars) {
      expect(b.x).toBe(Math.round(xOf(l, b.seconds)));
      // The bar line is light blue over the black of silence; a pixel between bars is not.
      const [r, g, bl] = pixelAt(s.image, b.x, mid);
      expect(bl).toBeGreaterThan(120);
      expect(bl).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(80);
    }
    const between = pixelAt(s.image, Math.round(xOf(l, 1.75)), mid);
    expect(Math.max(...between)).toBeLessThan(30);
    // 0.5 s to 7.5 s; the beat at 8 s is the end of the range.
    expect(s.beatLines).toBe(15);
  });

  it('reads a range out of the middle of longer sound at the right time', () => {
    // A note from 10.0 s to 10.5 s, in samples that start at 9 s.
    const x = silence(3);
    addTone(x, 880, 1, 0.5);
    const s = drawSpectrogram(x, 9, { from: 9.5, until: 11.5, longEdge: 1280 });
    expect(loudestRow(column(s.image, s.layout, 10.25))).toBe(81);
    expect(levelAt(s.image, s.layout, 81, 11)).toBeLessThan(-80);
    expect(levelAt(s.image, s.layout, 81, 9.75)).toBeLessThan(-80);
  });
});

/** A score with tempo 120 (half a second a beat) in 4/4. */
function score(): ScoreDoc {
  return {
    version: 1,
    name: 'test',
    sample_rate: 48_000,
    tempo: [{ at: 0, bpm: 120 }],
    meter: [{ bar: 1, beats: 4, unit: 4 }],
    markers: [],
    parts: [
      {
        id: 'p_bass',
        name: 'Bass',
        gain_db: 0,
        pan: 0,
        mute: false,
        solo: false,
        output: 'master',
        devices: [],
        sends: [],
        regions: [
          // The same source twice: a loop that comes back at beat 8.
          { id: 'r1', type: 'notes', start: 0, length: 4, source: 's_bass', offset: 0 },
          { id: 'r2', type: 'notes', start: 8, length: 4, source: 's_bass', offset: 0 },
        ],
      },
      {
        id: 'p_lead',
        name: 'Lead',
        gain_db: 0,
        pan: 0,
        mute: false,
        solo: false,
        output: 'master',
        devices: [],
        sends: [],
        regions: [{ id: 'r3', type: 'notes', start: 0, length: 16, source: 's_lead', offset: 0 }],
      },
    ],
    master: { devices: [] },
    sources: {
      s_bass: {
        notes: [
          { id: 'n1', pitch: 36, at: 0, length: 1, velocity: 120 },
          { id: 'n2', pitch: 40, at: 2, length: 1, velocity: 20 },
          // Starts outside the regions' window [0, 4): stored, silent.
          { id: 'n3', pitch: 43, at: 5, length: 1, velocity: 100 },
        ],
      },
      s_lead: { notes: [{ id: 'n4', pitch: 72, at: 1, length: 2, velocity: 120 }] },
    },
    automation: [],
    media: {},
    parent: null,
  };
}

describe('piano roll', () => {
  const doc = score();
  const ids = ['p_bass', 'p_lead'];
  const notes = playedNotes(doc, ids, 0, 16);
  const grid = scoreGrid(doc, 0, 16);
  const roll = drawPianoRoll(notes, ['Bass', 'Lead'], { from: 0, until: 8, longEdge: 1280, grid });
  const l = roll.layout;
  /** The pixel in the middle of a pitch's row at beat b (0.5 s a beat). */
  const at = (pitch: number, beat: number) =>
    pixelAt(roll.image, Math.round(xOf(l, beat * 0.5)), Math.round(yOf(l, pitch) + l.rowPx / 2));
  const background = (pitch: number) => at(pitch, 15.5);
  const close = (a: readonly number[], b: readonly number[], by = 4) =>
    a.every((v, i) => Math.abs(v - (b[i] as number)) <= by);
  const fill = (part: number, pitch: number, velocity: number) => {
    const bg = background(pitch);
    const c = partColour(part);
    const al = velocityAlpha(velocity);
    return bg.map((v, i) => Math.round(v + ((c[i] as number) - v) * al));
  };

  it('plays each region its source notes, mirrored regions in both places', () => {
    expect(scoreEndBeats(doc)).toBe(16);
    expect(notes.map((n) => [n.part, n.pitch, n.at])).toEqual([
      [0, 36, 0],
      [1, 72, 1],
      [0, 40, 2],
      [0, 36, 8],
      [0, 40, 10],
    ]);
    expect(notes.find((n) => n.pitch === 72)?.start).toBe(0.5);
  });

  it('draws notes on their rows and columns, in their part colour by velocity', () => {
    expect(close(at(36, 0.5), fill(0, 36, 120))).toBe(true);
    expect(close(at(36, 8.5), fill(0, 36, 120))).toBe(true);
    expect(close(at(40, 2.5), fill(0, 40, 20))).toBe(true);
    expect(close(at(40, 10.5), fill(0, 40, 20))).toBe(true);
    // Not before it starts, nor after it ends, nor on the rows beside it.
    expect(close(at(36, 1.5), background(36))).toBe(true);
    expect(close(at(37, 0.5), background(37))).toBe(true);
    expect(close(at(35, 0.5), background(35))).toBe(true);
    // A hard note is brighter than a soft one.
    const sum = (c: Rgb) => c[0] + c[1] + c[2];
    expect(sum(at(36, 0.5))).toBeGreaterThan(sum(at(40, 2.5)) + 100);
  });

  it('leaves out a note that starts outside its region', () => {
    expect(close(at(43, 5.5), background(43))).toBe(true);
    expect(close(at(43, 13.5), background(43))).toBe(true);
    expect(roll.drawn).toBe(5);
  });

  it('gives two parts two colours', () => {
    const bass = at(36, 0.5);
    const lead = at(72, 1.5);
    expect(close(lead, fill(1, 72, 120))).toBe(true);
    // Sky blue against orange: blue leads in one, red in the other.
    expect(bass[2]).toBeGreaterThan(bass[0]);
    expect(lead[0]).toBeGreaterThan(lead[2]);
  });

  it('draws bars from the score meter, on the same axes as the spectrogram', () => {
    expect(roll.bars.map((b) => [b.bar, b.seconds])).toEqual([
      [1, 0],
      [2, 2],
      [3, 4],
      [4, 6],
    ]);
    expect(roll.beatLines).toBe(16);
    const s = drawSpectrogram(silence(8), 0, { from: 0, until: 8, longEdge: 1280 });
    expect(s.layout).toEqual(roll.layout);
    expect(soundLayout(1280, 0, 8)).toEqual(l);
  });

  it('follows a tempo change and a meter change', () => {
    const d = {
      ...score(),
      tempo: [
        { at: 0, bpm: 120 },
        { at: 8, bpm: 60 },
      ],
      meter: [
        { bar: 1, beats: 4, unit: 4 },
        { bar: 3, beats: 6, unit: 8 },
      ],
    } as ScoreDoc;
    const g = scoreGrid(d, 0, 14);
    // Bars 1–2 are 4 beats at 0.5 s; from beat 8 a bar is 3 beats at 1 s.
    expect(g.bars.map((b) => [b.bar, b.seconds])).toEqual([
      [1, 0],
      [2, 2],
      [3, 4],
      [4, 7],
    ]);
    // 6/8 counts eighth notes: half a beat at 60 BPM is 0.5 s.
    expect(g.beats.filter((t) => t >= 4 && t < 7)).toEqual([4, 4.5, 5, 5.5, 6, 6.5]);
  });
});
