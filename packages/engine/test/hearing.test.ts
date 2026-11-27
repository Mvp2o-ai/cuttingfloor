import { describe, expect, it } from 'vitest';
import {
  BEATS_RATE,
  beatsOf,
  KEY_RATE,
  keyMeter,
  LEVEL_RATE,
  levelsDb,
  NOTES_RATE,
  noteName,
  notesOf,
  onsetsOf,
  spectrumMeter,
  stepMeter,
  THIRD_OCTAVE_HZ,
} from '../src/index.ts';

// The measured sound facts on synthetic signals with known answers: onsets, notes, key,
// spectrum, the level series and the beat candidates. Pure signal math, no engine needed.

/** A seeded noise source, so every run measures the same sound. */
function noise(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 31 - 1;
  };
}

/** A sine of `amp` at `hz` written into `x` from `at` seconds for `seconds`, phase from 0. */
function sine(x: Float32Array, rate: number, hz: number, at: number, seconds: number, amp: number) {
  const a = Math.round(at * rate);
  const n = Math.round(seconds * rate);
  for (let i = 0; i < n && a + i < x.length; i++) {
    x[a + i] = (x[a + i] as number) + amp * Math.sin((2 * Math.PI * hz * i) / rate);
  }
}

const dbOfAmp = (amp: number) => 20 * Math.log10(amp / Math.SQRT2);

describe('onsets', () => {
  // A floor of noise at about -65 dB, and 10 ms tone bursts on the 10 ms steps:
  // 1 kHz at -9, -29 and -49 dB (rises of about 56, 36 and 16 dB), a 100 Hz and an 8 kHz one.
  const rate = LEVEL_RATE;
  const x = new Float32Array(rate * 4);
  const r = noise(7);
  for (let i = 0; i < x.length; i++) x[i] = 0.001 * r();
  const bursts = [
    { at: 0.5, hz: 1000, amp: 0.5 },
    { at: 1.2, hz: 1000, amp: 0.05 },
    { at: 1.9, hz: 1000, amp: 0.005 },
    { at: 2.6, hz: 100, amp: 0.5 },
    { at: 3.3, hz: 8000, amp: 0.5 },
  ];
  for (const b of bursts) sine(x, rate, b.hz, b.at, 0.02, b.amp);
  const meter = stepMeter(rate, 0.01, 0, true);
  // In blocks of odd sizes, as a stream comes.
  for (let i = 0; i < x.length; i += 7777) meter.push([x.subarray(i, i + 7777)]);
  const levels = meter.finish();

  it('finds each rise of threshold_db or more at its step, with the rise in dB', () => {
    const floor = 10 * Math.log10(0.001 ** 2 / 3);
    const found = onsetsOf(levels, 10);
    expect(found.map((o) => o.time)).toEqual([0.5, 1.2, 1.9, 2.6, 3.3]);
    const loud = found[0];
    // The burst's level over the noise floor: -9 dB against about -65.
    expect(loud?.level_db).toBeCloseTo(dbOfAmp(0.5), 0);
    expect(loud?.rise_db as number).toBeGreaterThan(dbOfAmp(0.5) - floor - 1.5);
    expect(loud?.rise_db as number).toBeLessThan(dbOfAmp(0.5) - floor + 1.5);
    expect(found[1]?.level_db).toBeCloseTo(dbOfAmp(0.05), 0);
    expect(found[2]?.rise_db as number).toBeGreaterThan(14);
    expect(found[2]?.rise_db as number).toBeLessThan(19);
  });

  it('returns more with a lower threshold_db and fewer with a higher one', () => {
    const counts = [10, 25, 45, 60].map((t) => onsetsOf(levels, t).length);
    expect(counts).toEqual([5, 4, 3, 0]);
  });

  it('says how much of each onset is low, mid and high', () => {
    const [mid, , , low, high] = onsetsOf(levels, 10);
    expect(mid?.mid).toBeGreaterThan(0.95);
    expect(low?.low).toBeGreaterThan(0.85);
    expect(high?.high).toBeGreaterThan(0.85);
    for (const o of [mid, low, high]) {
      expect((o?.low ?? 0) + (o?.mid ?? 0) + (o?.high ?? 0)).toBeCloseTo(1, 1);
    }
  });

  it('counts a step after digital silence as rising from nothing', () => {
    const y = new Float32Array(rate);
    sine(y, rate, 440, 0.5, 0.1, 0.5);
    const m = stepMeter(rate, 0.05, 2);
    m.push([y]);
    const found = onsetsOf(m.finish(), 3);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ time: 2.5, rise_db: null });
  });
});

