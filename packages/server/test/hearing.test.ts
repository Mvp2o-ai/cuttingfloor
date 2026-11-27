import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HEARING_LIMITS, MediaAnalyzeResult } from '@cuttingfloor/schema';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

// The sound facts of media.analyze through the SDK client (onsets, notes, key, spectrum, the
// level on steps, beat candidates), their refusals and limits. Media needs FFmpeg; a timeline's
// mix needs melt too. Each part skips without them unless CUTTINGFLOOR_REQUIRE_ENGINES says they
// must be there.

const exec = promisify(execFile);
const has = (bin: string, flag: string) =>
  exec(bin, [flag]).then(
    () => true,
    () => false,
  );
const ffmpeg = await has('ffmpeg', '-version');
const melt = ffmpeg && (await has('melt', '--version'));
if (process.env.CUTTINGFLOOR_REQUIRE_ENGINES && !melt) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but FFmpeg or melt is missing');
}

const ff = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);

/** Mono 32-bit float WAV of `x` at `rate`. */
function wav(x: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + x.length * 4);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + x.length * 4, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(3, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 4, 28);
  out.writeUInt16LE(4, 32);
  out.writeUInt16LE(32, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(x.length * 4, 40);
  for (let i = 0; i < x.length; i++) out.writeFloatLE(x[i] as number, 44 + i * 4);
  return out;
}

function sine(x: Float32Array, rate: number, hz: number, at: number, seconds: number, amp: number) {
  const a = Math.round(at * rate);
  for (let i = 0; i < Math.round(seconds * rate) && a + i < x.length; i++) {
    x[a + i] = (x[a + i] as number) + amp * Math.sin((2 * Math.PI * hz * i) / rate);
  }
}

const RATE = 48_000;
const dbOfAmp = (amp: number) => 20 * Math.log10(amp / Math.SQRT2);
const strict = MediaAnalyzeResult.strict();

