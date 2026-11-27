import type { ScoreDoc } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';
import { newScore } from '../src/score/edit.ts';
import {
  applyMicrophoneTake,
  applyPadsTake,
  loopBeat,
  loopGrid,
  meterBeatsBefore,
  meterBeatsBetween,
  partPads,
  scoreAtSpeed,
  takeAgain,
  takeDigest,
} from '../src/score/take.ts';
import { beatsToSeconds, secondsToBeats } from '../src/score/time.ts';

// The take math of score.record: seconds in a loop as rendered at a speed become the score's
// beats, every tap where it was played.

function score(tempo: ScoreDoc['tempo'] = [{ at: 0, bpm: 120 }]): ScoreDoc {
  const doc = newScore({
    name: 't',
    tempo: 120,
    meter: { beats: 4, unit: 4 },
    sample_rate: 48_000,
  });
  doc.tempo = tempo;
  doc.parts.push({
    id: 'p1',
    name: 'Drums',
    gain_db: 0,
    pan: 0,
    mute: false,
    solo: false,
    output: 'master',
    devices: [{ id: 'd2', name: 'kit_808', params: {} }],
    sends: [],
    regions: [],
  });
  doc.next_id = 3;
  return doc;
}

const loop = { part_id: 'p1', from_beats: 4, until_beats: 12, speed: 1 };