describe('level on steps', () => {
  it('follows a ramped tone, the same on one channel as on two alike', () => {
    // 440 Hz rising 10 dB a second from -40 dB over 3 s.
    const rate = LEVEL_RATE;
    const x = new Float32Array(rate * 3);
    for (let i = 0; i < x.length; i++) {
      const db = -40 + (10 * i) / rate;
      x[i] = Math.SQRT2 * 10 ** (db / 20) * Math.sin((2 * Math.PI * 440 * i) / rate);
    }
    const one = stepMeter(rate, 0.5, 0);
    one.push([x]);
    const levels = levelsDb(one.finish());
    expect(levels).toHaveLength(6);
    // Each step's level is the RMS of a 5 dB ramp: a little over its middle.
    levels.forEach((l, i) => {
      expect(l as number).toBeGreaterThan(-40 + 5 * i + 2.4);
      expect(l as number).toBeLessThan(-40 + 5 * i + 3.2);
    });
    const two = stepMeter(rate, 0.5, 0);
    two.push([x, x]);
    expect(levelsDb(two.finish())).toEqual(levels);
  });

  it('measures a short last step over what it has, and silence as null', () => {
    const rate = LEVEL_RATE;
    const x = new Float32Array(Math.round(rate * 1.25));
    sine(x, rate, 1000, 0, 0.5, 0.5);
    const m = stepMeter(rate, 0.5, 10);
    m.push([x]);
    const s = m.finish();
    expect(s.start).toBe(10);
    expect(levelsDb(s)).toEqual([expect.closeTo(dbOfAmp(0.5), 1), null, null]);
    expect(s.meanSquares).toHaveLength(3);
  });
});

