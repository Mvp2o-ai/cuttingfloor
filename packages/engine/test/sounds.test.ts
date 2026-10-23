import { describe, expect, it } from 'vitest';
import {
  type FrameScores,
  listenText,
  peakOf,
  scoreSeries,
  seriesStep,
  soundSpans,
} from '../src/index.ts';

const scores = (values: number[][], start = 0): FrameScores => ({
  columns: values[0]?.map((_, i) => `c${i}`) ?? [],
  frames: values.length,
  data: Uint8Array.from(values.flat().map((p) => Math.round(p * 255))),
  start,
});

describe('sound frames', () => {
  it('turns runs of frames at or above the cut-off into spans with their peak', () => {
    const s = scores([[0.1], [0.6], [0.9], [0.55], [0.2], [0.7]], 10);
    expect(soundSpans(s, 0, 0.5)).toEqual([
      { start: 10.04, end: 10.16, peak_seconds: 10.1, peak_probability: 0.9 },
      { start: 10.2, end: 10.24, peak_seconds: 10.22, peak_probability: 0.7 },
    ]);
    expect(soundSpans(s, 0, 0.95)).toEqual([]);
    expect(peakOf(s, 0)).toBeCloseTo(0.9, 2);
  });

  it('coarsens scores by the highest in each step, only as far as needed', () => {
    const s = scores([[0.1], [0.6], [0.2], [0.3], [0.9]]);
    expect(scoreSeries(s, 0, 0.04)).toEqual([0.1, 0.6, 0.2, 0.3, 0.9]);
    expect(scoreSeries(s, 0, 0.08)).toEqual([0.6, 0.3, 0.9]);
    expect(seriesStep(90_000, 10, 60_000)).toBe(0.6);
    expect(seriesStep(100, 2, 60_000)).toBe(0.04);
    expect(seriesStep(100, 2, 60_000, 1)).toBe(1);
  });

  it('asks FlexSED in the words it was trained on', () => {
    expect(listenText('a door_slams')).toBe('The sound of A door slams');
  });
});
