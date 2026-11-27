import { describe, expect, it } from 'vitest';
import {
  barLength,
  barsBetween,
  barToBeats,
  beatsToBar,
  beatsToSeconds,
  positionAt,
  positionAtSeconds,
  secondsToBeats,
  tempoAt,
} from '../src/score/time.ts';

describe('score time', () => {
  it('one tempo: a beat at 120 is half a second', () => {
    const tempo = [{ at: 0, bpm: 120 }];
    expect(beatsToSeconds(tempo, 0)).toBe(0);
    expect(beatsToSeconds(tempo, 24)).toBeCloseTo(12, 12);
    expect(secondsToBeats(tempo, 12)).toBeCloseTo(24, 12);
  });

  it('a step change keeps the beats before it and runs at the new tempo after', () => {
    const tempo = [
      { at: 0, bpm: 120 },
      { at: 8, bpm: 60 },
    ];
    expect(beatsToSeconds(tempo, 8)).toBeCloseTo(4, 12);
    expect(beatsToSeconds(tempo, 10)).toBeCloseTo(6, 12);
    expect(secondsToBeats(tempo, 6)).toBeCloseTo(10, 12);
    expect(tempoAt(tempo, 7.99)).toBe(120);
    expect(tempoAt(tempo, 8)).toBe(60);
  });

  it('a ramp glides linearly in beats and arrives on its beat', () => {
    const tempo = [
      { at: 0, bpm: 60 },
      { at: 4, bpm: 60 },
      { at: 8, bpm: 120, ramp: true },
    ];
    expect(tempoAt(tempo, 4)).toBe(60);
    expect(tempoAt(tempo, 6)).toBeCloseTo(90, 12);
    expect(tempoAt(tempo, 8)).toBe(120);
    // 4 beats gliding 60 to 120: 60 * 4 / 60 * ln 2 seconds.
    const glide = 4 * Math.log(2);
    expect(beatsToSeconds(tempo, 8)).toBeCloseTo(4 + glide, 10);
    expect(beatsToSeconds(tempo, 10)).toBeCloseTo(4 + glide + 1, 10);
    // The glide is slower than its end tempo and faster than its start.
    expect(glide).toBeGreaterThan(2);
    expect(glide).toBeLessThan(4);
  });

  it('seconds and beats undo each other across steps and ramps', () => {
    const tempo = [
      { at: 0, bpm: 96 },
      { at: 16, bpm: 140, ramp: true },
      { at: 32, bpm: 70 },
      { at: 40, bpm: 71.5, ramp: true },
    ];
    for (const b of [0, 0.25, 7.3333, 16, 20.5, 31.999, 32, 36, 40, 123.456]) {
      expect(secondsToBeats(tempo, beatsToSeconds(tempo, b))).toBeCloseTo(b, 8);
    }
  });

  it('bars follow the meter: 6/8 is three quarter notes long', () => {
    expect(barLength({ beats: 4, unit: 4 })).toBe(4);
    expect(barLength({ beats: 6, unit: 8 })).toBe(3);
    expect(barLength({ beats: 7, unit: 8 })).toBe(3.5);
    const meter = [
      { bar: 1, beats: 4, unit: 4 as const },
      { bar: 3, beats: 6, unit: 8 as const },
    ];
    expect(barToBeats(meter, 1)).toBe(0);
    expect(barToBeats(meter, 3)).toBe(8);
    expect(barToBeats(meter, 5)).toBe(14);
    expect(beatsToBar(meter, 7.5)).toEqual({ bar: 2, into: 3.5 });
    expect(beatsToBar(meter, 8)).toEqual({ bar: 3, into: 0 });
    expect(beatsToBar(meter, 12)).toEqual({ bar: 4, into: 1 });
  });

  it('positions come back in beats, seconds and exact frames', () => {
    const score = {
      tempo: [{ at: 0, bpm: 120 }],
      fps: { num: 30, den: 1 },
    };
    expect(positionAt(score, 3)).toEqual({ beats: 3, seconds: 1.5, frames: 45 });
    expect(positionAt(score, 91 / 30)).toMatchObject({ frames: 45.5 });
    expect(positionAtSeconds(score, 12)).toEqual({ beats: 24, seconds: 12, frames: 360 });
    expect(positionAt({ tempo: score.tempo }, 3)).toEqual({ beats: 3, seconds: 1.5 });
  });

  it('a tempo fitted to a length lands the last bar on it: 12 s is 6 bars at 120', () => {
    const score = { tempo: [{ at: 0, bpm: 120 }], meter: [{ bar: 1, beats: 4, unit: 4 as const }] };
    const bars = barsBetween(score, 0, 24, 100);
    expect(bars.map((b) => b.bar)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(bars.at(-1)).toMatchObject({ beats: 20, seconds: 10 });
    expect(barsBetween(score, 1, 24, 2).map((b) => b.bar)).toEqual([2, 3]);
  });
});