describe('notes', () => {
  const rate = NOTES_RATE;
  const x = new Float32Array(rate * 4);
  // A3, C#4 and E4 for 0.4 s each; a gap; A4 held 1 s with a dip to a fifth of its level
  // between 1.9 and 2.0 s (struck again on one pitch); a gap; A4 40 cents sharp.
  sine(x, rate, 220, 0, 0.4, 0.5);
  sine(x, rate, 277.18, 0.4, 0.4, 0.5);
  sine(x, rate, 329.63, 0.8, 0.4, 0.5);
  for (let i = 0; i < rate; i++) {
    const t = i / rate;
    const amp = t >= 0.5 && t < 0.6 ? 0.1 : 0.5;
    x[Math.round(1.4 * rate) + i] = amp * Math.sin(2 * Math.PI * 440 * t);
  }
  const sharp = 440 * 2 ** (40 / 1200);
  sine(x, rate, sharp, 2.6, 0.5, 0.5);

  it('reads each note: start, end, pitch, its name and cents', async () => {
    const notes = await notesOf(x, 0, { splitCents: 50, minSeconds: 0.1 });
    expect(notes.map((n) => n.note)).toEqual(['A3', 'C#4', 'E4', 'A4', 'A4']);
    const starts = [0, 0.4, 0.8, 1.4, 2.6];
    notes.forEach((n, i) => {
      expect(Math.abs(n.start - (starts[i] as number))).toBeLessThan(0.04);
    });
    expect(notes[0]?.hz).toBeCloseTo(220, 0);
    expect(Math.abs(notes[0]?.cents ?? 99)).toBeLessThanOrEqual(2);
    expect(Math.abs((notes[0]?.end ?? 0) - 0.4)).toBeLessThan(0.04);
    // The held A4 is one note through the dip without threshold_db.
    expect(Math.abs((notes[3]?.end ?? 0) - 2.4)).toBeLessThan(0.04);
    expect(notes[3]?.level_db).toBeCloseTo(-9.5, 0);
    expect(notes[4]?.cents).toBeGreaterThanOrEqual(38);
    expect(notes[4]?.cents).toBeLessThanOrEqual(42);
    expect(notes[4]?.hz).toBeCloseTo(sharp, 0);
  });

  it('splits a note struck again on one pitch only with threshold_db', async () => {
    const notes = await notesOf(x, 0, {
      splitCents: 50,
      minSeconds: 0.1,
      thresholdDb: 6,
      step: 0.05,
    });
    expect(notes.map((n) => n.note)).toEqual(['A3', 'C#4', 'E4', 'A4', 'A4', 'A4']);
    expect(Math.abs((notes[4]?.start ?? 0) - 2.0)).toBeLessThan(0.03);
  });

  it('leaves out notes shorter than min_seconds, and moves on split_cents', async () => {
    expect(await notesOf(x, 0, { splitCents: 50, minSeconds: 0.45 })).toHaveLength(2);
    // With 500 cents to split on, A3 to C#4 (400 cents) is one note; C#4 to E4 (300) too.
    const wide = await notesOf(x, 0, { splitCents: 500, minSeconds: 0.1 });
    expect(wide).toHaveLength(3);
  });

  it('gives each note in beats with a tempo, from first_bar_seconds', async () => {
    const notes = await notesOf(x, 10, {
      splitCents: 50,
      minSeconds: 0.1,
      tempo: 120,
      firstBarSeconds: 10.4,
    });
    expect(notes[0]?.start).toBeCloseTo(10, 1);
    expect(notes[1]?.start_beats).toBeCloseTo(0, 0);
    expect(notes[2]?.start_beats).toBeCloseTo(0.8, 1);
    expect(notes[2]?.length_beats).toBeCloseTo(0.8, 1);
  });

  it('names notes in equal temperament from A4 = 440 Hz', () => {
    expect(noteName(440)).toEqual({ note: 'A4', cents: 0 });
    expect(noteName(261.63)).toEqual({ note: 'C4', cents: 0 });
    expect(noteName(440 * 2 ** (-30 / 1200))).toEqual({ note: 'A4', cents: -30 });
    expect(noteName(440 * 2 ** (60 / 1200))).toEqual({ note: 'A#4', cents: -40 });
  });
});

describe('key', () => {
  const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const rate = KEY_RATE;

  it('scores C major highest for a C major scale', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72];
    const x = new Float32Array(Math.round(rate * 0.5 * scale.length));
    scale.forEach((m, i) => {
      sine(x, rate, midiHz(m), 0.5 * i, 0.5, 0.3);
    });
    const meter = keyMeter(rate, 0, 0.5);
    meter.push([x]);
    const k = meter.finish();
    const ranked = Object.entries(k.scores).sort((a, b) => b[1] - a[1]);
    expect(ranked[0]?.[0]).toBe('C major');
    expect(Object.keys(k.scores)).toHaveLength(24);
    for (const v of Object.values(k.scores)) expect(v >= 0 && v <= 1).toBe(true);
    // The black keys are weak over the whole scale.
    expect(k.notes['C#']).toBeLessThan(0.3);
    // Steps: about the scale's note in each step.
    const steps = k.steps?.notes ?? [];
    expect(steps.length).toBe(8);
    expect(steps[2]?.indexOf(1)).toBe(4); // E
  });

  it('scores A minor highest for Am, Dm, E, Am', () => {
    const chords = [
      [57, 60, 64],
      [62, 65, 69],
      [56, 59, 64],
      [57, 60, 64],
    ];
    const x = new Float32Array(rate * 4);
    chords.forEach((c, i) => {
      for (const m of c) sine(x, rate, midiHz(m), i, 1, 0.2);
    });
    const meter = keyMeter(rate, 0);
    meter.push([x]);
    const k = meter.finish();
    const ranked = Object.entries(k.scores).sort((a, b) => b[1] - a[1]);
    expect(ranked[0]?.[0]).toBe('A minor');
    expect(k.steps).toBeUndefined();
  });
});