describe.skipIf(!ffmpeg)('sound facts', () => {
  let env: TestEnv;
  let client: Client;
  const ids: Record<string, string> = {};

  async function importFile(path: string): Promise<string> {
    const started = await ok<{ job_id?: string; media_id: string }>(client, 'media.import', {
      source: { path },
    });
    if (started.job_id) {
      const done = await settled(client, started.job_id, 120_000);
      expect(done.status).toBe('completed');
    }
    return started.media_id;
  }

  /** A media.analyze call to its end: the result, checked against the declared schema. */
  async function analyze(args: Record<string, unknown>) {
    const res = await call(client, 'media.analyze', args);
    if (res.isError) return res;
    const id = res.structured.job_id as string;
    const done = await settled<{ result?: Record<string, unknown>; error?: unknown }>(
      client,
      id,
      120_000,
    );
    if (!done.result) {
      return { isError: true, structured: (done.error ?? {}) as Record<string, unknown> };
    }
    strict.parse(done.result);
    return { isError: false, structured: done.result };
  }

  beforeAll(async () => {
    env = await testRuntime();
    client = await connect(env.runtime);
    const m = env.mediaDir;
    // Clicks: noise at about -65 dB and 20 ms bursts of 1 kHz at -9, -29 and -49 dB.
    const clicks = new Float32Array(RATE * 3);
    let seed = 5;
    for (let i = 0; i < clicks.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      clicks[i] = 0.001 * (seed / 2 ** 31 - 1);
    }
    for (const [at, amp] of [
      [0.5, 0.5],
      [1.2, 0.05],
      [1.9, 0.005],
    ] as const)
      sine(clicks, RATE, 1000, at, 0.02, amp);
    await writeFile(join(m, 'clicks.wav'), wav(clicks, RATE));
    // A tune: A3, C#4, E4, then A4 40 cents sharp, 0.4 s each with 0.1 s gaps.
    const tune = new Float32Array(RATE * 2.2);
    const sharp = 440 * 2 ** (40 / 1200);
    [220, 277.18, 329.63, sharp].forEach((hz, i) => {
      sine(tune, RATE, hz, 0.1 + 0.5 * i, 0.4, 0.5);
    });
    await writeFile(join(m, 'tune.wav'), wav(tune, RATE));
    // A C major scale, 0.5 s a note, then 1 kHz for a second.
    const scale = new Float32Array(RATE * 5);
    [60, 62, 64, 65, 67, 69, 71, 72].forEach((n, i) => {
      sine(scale, RATE, 440 * 2 ** ((n - 69) / 12), 0.5 * i, 0.5, 0.3);
    });
    sine(scale, RATE, 1000, 4, 1, 0.5);
    await writeFile(join(m, 'scale.wav'), wav(scale, RATE));
    // A click track at 120 BPM accented every fourth beat, as a compressed file.
    await ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(mod(t-0.25,0.5),0.02),(if(lt(mod(t-0.25,2),0.1),1,0.15))*sin(2*PI*2000*t)*exp(-200*mod(t-0.25,0.5)),0)':s=22050:d=16",
      join(m, 'beat.flac'),
    ]);
    // Silence 700 s long: past the limits on reading and on steps, cheap to import.
    await ff([
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-t',
      '700',
      '-c:a',
      'flac',
      join(m, 'long.flac'),
    ]);
    for (const name of ['clicks.wav', 'tune.wav', 'scale.wav', 'beat.flac', 'long.flac']) {
      ids[name.replace(/\..*/, '')] = await importFile(join(m, name));
    }
  }, 240_000);

  afterAll(() => env?.runtime.stop());

  it('onsets: each rise of threshold_db over the step before, with its size and bands', async () => {
    const res = await analyze({
      media_id: ids.clicks,
      kind: 'onsets',
      every_seconds: 0.01,
      threshold_db: 10,
    });
    expect(res.isError).toBe(false);
    const o = res.structured.onsets as {
      every_seconds: number;
      threshold_db: number;
      onsets: Array<{ time: number; rise_db: number; level_db: number; mid: number }>;
    };
    expect(o.every_seconds).toBe(0.01);
    expect(o.onsets.map((x) => x.time)).toEqual([0.5, 1.2, 1.9]);
    expect(o.onsets[0]?.level_db).toBeCloseTo(dbOfAmp(0.5), 0);
    expect(o.onsets[0]?.rise_db).toBeGreaterThan(50);
    expect(o.onsets[0]?.mid).toBeGreaterThan(0.95);
    const counts: number[] = [];
    for (const threshold_db of [10, 25, 45]) {
      const r = await analyze({
        media_id: ids.clicks,
        kind: 'onsets',
        every_seconds: 0.01,
        threshold_db,
      });
      counts.push((r.structured.onsets as { onsets: unknown[] }).onsets.length);
    }
    expect(counts).toEqual([3, 2, 1]);
    // A range starting on the click: the step before it is read, so the click still rises.
    const ranged = await analyze({
      media_id: ids.clicks,
      kind: 'onsets',
      every_seconds: 0.01,
      threshold_db: 10,
      from_seconds: 1.2,
      until_seconds: 2.5,
    });
    const times = (ranged.structured.onsets as { onsets: Array<{ time: number }> }).onsets;
    expect(times.map((x) => x.time)).toEqual([1.2, 1.9]);
  });

  it('notes: pitch, name, cents and beats of a tune', async () => {
    const res = await analyze({
      media_id: ids.tune,
      kind: 'notes',
      split_cents: 50,
      min_seconds: 0.1,
      tempo: 120,
      first_bar_seconds: 0.1,
    });
    expect(res.isError).toBe(false);
    const n = res.structured.notes as {
      method: string;
      notes: Array<{ start: number; note: string; cents: number; hz: number; start_beats: number }>;
    };
    expect(n.method).toMatch(/yin/);
    expect(n.notes.map((x) => x.note)).toEqual(['A3', 'C#4', 'E4', 'A4']);
    expect(n.notes[3]?.cents).toBeGreaterThanOrEqual(38);
    expect(n.notes[3]?.cents).toBeLessThanOrEqual(42);
    expect(n.notes[1]?.start).toBeCloseTo(0.6, 1);
    expect(n.notes[1]?.start_beats).toBeCloseTo(1, 1);
    expect(n.notes[3]?.start_beats).toBeCloseTo(3, 1);
  });

  it('key and spectrum: over the range, and per step with every_seconds', async () => {
    const key = await analyze({
      media_id: ids.scale,
      kind: 'key',
      until_seconds: 4,
      every_seconds: 0.5,
    });
    const k = key.structured.key as {
      scores: Record<string, number>;
      notes: Record<string, number>;
      steps: { every_seconds: number; notes: Array<number[] | null> };
    };
    expect(Object.keys(k.scores)).toHaveLength(24);
    expect(Object.entries(k.scores).sort((a, b) => b[1] - a[1])[0]?.[0]).toBe('C major');
    expect(Object.keys(k.notes)).toEqual([
      'C',
      'C#',
      'D',
      'D#',
      'E',
      'F',
      'F#',
      'G',
      'G#',
      'A',
      'A#',
      'B',
    ]);
    expect(k.steps.notes).toHaveLength(8);
    const spectrum = await analyze({ media_id: ids.scale, kind: 'spectrum', from_seconds: 4 });
    const s = spectrum.structured.spectrum as { bands_hz: number[]; level_db: number[] };
    expect(s.bands_hz).toHaveLength(31);
    expect(s.level_db[s.bands_hz.indexOf(1000)]).toBeCloseTo(dbOfAmp(0.5), 0);
    expect(spectrum.structured.spectrum).not.toHaveProperty('steps');
    const stepped = await analyze({
      media_id: ids.scale,
      kind: 'spectrum',
      every_seconds: 1,
    });
    expect(
      (stepped.structured.spectrum as { steps: { level_db: unknown[] } }).steps.level_db,
    ).toHaveLength(5);
  });

  it('loudness: unchanged without every_seconds, and the level on steps with it', async () => {
    const plain = await analyze({ media_id: ids.scale, kind: 'loudness' });
    expect(Object.keys(plain.structured.loudness as object).sort()).toEqual(
      [
        'integrated_lufs',
        'true_peak_dbtp',
        'loudness_range_lu',
        'rms_dbfs',
        'noise_floor_dbfs',
        'channels',
        'from',
        'until',
      ].sort(),
    );
    const stepped = await analyze({ media_id: ids.scale, kind: 'loudness', every_seconds: 0.5 });
    const steps = (stepped.structured.loudness as { steps: { level_db: number[]; start: number } })
      .steps;
    expect(steps.start).toBe(0);
    expect(steps.level_db).toHaveLength(10);
    expect(steps.level_db[0]).toBeCloseTo(dbOfAmp(0.3), 0);
    expect(steps.level_db[9]).toBeCloseTo(dbOfAmp(0.5), 0);
  });

  it('beats: today’s fields, and tempo candidates, a fitted tempo and bar candidates', async () => {
    const res = await analyze({ media_id: ids.beat, kind: 'beats' });
    const b = (
      res.structured.beats
        ? res.structured.beats
        : (
            await ok<{ beats: Record<string, unknown> }>(client, 'media.get', {
              media_id: ids.beat,
              include: ['beats'],
            })
          ).beats
    ) as {
      bpm: number;
      beats: number[];
      downbeats: number[];
      strengths: number[];
      tempo_candidates: Array<{ bpm: number; strength: number }>;
      fitted_bpm: number;
      bar_candidates: Array<{ beats_in_bar: number; seconds: number; accent: number }>;
    };
    expect(b.bpm).toBeCloseTo(120, 0);
    expect(b.strengths.length).toBe(b.beats.length);
    expect(b.downbeats.length).toBeGreaterThan(0);
    expect(b.fitted_bpm).toBeCloseTo(120, 0);
    expect(b.tempo_candidates.some((c) => Math.abs(c.bpm - 60) < 1.5)).toBe(true);
    const four = b.bar_candidates.filter((c) => c.beats_in_bar === 4);
    const top = four.reduce((a, c) => (c.accent > a.accent ? c : a));
    expect(((top.seconds - 0.25) / 2) % 1).toBeCloseTo(0, 1);
  });

  it('refuses a missing argument, a step under a kind’s least, and a wrong threshold sign', async () => {
    const refused = async (args: Record<string, unknown>, code: string, message: RegExp) => {
      const res = await call(client, 'media.analyze', { media_id: ids.clicks, ...args });
      expect(res.isError).toBe(true);
      expect(res.structured).toMatchObject({ code });
      expect(String(res.structured.message)).toMatch(message);
    };
    await refused(
      { kind: 'onsets', threshold_db: 10 },
      'bad_request',
      /every_seconds and threshold_db/,
    );
    await refused(
      { kind: 'onsets', every_seconds: 0.01 },
      'bad_request',
      /every_seconds and threshold_db/,
    );
    await refused(
      { kind: 'onsets', every_seconds: 0.01, threshold_db: -3 },
      'bad_request',
      /above 0/,
    );
    await refused(
      { kind: 'notes', min_seconds: 0.1 },
      'bad_request',
      /split_cents and min_seconds/,
    );
    await refused(
      { kind: 'notes', split_cents: 50, min_seconds: 0.1, threshold_db: 6 },
      'bad_request',
      /needs every_seconds/,
    );
    await refused(
      { kind: 'spectrum', every_seconds: 0.05 },
      'limit_exceeded',
      new RegExp(`${HEARING_LIMITS.minStep.spectrum} s or more`),
    );
    await refused({ kind: 'silence', threshold_db: 6, min_seconds: 1 }, 'bad_request', /-100 to 0/);
    await refused({ kind: 'colour', every_seconds: 0.01 }, 'bad_request', /0.04/);
  });

  it('refuses past the limits that protect the server, with the number', async () => {
    const res = (args: Record<string, unknown>) =>
      call(client, 'media.analyze', { media_id: ids.long, ...args });
    const notes = await res({ kind: 'notes', split_cents: 50, min_seconds: 0.1 });
    expect(notes.structured).toMatchObject({ code: 'limit_exceeded' });
    expect(String(notes.structured.message)).toContain(`${HEARING_LIMITS.seconds.notes} s`);
    const steps = await res({ kind: 'loudness', every_seconds: 0.01 });
    expect(steps.structured).toMatchObject({ code: 'limit_exceeded' });
    expect(String(steps.structured.message)).toContain(`${HEARING_LIMITS.steps.loudness} steps`);
    const spectrum = await res({ kind: 'spectrum', every_seconds: 0.1 });
    expect(String(spectrum.structured.message)).toContain(`${HEARING_LIMITS.steps.spectrum} steps`);
    // Inside them, the same calls run.
    const fits = await analyze({
      media_id: ids.long,
      kind: 'loudness',
      every_seconds: 0.05,
      until_seconds: 100,
    });
    const level = (fits.structured.loudness as { steps: { level_db: unknown[] } }).steps.level_db;
    expect(level).toHaveLength(2000);
    expect(level[0]).toBeNull();
  });

  it('refuses more onsets than a call returns, with the number', async () => {
    // A 1 kHz tone switched on and off every 10 ms for 110 s: an onset every 20 ms.
    const file = join(env.mediaDir, 'buzz.flac');
    await ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.5*sin(2*PI*1000*t)*mod(floor(t*100),2)':s=8000:d=110",
      '-c:a',
      'flac',
      file,
    ]);
    const media_id = await importFile(file);
    const res = await analyze({ media_id, kind: 'onsets', every_seconds: 0.01, threshold_db: 6 });
    expect(res.isError).toBe(true);
    expect(res.structured).toMatchObject({ code: 'limit_exceeded' });
    expect(String(res.structured.message)).toContain(`up to ${HEARING_LIMITS.onsets}`);
    const fewer = await analyze({
      media_id,
      kind: 'onsets',
      every_seconds: 0.01,
      threshold_db: 6,
      until_seconds: 10,
    });
    const found = (fewer.structured.onsets as { onsets: unknown[] }).onsets.length;
    expect(found).toBeGreaterThan(450);
    expect(found).toBeLessThanOrEqual(500);
  });

  describe.skipIf(!melt)('on a timeline', () => {
    it('reads the edit’s mix in timeline seconds', async () => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'clicks',
        sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } },
      });
      const added = await ok<{ timeline_id: string }>(client, 'clip.add', {
        timeline_id,
        track_id: 't2',
        media_id: ids.clicks,
        at_frame: 50,
        preview: 'none',
      });
      const res = await analyze({
        timeline_id: added.timeline_id,
        kind: 'onsets',
        every_seconds: 0.01,
        threshold_db: 25,
      });
      expect(res.isError).toBe(false);
      // The clip starts at 2 s, after digital silence: its first step rises from nothing.
      const found = (res.structured.onsets as { onsets: Array<{ time: number; rise_db: null }> })
        .onsets;
      expect(found.map((x) => x.time)).toEqual([2, 2.5, 3.2]);
      expect(found[0]?.rise_db).toBeNull();
    });
  });
});
