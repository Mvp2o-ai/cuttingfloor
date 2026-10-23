import { describe, expect, it } from 'vitest';
import {
  alignGroups,
  crossCorrelate,
  fitWords,
  forcedAlign,
  parseLoudness,
  speechSpans,
  W2V_LABELS,
  wordTokens,
} from '../src/index.ts';

const C = W2V_LABELS.length;
const id = (ch: string) => W2V_LABELS.indexOf(ch as (typeof W2V_LABELS)[number]);

/** Emissions where each frame is sure of one label (log 1 = 0), the rest very unlikely. */
function emissions(frames: string[]): Float32Array {
  const out = new Float32Array(frames.length * C).fill(-20);
  frames.forEach((label, t) => {
    out[t * C + (label === '_' ? 0 : id(label))] = 0;
  });
  return out;
}

describe('forced alignment', () => {
  it('turns words into the model labels it knows', () => {
    expect(wordTokens("Don't")).toEqual(['D', 'O', 'N', "'", 'T'].map(id));
    expect(wordTokens('café,')).toEqual(['C', 'A', 'F', 'E'].map(id));
    expect(wordTokens('2026')).toEqual([]);
    expect(wordTokens("'quoted'")).toEqual(['Q', 'U', 'O', 'T', 'E', 'D'].map(id));
  });

  it('times each word to the frames where its letters sound, pauses left out', () => {
    // "hi" at frames 2–4, a pause, the separator, "yo" at frames 9–11.
    const frames = ['_', '_', 'H', 'H', 'I', '_', '_', '|', '_', 'Y', 'O', 'O', '_', '_'];
    const spans = forcedAlign(emissions(frames), frames.length, C, [
      wordTokens('hi'),
      wordTokens('yo'),
    ]);
    expect(spans?.map((s) => [s.start, s.end])).toEqual([
      [2, 5],
      [9, 12],
    ]);
    expect(spans?.[0]?.score).toBeCloseTo(1, 3);
  });

  it('needs a blank between repeated letters, and says when the sound is too short', () => {
    const frames = ['L', '_', 'L'];
    expect(forcedAlign(emissions(frames), 3, C, [[id('L'), id('L')]])?.[0]).toMatchObject({
      start: 0,
      end: 3,
    });
    expect(forcedAlign(emissions(['L']), 1, C, [[id('L'), id('L')]])).toBeNull();
  });

  it('groups words with a neighbour each side for context', () => {
    const words = ['one', 'two', '3', 'four'].map((text, i) => ({
      text,
      start: i,
      end: i + 0.5,
    }));
    const groups = alignGroups(words, 10, { maxSeconds: 1.6, pad: 1 });
    expect(groups[0]).toMatchObject({ first: 0, last: 1, from: 0, to: 3, start: 0 });
    expect(groups[1]).toMatchObject({ first: 3, last: 3, from: 1, to: 3, end: 4.5 });
  });

  it('fits unaligned words between aligned ones and clamps to the duration', () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end, confidence: 1 });
    const out = fitWords(
      [w('in', 0, 0.4), w('2026', 0.1, 2.5), w('we', 1, 1.4), w('go', 2.9, 3.5)],
      [
        { start: 0.05, end: 0.3, score: 0.9 },
        null,
        { start: 1.1, end: 1.3, score: 0.8 },
        { start: 2.95, end: 3.4, score: 0.7 },
      ],
      3.2,
    );
    expect(out.map((x) => [x.start, x.end, x.timing_confidence])).toEqual([
      [0.05, 0.3, 0.9],
      [0.3, 1.1, null],
      [1.1, 1.3, 0.8],
      [2.95, 3.2, 0.7],
    ]);
  });
});

describe('speech spans', () => {
  it('are runs of frames at or above the cut-off, in seconds from the start', () => {
    const p = { frame_seconds: 0.5, from: 10, probabilities: [0.1, 0.9, 0.8, 0.2, 0.6, 0.7] };
    expect(speechSpans(p, 0.5)).toEqual([
      { start: 10.5, end: 11.5 },
      { start: 12, end: 13 },
    ]);
    expect(speechSpans(p, 0.95)).toEqual([]);
  });
});

describe('sync offset', () => {
  function noise(n: number, seed: number): Float32Array {
    let s = seed;
    return Float32Array.from({ length: n }, () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 30 - 1;
    });
  }

  it('finds where b sits in a, with its strength', () => {
    const rate = 1000;
    const a = noise(4000, 7);
    // b is a's sound from 1.25 s on, a little quieter, with its own hiss.
    const hiss = noise(2000, 99);
    const b = Float32Array.from(a.subarray(1250, 3250), (v, i) => 0.5 * v + 0.05 * (hiss[i] ?? 0));
    const out = crossCorrelate(a, b, rate, { maxLag: 3000 });
    expect(out?.offset_seconds).toBeCloseTo(1.25, 3);
    expect(out?.strength).toBeGreaterThan(0.95);
    expect(out?.next_best?.strength ?? 0).toBeLessThan(0.2);
    // Searching too narrow a window can't find it: the best there is weak.
    const narrow = crossCorrelate(a, b, rate, { maxLag: 500 });
    expect(narrow?.strength ?? 0).toBeLessThan(0.2);
  });

  it('gives a negative offset when b starts before a', () => {
    const src = noise(3000, 3);
    const a = src.subarray(500);
    const b = src.subarray(0, 2000);
    expect(crossCorrelate(a, b, 1000, { maxLag: 1000 })?.offset_seconds).toBeCloseTo(-0.5, 3);
  });
});

describe('loudness facts', () => {
  it('reads ebur128 and astats output', () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -23.4 LUFS
    Threshold: -33.6 LUFS

  Loudness range:
    LRA:         5.2 LU
    Threshold: -43.5 LUFS
    LRA low:   -26.1 LUFS
    LRA high:  -20.9 LUFS

  True peak:
    Peak:       -3.1 dBFS
[Parsed_astats_1 @ 0x2] Overall
[Parsed_astats_1 @ 0x2] RMS level dB: -25.300000
[Parsed_astats_1 @ 0x2] Noise floor dB: -61.200000
[Parsed_astats_1 @ 0x2] Number of samples: 48000`;
    expect(parseLoudness(stderr)).toEqual({
      integrated_lufs: -23.4,
      true_peak_dbtp: -3.1,
      loudness_range_lu: 5.2,
      rms_dbfs: -25.3,
      noise_floor_dbfs: -61.2,
    });
  });
});