describe('spectrum', () => {
  const rate = LEVEL_RATE;
  const band = (hz: number) => THIRD_OCTAVE_HZ.indexOf(hz as never);

  it('puts a tone in its third-octave band at its level', () => {
    const x = new Float32Array(rate * 2);
    sine(x, rate, 1000, 0, 2, 0.5);
    const meter = spectrumMeter(rate, 0);
    meter.push([x]);
    const s = meter.finish();
    expect(s.bands_hz).toHaveLength(31);
    expect(s.bands_hz[0]).toBe(20);
    expect(s.bands_hz.at(-1)).toBe(20000);
    expect(s.level_db[band(1000)]).toBeCloseTo(dbOfAmp(0.5), 0);
    expect(s.level_db[band(100)] ?? -999).toBeLessThan(-60);
    expect(s.level_db[band(10000)] ?? -999).toBeLessThan(-60);
  });

  it('follows the sound per step, and band-limited noise stays in its bands', () => {
    // 100 Hz for 1 s, then noise high-passed above about 5 kHz for 1 s.
    const x = new Float32Array(rate * 2);
    sine(x, rate, 100, 0, 1, 0.5);
    const r = noise(3);
    let prev = 0;
    for (let i = rate; i < 2 * rate; i++) {
      const v = r();
      // First difference twice: a steep tilt towards the top.
      x[i] = 0.25 * (v - prev);
      prev = v;
    }
    const meter = spectrumMeter(rate, 5, 0.5);
    meter.push([x]);
    const s = meter.finish();
    const steps = s.steps?.level_db ?? [];
    expect(steps).toHaveLength(4);
    const loudest = (row: Array<number | null> | null) =>
      s.bands_hz[
        (row ?? []).reduce<number>((b, v, i, a) => ((v ?? -999) > (a[b] ?? -999) ? i : b), 0)
      ];
    expect(loudest(steps[0] ?? null)).toBe(100);
    expect(loudest(steps[3] ?? null) ?? 0).toBeGreaterThanOrEqual(10000);
    expect(steps[3]?.[band(100)] ?? -999).toBeLessThan((steps[3]?.[band(16000)] ?? 0) - 30);
    expect(s.steps?.start).toBe(5);
  });
});

describe('beat candidates', () => {
  // A click track at 120 BPM for 16 s, accented every fourth beat (from the first).
  const rate = BEATS_RATE;
  const x = new Float32Array(rate * 16);
  const r = noise(11);
  for (let b = 0; b < 32; b++) {
    const at = Math.round((0.25 + b * 0.5) * rate);
    const amp = b % 4 === 0 ? 1 : 0.15;
    for (let i = 0; i < 0.02 * rate; i++) x[at + i] = amp * r() * Math.exp(-i / (0.004 * rate));
  }
  const beats = beatsOf(x);

  it('finds the tempo with half and double time among the candidates', () => {
    expect(beats.bpm).toBeCloseTo(120, 0);
    expect(beats.fitted_bpm).toBeCloseTo(120, 0);
    const near = (bpm: number) =>
      beats.tempo_candidates.find((c) => Math.abs(c.bpm - bpm) < 1.5)?.strength ?? 0;
    expect(near(120)).toBeGreaterThan(0.5);
    expect(near(60)).toBeGreaterThan(0.5);
    expect(beats.tempo_candidates[0]?.strength).toBe(1);
  });

  it('gives each beat a bar could start on, the accented one strongest in 4', () => {
    const four = beats.bar_candidates.filter((c) => c.beats_in_bar === 4);
    expect(four).toHaveLength(4);
    const top = four.reduce((a, b) => (b.accent > a.accent ? b : a));
    // The accented clicks are at 0.25 + 2k s.
    expect(((top.seconds - 0.25) / 2) % 1).toBeCloseTo(0, 1);
    for (const c of four) if (c !== top) expect(c.accent).toBeLessThan(top.accent * 0.8);
    expect(new Set(beats.bar_candidates.map((c) => c.beats_in_bar))).toEqual(
      new Set([2, 3, 4, 5, 6, 7]),
    );
  });
});
