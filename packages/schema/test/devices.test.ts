import { describe, expect, it } from 'vitest';
import { musicDevices, type ParamDef } from '../src/device-catalog.ts';
import {
  type DeviceParam,
  deviceKind,
  deviceNames,
  deviceParamAt,
  deviceParamsApplied,
  deviceParamsSchema,
  deviceParamsText,
  devices,
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
    expect(deviceNames().length).toBeGreaterThan(25);
    for (const name of deviceNames()) {
      expect(deviceKind(name)).toMatch(/instrument|effect/);
      expect(deviceParamsText(name)).toContain(name);
      expect(deviceParamsSchema(name)).toBeDefined();
    }
  });

  // The registry is made from the engine's catalog: a range, default or param can only differ
  // where this test says it may.
  it('is the engine catalog param for param, but for the three differences it states', () => {
    const renamed: Record<string, string> = { 'sampler.file': 'sampler.media_id' };
    const stricter = new Set([
      'reverb.decay_seconds',
      'reverb.wet',
      'delay.wet',
      'chorus.rate_hz',
      'chorus.depth',
      'chorus.wet',
      'compressor.attack_ms',
      'compressor.release_ms',
    ]);
    const pitches = new Set(['sampler.root_note', 'sampler.slices[].note']);
    const added = new Set(['delay.time_beats']);
    const seen = new Set<string>();
    const walk = (
      engine: Record<string, ParamDef>,
      ours: Record<string, DeviceParam>,
      at: string,
    ) => {
      for (const [key, e] of Object.entries(engine)) {
        const path = `${at}${key}`;
        const ourPath = renamed[path] ?? path;
        const o = ours[ourPath.slice(at.length)];
        seen.add(ourPath);
        expect(o, path).toBeDefined();
        if (!o) continue;
        if (e.kind === 'object') {
          expect(o.kind).toBe('group');
          if (o.kind === 'group') walk(e.fields, o.params, `${path}.`);
        } else if (e.kind === 'list') {
          expect(o).toMatchObject({ kind: 'list', min: e.min_items, max: e.max_items });
          if (o.kind === 'list') walk(e.fields, o.item, `${path}[].`);
        } else if (e.kind === 'file') {
          expect(o).toMatchObject({ kind: 'media', required: true });
        } else if (pitches.has(path)) {
          expect(o.kind).toBe('pitch');
        } else if (e.kind === 'number' || e.kind === 'integer') {
          expect(o, path).toMatchObject({ kind: 'number', min: e.min, max: e.max });
          if (o.kind !== 'number') continue;
          if (stricter.has(path)) expect(o, path).toMatchObject({ default: null, required: true });
          else if (path === 'delay.time_ms') expect(o.required).toBeUndefined();
          else {
            expect(o.default, path).toBe(e.default ?? null);
            const optional = e.kind === 'number' && e.optional === true;
            expect(o.required === true, path).toBe(e.default === undefined && !optional);
          }
          expect(o.automatable === true, path).toBe(e.kind === 'number' && e.automatable);
        } else if (e.kind === 'choice') {
          expect(o, path).toMatchObject({ kind: 'choice', values: e.choices });
        } else {
          expect(o.kind, path).toBe('boolean');
        }
      }
      for (const key of Object.keys(ours)) {
        const path = `${at}${key}`;
        if (!seen.has(path)) expect(added.has(path), `${path} is not in the engine`).toBe(true);
      }
    };
    const ours = devices();
    expect(Object.keys(ours)).toEqual([...musicDevices().keys()]);
    for (const [name, def] of musicDevices()) {
      const spec = ours[name];
      expect(spec?.kind).toBe(def.kind);
      if (spec) walk(def.params, spec.params, `${name}.`);
      expect(Object.keys(spec?.sounds ?? {}).map(Number)).toEqual(
        (def.pitches ?? []).map((p) => p.pitch),
      );
    }
  });

  it('holds no chosen number where none is neutral: a room, an echo and a squeeze must be given', () => {
    const compressor = deviceParamsSchema('compressor');
    expect(compressor?.safeParse({}).success).toBe(false);
    expect(compressor?.safeParse({ threshold_db: -18, ratio: 4 }).success).toBe(false);
    expect(
      compressor?.safeParse({ threshold_db: -18, ratio: 4, attack_ms: 10, release_ms: 120 })
        .success,
    ).toBe(true);
    expect(deviceParamsSchema('limiter')?.safeParse({}).success).toBe(false);
    expect(deviceParamsSchema('reverb')?.safeParse({ wet: 0.2 }).success).toBe(false);
    expect(deviceParamsSchema('reverb')?.safeParse({ wet: 0.2, decay_seconds: 1.5 }).success).toBe(
      true,
    );
    expect(deviceParamsSchema('chorus')?.safeParse({}).success).toBe(false);
  });

  it('refuses unknown params and out-of-range values', () => {
    const eq = deviceParamsSchema('eq');
    expect(eq?.safeParse({ bands: [{ type: 'peak', hz: 2500, gain_db: -4, q: 1 }] }).success).toBe(
      true,
    );
    expect(eq?.safeParse({ bands: [{ type: 'peak', hz: 2500, boost: 3 }] }).success).toBe(false);
    expect(eq?.safeParse({ bands: [{ type: 'peak', hz: 5 }] }).success).toBe(false);
    expect(eq?.safeParse({ bands: [] }).success).toBe(false);
    const filter = deviceParamsSchema('filter');
    expect(
      filter?.safeParse({ type: 'lowpass', cutoff_hz: 800, slope_db_per_octave: 24 }).success,
    ).toBe(true);
    expect(
      filter?.safeParse({ type: 'lowpass', cutoff_hz: 800, slope_db_per_octave: 18 }).success,
    ).toBe(false);
  });

  it('sampler names media and needs a root note or slices; delay takes one time', () => {
    const sampler = deviceParamsSchema('sampler');
    const media_id = `m_${'a'.repeat(26)}`;
    expect(sampler?.safeParse({ media_id }).success).toBe(false);
    expect(sampler?.safeParse({ media_id, root_note: 'C3' }).success).toBe(true);
    expect(sampler?.safeParse({ file: '/x.wav', root_note: 'C3' }).success).toBe(false);
    expect(
      sampler?.safeParse({
        media_id,
        slices: [{ note: 'D2', from_seconds: 1.2, until_seconds: 1.5 }],
      }).success,
    ).toBe(true);
    const delay = deviceParamsSchema('delay');
    expect(delay?.safeParse({ wet: 0.3 }).success).toBe(false);
    expect(delay?.safeParse({ wet: 0.3, time_beats: 0.5 }).success).toBe(true);
    expect(delay?.safeParse({ wet: 0.3, time_ms: 250 }).success).toBe(true);
    expect(delay?.safeParse({ wet: 0.3, time_beats: 0.5, time_ms: 250 }).success).toBe(false);
  });

  it('fills published defaults, at every depth, and leaves the rest out', () => {
    expect(deviceParamsApplied('kit_808', {})).toEqual({ gain_db: 0 });
    const eq = deviceParamsApplied('eq', { bands: [{ type: 'highpass', hz: 40 }] }) as {
      bands: Array<Record<string, unknown>>;
    };
    expect(eq.bands[0]).toMatchObject({ type: 'highpass', hz: 40, gain_db: 0 });
    // A drum kit says which pitch plays what.
    expect(devices().kit_808?.sounds?.[36]).toBe('kick (C2)');
    expect(deviceParamsText('kit_808')).toContain('36 kick (C2)');
  });

  it('finds an automatable param by its path', () => {
    const synth = {
      oscillators: [{ wave: 'saw' }],
      filter: { type: 'lowpass', cutoff_hz: 800 },
    };
    expect(deviceParamAt('synth', synth, 'filter.cutoff_hz')).toMatchObject({ max: 24000 });
    expect(deviceParamAt('synth', synth, 'oscillators[0].level')).toHaveProperty('min');
    expect(deviceParamAt('synth', synth, 'oscillators[2].level')).toHaveProperty('error');
    expect(deviceParamAt('synth', synth, 'oscillators[0].octave')).toHaveProperty('error');
    expect(deviceParamAt('synth', { oscillators: [] }, 'filter.cutoff_hz')).toHaveProperty('error');
    expect(deviceParamAt('eq', { bands: [{ type: 'peak', hz: 100 }] }, 'bands[0].gain_db')).toEqual(
      { min: -48, max: 48 },
    );
  });
});
