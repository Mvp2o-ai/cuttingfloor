import { describe, expect, it } from 'vitest';
import {
  DEVICE_NAMES,
  deviceKind,
  deviceParamAt,
  deviceParamsApplied,
  deviceParamsSchema,
  deviceParamsText,
} from '../src/devices.ts';
import { pitchName, pitchNumber } from '../src/score.ts';

describe('pitch', () => {
  it('names and numbers agree, with C4 as 60', () => {
    expect(pitchNumber('C4')).toBe(60);
    expect(pitchNumber('A4')).toBe(69);
    expect(pitchNumber('F#2')).toBe(42);
    expect(pitchNumber('Bb2')).toBe(46);
    expect(pitchNumber('C-1')).toBe(0);
    expect(pitchNumber(60.5)).toBe(60.5);
    expect(() => pitchNumber('A9')).toThrow(/outside/);
    expect(pitchName(60)).toEqual({ name: 'C4', cents: 0 });
    expect(pitchName(69.4)).toEqual({ name: 'A4', cents: 40 });
    expect(pitchName(60.5)).toEqual({ name: 'C#4', cents: -50 });
  });
});

describe('device registry', () => {
  it('every device has a kind and a params text', () => {
    for (const name of DEVICE_NAMES) {
      expect(deviceKind(name)).toMatch(/instrument|effect/);
      expect(deviceParamsText(name)).toContain(name);
      expect(deviceParamsSchema(name)).toBeDefined();
    }
  });

  it('holds no chosen number where none is neutral: thresholds are required', () => {
    const compressor = deviceParamsSchema('compressor');
    expect(compressor?.safeParse({}).success).toBe(false);
    expect(
      compressor?.safeParse({ threshold_db: -18, ratio: 4, attack_ms: 10, release_ms: 120 })
        .success,
    ).toBe(true);
    expect(deviceParamsSchema('limiter')?.safeParse({}).success).toBe(false);
    expect(deviceParamsSchema('reverb')?.safeParse({ wet: 0.2 }).success).toBe(false);
  });

  it('refuses unknown params and out-of-range values', () => {
    const eq = deviceParamsSchema('eq');
    expect(eq?.safeParse({ bands: [{ type: 'peak', hz: 2500, gain_db: -4, q: 1 }] }).success).toBe(
      true,
    );
    expect(eq?.safeParse({ bands: [{ type: 'peak', hz: 2500, boost: 3 }] }).success).toBe(false);
    expect(eq?.safeParse({ bands: [{ type: 'peak', hz: 5 }] }).success).toBe(false);
    expect(eq?.safeParse({ bands: [] }).success).toBe(false);
  });

  it('sampler needs a root note or slices; delay takes one time', () => {
    const sampler = deviceParamsSchema('sampler');
    const media_id = `m_${'a'.repeat(26)}`;
    expect(sampler?.safeParse({ media_id }).success).toBe(false);
    expect(sampler?.safeParse({ media_id, root_note: 'C3' }).success).toBe(true);
    expect(
      sampler?.safeParse({
        media_id,
        slices: [{ note: 'D2', from_seconds: 1.2, until_seconds: 1.5 }],
      }).success,
    ).toBe(true);
    const delay = deviceParamsSchema('delay');
    expect(delay?.safeParse({ wet: 0.3 }).success).toBe(false);
    expect(delay?.safeParse({ wet: 0.3, time_beats: 0.5 }).success).toBe(true);
    expect(delay?.safeParse({ wet: 0.3, time_beats: 0.5, time_ms: 250 }).success).toBe(false);
  });

  it('fills published defaults, at every depth, and leaves the rest out', () => {
    expect(deviceParamsApplied('grand_piano', {})).toEqual({ gain_db: 0 });
    expect(deviceParamsApplied('eq', { bands: [{ type: 'highpass', hz: 40 }] })).toEqual({
      bands: [{ type: 'highpass', hz: 40, gain_db: 0, q: 0.71, slope_db_per_octave: '12' }],
    });
    expect(deviceParamsApplied('synth', { oscillators: [{ wave: 'saw' }] })).toEqual({
      oscillators: [{ wave: 'saw', octave: 0, detune_cents: 0, level: 1 }],
      glide_ms: 0,
      gain_db: 0,
    });
  });

  it('finds an automatable param by its path', () => {
    const synth = {
      oscillators: [{ wave: 'saw' }],
      filter: { type: 'lowpass', cutoff_hz: 800 },
    };
    expect(deviceParamAt('synth', synth, 'filter.cutoff_hz')).toEqual({ min: 20, max: 20000 });
    expect(deviceParamAt('synth', synth, 'oscillators[0].level')).toEqual({ min: 0, max: 1 });
    expect(deviceParamAt('synth', synth, 'oscillators[2].level')).toHaveProperty('error');
    expect(deviceParamAt('synth', synth, 'glide_ms')).toHaveProperty('error');
    expect(deviceParamAt('synth', { oscillators: [] }, 'filter.cutoff_hz')).toHaveProperty('error');
    expect(deviceParamAt('eq', { bands: [{ type: 'peak', hz: 100 }] }, 'bands[0].gain_db')).toEqual(
      { min: -24, max: 24 },
    );
  });
});