describe('score.record take math', () => {
  it('speed 1: a tap at a loop second lands on its beat, exactly', () => {
    const doc = score();
    // Loop starts at beat 4 = 2 s; 1.25 s in is 3.25 s = beat 6.5.
    expect(loopBeat(doc.tempo, loop, 1.25, 0)).toBe(6.5);
    expect(loopBeat(doc.tempo, loop, 0, 0)).toBe(4);
  });

  it('another speed: the loop second is at tempo × speed, the beat is the same', () => {
    const doc = score();
    // At speed 0.5 the loop plays at 60 bpm: 2.5 s in is 2.5 beats in.
    expect(loopBeat(doc.tempo, { ...loop, speed: 0.5 }, 2.5, 0)).toBe(6.5);
    // At 1.5 (180 bpm) 0.8333… s in is 2.5 beats in.
    expect(loopBeat(doc.tempo, { ...loop, speed: 1.5 }, 2.5 / 3, 0)).toBeCloseTo(6.5, 12);
  });

  it('a tempo change inside the loop: the beat follows the rendition’s tempo map', () => {
    const doc = score([
      { at: 0, bpm: 120 },
      { at: 8, bpm: 60 },
    ]);
    // Loop from beat 4 (2 s); beat 8 is at 4 s; 3 s into the loop is 5 s = beat 9.
    expect(loopBeat(doc.tempo, loop, 3, 0)).toBe(9);
    // At speed 2 everything is twice as quick: 1.5 s in is the same beat 9.
    expect(loopBeat(doc.tempo, { ...loop, speed: 2 }, 1.5, 0)).toBe(9);
    // A glide inside the loop: seconds and beats undo each other through the rendition.
    const glide = score([
      { at: 0, bpm: 90 },
      { at: 6, bpm: 90 },
      { at: 10, bpm: 150, ramp: true },
    ]);
    for (const speed of [0.5, 1, 1.75]) {
      const rendition = scoreAtSpeed(glide, speed).tempo;
      const t0 = beatsToSeconds(rendition, 4);
      for (const beat of [4.1, 6, 7.37, 9.999, 11.5]) {
        const at = beatsToSeconds(rendition, beat) - t0;
        expect(loopBeat(glide.tempo, { ...loop, speed }, at, 0)).toBeCloseTo(beat, 9);
      }
    }
    // The stored score is never changed by a speed.
    expect(glide.tempo[2]?.bpm).toBe(150);
  });

  it('a later pass lands that many loop lengths on, stored silent outside the region', () => {
    const doc = score();
    const placed = applyPadsTake(doc, {
      ...loop,
      length_beats: 0.25,
      velocity: 100,
      taps: [
        { pitch: 36, at_seconds: 1.25, pass: 0 },
        { pitch: 36, at_seconds: 1.25, pass: 2 },
      ],
    });
    expect(placed.taps.map((t) => t.beats)).toEqual([6.5, 22.5]);
    expect(placed.taps.map((t) => t.sounds)).toEqual([true, false]);
    const region = doc.parts[0]?.regions[0] as { source: string };
    const notes = doc.sources[region.source]?.notes;
    expect(notes?.map((n) => n.at)).toEqual([2.5, 18.5]);
    expect(doc.parts[0]?.regions[0]).toMatchObject({ start: 4, length: 8, offset: 0 });
  });

  it('a tap before the loop starts falls on the beats leading into it, as the count-in does', () => {
    const doc = score();
    const grid = loopGrid(doc, { ...loop, count_in_beats: 2 });
    expect(grid.count_in).toEqual({ beats: 2, seconds: 1, times: [-1, -0.5] });
    // A tap on the first count-in click is beat 2; half a beat before the loop, 3.5.
    expect(loopBeat(doc.tempo, loop, -1, 0)).toBe(2);
    const placed = applyPadsTake(doc, {
      ...loop,
      length_beats: 0.5,
      velocity: 90,
      taps: [{ pitch: 38, at_seconds: -0.25, pass: 0 }],
    });
    expect(placed.taps[0]).toMatchObject({ beats: 3.5, sounds: false });
    const region = doc.parts[0]?.regions[0] as { source: string };
    expect(doc.sources[region.source]?.notes[0]?.at).toBe(-0.5);
    // Before beat 0 the count-in runs on at the opening tempo.
    const atZero = loopGrid(doc, { ...loop, from_beats: 0, count_in_beats: 3 });
    expect(atZero.count_in.times).toEqual([-1.5, -1, -0.5]);
    expect(loopBeat(doc.tempo, { ...loop, from_beats: 0 }, -1.5, 0)).toBe(-3);
  });

  it('nothing is rounded: a tap a hundred-billionth of a second in is stored there', () => {
    const doc = score();
    const placed = applyPadsTake(doc, {
      ...loop,
      length_beats: 0.123456789123,
      velocity: 64,
      taps: [
        { pitch: 36, at_seconds: 1e-11, pass: 0 },
        { pitch: 36, at_seconds: 0.333333333333, pass: 0 },
      ],
    });
    const region = doc.parts[0]?.regions[0] as { source: string };
    const [a, b] = doc.sources[region.source]?.notes ?? [];
    expect(a?.at).toBeGreaterThan(0);
    // Float arithmetic only: 2 s + 1e-11 s carries the error of a double, nothing more.
    expect(a?.at).toBeCloseTo(2e-11, 16);
    expect(b?.at).toBe(secondsToBeats(doc.tempo, 2 + 0.333333333333) - 4);
    expect(a?.length).toBe(0.123456789123);
    expect(placed.taps[0]?.beats).toBe(4 + (a?.at as number));
  });

  it('velocities: measured ones are kept, the rest take the one given', () => {
    const doc = score();
    const placed = applyPadsTake(doc, {
      ...loop,
      length_beats: 0.25,
      velocity: 77,
      taps: [
        { pitch: 36, at_seconds: 0.5, pass: 0, velocity: 12 },
        { pitch: 42, at_seconds: 0.75, pass: 0 },
      ],
    });
    expect(placed.taps.map((t) => [t.velocity, t.velocity_measured])).toEqual([
      [12, true],
      [77, false],
    ]);
  });

  it('a take is safe to repeat: the same body again is the same take, another is refused', () => {
    const body = {
      job_id: 'j_x',
      speed: 1,
      taps: [{ pitch: 36, at_seconds: 0.5, pass: 0 }],
      delay: { output_ms: 12, input_ms: 0, source: 'reported', route: 'speaker' },
    };
    expect(takeAgain(undefined, body)).toBe('first');
    const stored = takeDigest(body);
    // Key order does not make it another take.
    const reordered = {
      delay: { route: 'speaker', source: 'reported', input_ms: 0, output_ms: 12 },
      taps: [{ pass: 0, at_seconds: 0.5, pitch: 36 }],
      speed: 1,
      job_id: 'j_x',
    };
    expect(takeAgain(stored, reordered)).toBe('same');
    expect(takeAgain(stored, { ...body, taps: [{ pitch: 36, at_seconds: 0.5001, pass: 0 }] })).toBe(
      'other',
    );
  });

  it('the loop grid: beats of the meter (six a bar in 6/8) and bars, in loop seconds', () => {
    const doc = score();
    doc.meter = [{ bar: 1, beats: 6, unit: 8 }];
    // A bar of 6/8 is 3 quarter notes; at 120 a beat of the meter (an eighth) is 0.25 s.
    const grid = loopGrid(doc, { from_beats: 3, until_beats: 9, speed: 1, count_in_beats: 3 });
    expect(grid.beats).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75]);
    expect(grid.bars).toEqual([0, 1.5]);
    expect(grid.seconds).toBe(3);
    expect(grid.count_in.times).toEqual([-0.75, -0.5, -0.25]);
    expect(meterBeatsBetween(doc.meter, 0.2, 1.1)).toEqual([0.5, 1]);
    expect(meterBeatsBefore([{ bar: 1, beats: 4, unit: 4 }], 0.5, 2)).toEqual([-1, 0]);
    // A meter change: 4/4 for a bar, then 3/8.
    expect(
      meterBeatsBetween(
        [
          { bar: 1, beats: 4, unit: 4 },
          { bar: 2, beats: 3, unit: 8 },
        ],
        3,
        6,
      ),
    ).toEqual([3, 4, 4.5, 5, 5.5]);
  });

  it('a microphone take: placed on the beat heard, its edges the loop', () => {
    const doc = score();
    // Recording starts 0.5 s before the loop (in the count-in) and lasts 6 s at speed 1.
    const placed = applyMicrophoneTake(doc, {
      ...loop,
      starts_at_seconds: -0.5,
      media: { media_id: 'm_a', name: 'hum.wav', duration: 6 },
    });
    expect(placed).toMatchObject({ at_beats: 3, end_beats: 15, from: 0.5, until: 4.5 });
    expect(doc.parts[0]?.regions.at(-1)).toMatchObject({
      type: 'audio',
      start: 4,
      from: 0.5,
      until: 4.5,
    });
    expect(doc.media.m_a).toEqual({ name: 'hum.wav', duration: 6 });
    // At speed 0.5 the same moments fall on the same beats: stretched to them, pitch kept.
    const slow = score();
    const halved = applyMicrophoneTake(slow, {
      ...loop,
      speed: 0.5,
      starts_at_seconds: -1,
      media: { media_id: 'm_b', name: 'hum.wav', duration: 12 },
    });
    expect(halved).toMatchObject({ at_beats: 3, end_beats: 15, from: 1, until: 9, fit_beats: 8 });
  });

  it('lists which pitch plays what on the part’s kit', () => {
    const doc = score();
    const { pads, other } = partPads(doc, 'p1');
    expect(other).toBe(false);
    expect(pads.find((p) => p.pitch === 36)).toEqual({
      pitch: 36,
      name: 'C2',
      plays: 'kick (C2)',
    });
    expect(pads.find((p) => p.pitch === 38)?.plays).toBe('snare (D2)');
  });
});
