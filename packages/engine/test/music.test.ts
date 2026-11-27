import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CfError } from '@cuttingfloor/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BIN,
  checkMusicProject,
  fft,
  MUSIC_CONTENT,
  MUSIC_LIMITS,
  type MusicProjectInput,
  musicDevices,
  renderMusic,
} from '../src/index.ts';

// The music engine end to end: projects through renderMusic into cf-music and back, measured
// from the samples. Needs cf-music, its content and FFmpeg (the image has all three); skipped
// elsewhere unless CUTTINGFLOOR_REQUIRE_ENGINES says they must be there.

const exec = promisify(execFile);

async function have(): Promise<boolean> {
  try {
    await exec(BIN.ffmpeg, ['-version']);
    const { stdout } = await exec(BIN.music, ['catalog', '--content', MUSIC_CONTENT]);
    return stdout.includes('grand_piano') && stdout.includes('kit_909');
  } catch {
    return false;
  }
}
const ready = await have();
if (!ready && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error(
    'CUTTINGFLOOR_REQUIRE_ENGINES is set but cf-music, its content or FFmpeg is missing',
  );
}

const SR = 48000;
let dir = '';

// --- measuring ------------------------------------------------------------------------------

interface Wav {
  rate: number;
  left: Float64Array;
  right: Float64Array;
}

async function readWav(file: string): Promise<Wav> {
  const b = await readFile(file);
  let at = 12;
  let rate = 0;
  let bits = 0;
  let channels = 0;
  while (at < b.length) {
    const id = b.toString('ascii', at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(at + 10);
      rate = b.readUInt32LE(at + 12);
      bits = b.readUInt16LE(at + 22);
    } else if (id === 'data') {
      const frames = size / (channels * (bits / 8));
      const left = new Float64Array(frames);
      const right = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < 2; c++) {
          const o = at + 8 + (i * channels + Math.min(c, channels - 1)) * 3;
          const v = b.readIntLE(o, 3) / 8388608;
          if (c === 0) left[i] = v;
          else right[i] = v;
        }
      }
      expect(bits).toBe(24);
      return { rate, left, right };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`no data in ${file}`);
}

const span = (x: Float64Array, from: number, until: number, rate = SR) =>
  x.subarray(Math.round(from * rate), Math.round(until * rate));

function rmsDb(x: Float64Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return 10 * Math.log10(s / Math.max(1, x.length) + 1e-30);
}

function peak(x: Float64Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

/** Frequency of a steady tone from its rising zero crossings (linear interpolation). */
function frequency(x: Float64Array, rate = SR): number {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1] as number;
    const b = x[i] as number;
    if (a < 0 && b >= 0) crossings.push(i - 1 + a / (a - b));
  }
  const first = crossings[0] as number;
  const last = crossings.at(-1) as number;
  return ((crossings.length - 1) * rate) / (last - first);
}

/** Level of one frequency (Goertzel), dB relative to a full-scale sine. */
function toneDb(x: Float64Array, hz: number, rate = SR): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1));
    const s = (x[i] as number) * hann + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return 20 * Math.log10((2 * Math.sqrt(power)) / (x.length * 0.5) + 1e-30);
}

/** Mean power spectrum (Hann, 8192-point frames, half overlap): power per bin. */
function spectrum(x: Float64Array): Float64Array {
  const n = 8192;
  const out = new Float64Array(n / 2);
  let frames = 0;
  for (let start = 0; start + n <= x.length; start += n / 2) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++)
      re[i] = (x[start + i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    fft(re, im);
    for (let k = 0; k < n / 2; k++)
      out[k] = (out[k] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    frames++;
  }
  for (let k = 0; k < n / 2; k++) out[k] = (out[k] as number) / frames;
  return out;
}

/** Mean power in a sixth of an octave around hz, dB. */
function bandDb(power: Float64Array, hz: number, rate = SR): number {
  const bin = rate / 8192;
  const lo = Math.floor((hz * 2 ** (-1 / 12)) / bin);
  const hi = Math.ceil((hz * 2 ** (1 / 12)) / bin);
  let s = 0;
  for (let k = lo; k <= hi; k++) s += power[k] as number;
  return 10 * Math.log10(s / (hi - lo + 1));
}

/**
 * True peak by band-limited interpolation: each 8192-sample stretch (with 1024 either side, so
 * the edges do not matter) is upsampled 16x by zero-padding its spectrum. Linear.
 */
function truePeak(x: Float64Array): number {
  const n = 8192;
  const pad = 1024;
  const up = 16;
  let p = peak(x);
  for (let start = 0; start < x.length; start += n - 2 * pad) {
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = (x[start + i - pad] as number) || 0;
    fft(re, im);
    const bigRe = new Float64Array(n * up);
    const bigIm = new Float64Array(n * up);
    for (let k = 0; k < n / 2; k++) {
      bigRe[k] = re[k] as number;
      bigIm[k] = im[k] as number;
      if (k > 0) {
        bigRe[n * up - k] = re[n - k] as number;
        bigIm[n * up - k] = im[n - k] as number;
      }
    }
    fft(bigRe, bigIm, true);
    for (let i = pad * up; i < (n - pad) * up; i++)
      p = Math.max(p, Math.abs(bigRe[i] as number) * up); // the inverse divides by n * up
  }
  return p;
}

const sha = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

// --- projects ------------------------------------------------------------------------------

const sineSynth = (id: string, level = 0.5, octave = 0) => ({
  id,
  name: 'synth',
  params: { oscillators: [{ wave: 'sine', level, octave }], amp_envelope: {} },
});

const tone = (id: string, pitch: number, start: number, length: number, extra = {}) => ({
  id,
  devices: [sineSynth(`${id}-synth`)],
  notes: [{ start, length, pitch, velocity: 127 }],
  ...extra,
});

/** A small song: kit, bass synth, piano and strings, reverb on a send, limiter on the master. */
function song(seconds: number): MusicProjectInput {
  const beat = 0.5;
  const beats = Math.floor(seconds / beat);
  const drums = [];
  const bass = [];
  const keys = [];
  for (let b = 0; b < beats; b++) {
    drums.push({ start: b * beat, length: 0.1, pitch: b % 2 ? 38 : 36, velocity: 110 });
    drums.push({ start: b * beat, length: 0.1, pitch: 42, velocity: 70 });
    drums.push({ start: b * beat + 0.25, length: 0.1, pitch: 42, velocity: 50 });
    bass.push({
      start: b * beat,
      length: 0.4,
      pitch: [36, 36, 41, 43][Math.floor(b / 2) % 4] as number,
      velocity: 100,
    });
    if (b % 4 === 0) {
      for (const p of [60, 64, 67])
        keys.push({ start: b * beat, length: 1.8, pitch: p, velocity: 80 });
    }
  }
  return {
    sample_rate: 48000,
    until: seconds,
    tracks: [
      {
        id: 'drums',
        devices: [{ id: 'kit', name: 'kit_808' }],
        notes: drums,
        sends: [{ id: 'drums-verb', to: 'verb', level_db: -18 }],
      },
      {
        id: 'bass',
        devices: [
          {
            id: 'bass-synth',
            name: 'synth',
            params: {
              oscillators: [
                { wave: 'saw', level: 0.4 },
                { wave: 'square', octave: -1, level: 0.2 },
                { wave: 'noise', level: 0.01 },
              ],
              filter: { type: 'lowpass', cutoff_hz: 500, resonance: 1.5, slope_db_per_octave: 24 },
              amp_envelope: { attack_ms: 2, decay_ms: 200, sustain: 0.6, release_ms: 60 },
              filter_envelope: { decay_ms: 150, sustain: 0, amount_octaves: 2 },
              gain_db: -6,
            },
          },
          { id: 'bass-sat', name: 'saturation', params: { drive_db: 6, wet: 0.5 } },
        ],
        notes: bass,
      },
      {
        id: 'keys',
        pan: -0.2,
        devices: [
          { id: 'piano', name: 'grand_piano' },
          { id: 'keys-chorus', name: 'chorus', params: { rate_hz: 0.7, depth: 0.4, wet: 0.3 } },
        ],
        notes: keys,
        sends: [{ id: 'keys-verb', to: 'verb', level_db: -9 }],
      },
      {
        id: 'pad',
        gain_db: -10,
        pan: 0.2,
        devices: [
          { id: 'strings', name: 'strings', params: { attack_ms: 300 } },
          { id: 'pad-delay', name: 'delay', params: { time_ms: 375, feedback: 0.3, wet: 0.2 } },
        ],
        notes: [{ start: 0, length: seconds - 0.5, pitch: 48, velocity: 90 }],
      },
      {
        id: 'verb',
        devices: [
          {
            id: 'verb-fx',
            name: 'reverb',
            params: { size: 0.7, decay_seconds: 2.5, wet: 1, dry: 0 },
          },
        ],
      },
    ],
    master: {
      devices: [
        {
          id: 'master-eq',
          name: 'eq',
          params: { bands: [{ type: 'highpass', hz: 30, slope_db_per_octave: 24 }] },
        },
        { id: 'master-limiter', name: 'limiter', params: { ceiling_dbtp: -1 } },
      ],
    },
  };
}

async function render(
  name: string,
  project: MusicProjectInput,
  extra: Parameters<typeof renderMusic>[2] = {},
) {
  const file = join(dir, `${name}.${extra.format ?? 'wav'}`);
  const r = await renderMusic(project, file, extra);
  return { ...r, wav: extra.format === 'mp3' ? null : await readWav(file) };
}

async function makeTone(name: string, filter: string, seconds: number): Promise<string> {
  const file = join(dir, `${name}.wav`);
  await exec(BIN.ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    filter,
    '-t',
    String(seconds),
    '-ar',
    '48000',
    '-c:a',
    'pcm_s24le',
    file,
  ]);
  return file;
}

// --- tests ----------------------------------------------------------------------------------

describe.skipIf(!ready)('music engine', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cf-music-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders a song to non-silent audio of the length asked for, with its facts', async () => {
    const r = await render('song', song(6));
    expect(r.frames).toBe(6 * SR);
    expect(r.length_seconds).toBe(6);
    expect(r.wav?.left.length).toBe(6 * SR);
    expect(r.ends_seconds).toBeUndefined();
    expect(r.sample_peak_dbfs).toBeGreaterThan(-20);
    expect(r.loudness.integrated_lufs).toBeGreaterThan(-40);
    expect(r.loudness.true_peak_dbtp).toBeLessThanOrEqual(-1);
    expect(r.clipped_samples).toBe(0);
    // Every second has sound in it.
    for (let s = 0; s < 6; s++)
      expect(rmsDb(span(r.wav?.left as Float64Array, s, s + 1))).toBeGreaterThan(-40);
  }, 120_000);

  it('plays a sine note at A4 at 440 Hz, and pitch 69.5 a quarter-tone above', async () => {
    for (const [pitch, hz] of [
      [69, 440],
      [69.5, 440 * 2 ** (0.5 / 12)],
      [60, 261.6255653],
    ] as const) {
      const r = await render(`sine-${pitch}`, {
        sample_rate: 48000,
        until: 1.5,
        tracks: [tone('a', pitch, 0, 1.5)],
      });
      const f = frequency(span(r.wav?.left as Float64Array, 0.2, 1.3));
      expect(f).toBeCloseTo(hz, 2);
      expect(r.sample_peak_dbfs).toBeCloseTo(-6.0206, 3); // level 0.5, velocity 127, gains 0
    }
    // The same at 44.1 kHz.
    const r = await render('sine-44k', {
      sample_rate: 44100,
      until: 1,
      tracks: [tone('a', 69, 0, 1)],
    });
    expect(r.frames).toBe(44100);
    expect(frequency(span(r.wav?.left as Float64Array, 0.1, 0.9, 44100), 44100)).toBeCloseTo(
      440,
      2,
    );
  }, 120_000);

  it('renders each track alone, and the parts add up to the whole', async () => {
    const project: MusicProjectInput = {
      sample_rate: 48000,
      until: 1,
      tracks: [
        tone('low', 57, 0, 1),
        tone('high', 81, 0, 1),
        tone('mid', 69, 0, 1, { gain_db: -6 }),
      ],
    };
    const full = await render('alone-full', project);
    const sum = new Float64Array(SR);
    for (const [id, hz] of [
      ['low', 220],
      ['high', 880],
      ['mid', 440],
    ] as const) {
      const r = await render(`alone-${id}`, { ...project, alone: [id] });
      const x = r.wav?.left as Float64Array;
      expect(frequency(span(x, 0.1, 0.9))).toBeCloseTo(hz, 1);
      for (let i = 0; i < SR; i++) sum[i] = (sum[i] as number) + (x[i] as number);
    }
    let worst = 0;
    for (let i = 0; i < SR; i++)
      worst = Math.max(worst, Math.abs((sum[i] as number) - (full.wav?.left[i] as number)));
    expect(worst).toBeLessThan(1e-6);
  }, 120_000);

  it('renders a range as the same samples the whole render has there', async () => {
    const full = await render('range-full', song(4));
    const part = await render('range-part', { ...song(4), from: 1.25, until: 2.5 });
    expect(part.frames).toBe(1.25 * SR);
    expect(part.from_seconds).toBe(1.25);
    const a = span(full.wav?.left as Float64Array, 1.25, 2.5);
    const b = part.wav?.left as Float64Array;
    expect(Buffer.from(b.buffer).equals(Buffer.from(Float64Array.from(a).buffer))).toBe(true);
  }, 120_000);

  it('runs a tail on until the sound falls under tail_db, later with a longer reverb', async () => {
    const withVerb = (decay: number): MusicProjectInput => ({
      sample_rate: 48000,
      until: 1,
      tail_db: -60,
      tracks: [
        {
          ...tone('a', 69, 0, 1),
          devices: [
            sineSynth('a-synth'),
            { id: 'verb', name: 'reverb', params: { decay_seconds: decay, wet: 0.5, dry: 1 } },
          ],
        },
      ],
    });
    const short = await render('tail-short', withVerb(0.3));
    const long = await render('tail-long', withVerb(3));
    expect(short.ends_seconds).toBeGreaterThan(1);
    expect(long.ends_seconds).toBeGreaterThan((short.ends_seconds as number) + 1);
    expect(long.tail_capped).toBe(false);
    expect(long.length_seconds).toBeCloseTo(long.ends_seconds as number, 6);
    // Past ends_seconds nothing is over -60 dB; just before it, something is.
    const x = long.wav?.left as Float64Array;
    expect(
      peak(span(x, (long.ends_seconds as number) - 0.05, long.ends_seconds as number)),
    ).toBeGreaterThan(10 ** -3);
    // A note that would start inside the tail does not start: only what rings on is heard.
    const late = await render('tail-late', {
      ...withVerb(0.3),
      tracks: [
        {
          ...tone('a', 69, 0, 0.5),
          notes: [
            { start: 0, length: 0.5, pitch: 69, velocity: 127 },
            { start: 1.2, length: 0.5, pitch: 81, velocity: 127 },
          ],
        },
      ],
    });
    expect(late.ends_seconds).toBeLessThan(1.01);
    // Without tail_db the render stops exactly at until.
    const { tail_db: _, ...noTail } = withVerb(3);
    const cut = await render('tail-none', noTail);
    expect(cut.frames).toBe(SR);
    expect(cut.ends_seconds).toBeUndefined();
  }, 120_000);

  it('moves a track level along its automation: linear, smooth and hold', async () => {
    const r = await render('automation', {
      sample_rate: 48000,
      until: 3,
      tracks: [tone('a', 69, 0, 3)],
      automation: [
        {
          target: { track: 'a', param: 'gain_db' },
          points: [
            { time: 0, value: -40, curve: 'linear' },
            { time: 1, value: 0, curve: 'hold' },
            { time: 2, value: -20, curve: 'smooth' },
            { time: 3, value: 0, curve: 'linear' },
          ],
        },
      ],
    });
    const x = r.wav?.left as Float64Array;
    // A full-level 0.5 sine is -9.03 dB RMS; the gain is added to that.
    // Ten periods of 440 Hz either side, so the window holds whole cycles.
    const level = (t: number) => rmsDb(span(x, t - 10 / 440, t + 10 / 440)) + 9.0309;
    expect(level(0.25)).toBeCloseTo(-30, 0);
    expect(level(0.75)).toBeCloseTo(-10, 0);
    expect(level(1.5)).toBeCloseTo(0, 1); // held at 0 until the step at 2 s
    expect(level(1.97)).toBeCloseTo(0, 1);
    expect(level(2.03)).toBeCloseTo(-20 + 20 * 0.5 * (1 - Math.cos(Math.PI * 0.03)), 0);
    expect(level(2.5)).toBeCloseTo(-10, 0); // halfway through the smooth rise
  }, 120_000);

  it('sends a share of a track to another, before or after its own gain', async () => {
    const project = (before: boolean): MusicProjectInput => ({
      sample_rate: 48000,
      until: 1,
      tracks: [
        // Its own output is silenced by its gain; only the send can carry it.
        tone('a', 69, 0, 1, {
          gain_db: -120,
          sends: [{ id: 'a-to-b', to: 'b', level_db: -6, before_gain: before }],
        }),
        { id: 'b', devices: [{ id: 'b-gain', name: 'gain', params: { gain_db: 0 } }] },
      ],
    });
    const pre = await render('send-pre', project(true));
    expect(peak(span(pre.wav?.left as Float64Array, 0.1, 0.9))).toBeCloseTo(
      0.5 * 10 ** (-6 / 20),
      3,
    );
    const post = await render('send-post', project(false));
    expect(peak(post.wav?.left as Float64Array)).toBeLessThan(1e-5);
    // The send's level follows its automation.
    const moving = await render('send-auto', {
      ...project(true),
      automation: [
        {
          target: { send: 'a-to-b', param: 'level_db' },
          points: [
            { time: 0, value: -40, curve: 'linear' },
            { time: 1, value: 0, curve: 'linear' },
          ],
        },
      ],
    });
    const m = moving.wav?.left as Float64Array;
    expect(rmsDb(span(m, 0.7, 0.8)) - rmsDb(span(m, 0.2, 0.3))).toBeCloseTo(20, 0);
  }, 120_000);

  it('groups tracks under one track: its effects and level act on all of them', async () => {
    const r = await render('group', {
      sample_rate: 48000,
      until: 1,
      tracks: [
        tone('a', 57, 0, 1, { output: 'g' }),
        tone('b', 81, 0, 1, { output: 'g' }),
        {
          id: 'g',
          gain_db: -6,
          devices: [
            {
              id: 'g-lp',
              name: 'filter',
              params: { type: 'lowpass', cutoff_hz: 440, slope_db_per_octave: 48 },
            },
          ],
        },
      ],
    });
    const x = span(r.wav?.left as Float64Array, 0.2, 0.9);
    // 220 Hz passes the group's low-pass, at the group's -6 dB; 880 Hz, an octave past 440, is cut 48 dB more.
    expect(toneDb(x, 220)).toBeCloseTo(-6.02 - 6, 0);
    expect(toneDb(x, 880)).toBeLessThan(-6.02 - 6 - 40);
  }, 120_000);

  it('plays a sampler at its root note, shifted by pitch, as slices, and as one-shots', async () => {
    const a440 = await makeTone('a440', 'sine=frequency=440:sample_rate=48000', 2);
    const sampler = (
      params: Record<string, unknown>,
      notes: Array<[number, number, number]>,
    ): MusicProjectInput => ({
      sample_rate: 48000,
      until: 3,
      tracks: [
        {
          id: 's',
          devices: [
            { id: 'smp', name: 'sampler', params: { file: a440, root_note: 69, ...params } },
          ],
          notes: notes.map(([start, length, pitch]) => ({ start, length, pitch, velocity: 127 })),
        },
      ],
    });
    const shifted = await render(
      'sampler-pitch',
      sampler({}, [
        [0, 0.9, 69],
        [1, 0.9, 81],
        [2, 0.9, 69.5],
      ]),
    );
    const x = shifted.wav?.left as Float64Array;
    expect(frequency(span(x, 0.1, 0.8))).toBeCloseTo(440, 1);
    expect(frequency(span(x, 1.1, 1.8))).toBeCloseTo(880, 1);
    expect(frequency(span(x, 2.1, 2.8))).toBeCloseTo(440 * 2 ** (0.5 / 12), 1);
    // At its root note it plays the file's own samples (ffmpeg wrote a 0.125-amplitude sine).
    expect(peak(span(x, 0.1, 0.8))).toBeCloseTo(0.125, 3);

    // Slices: a file of three tones, one slice each; a pitch with no slice is silent.
    const steps = await makeTone(
      'steps',
      'aevalsrc=if(lt(t\\,0.5)\\,0.3*sin(2*PI*200*t)\\,if(lt(t\\,1)\\,0.3*sin(2*PI*400*t)\\,0.3*sin(2*PI*800*t))):s=48000',
      1.5,
    );
    const sliced = await render('sampler-slices', {
      sample_rate: 48000,
      until: 2,
      tracks: [
        {
          id: 's',
          devices: [
            {
              id: 'smp',
              name: 'sampler',
              params: {
                file: steps,
                slices: [
                  { note: 36, from_seconds: 0, until_seconds: 0.5 },
                  { note: 38, from_seconds: 0.5, until_seconds: 1 },
                  { note: 42, from_seconds: 1, until_seconds: 1.5 },
                ],
              },
            },
          ],
          notes: [
            { start: 0, length: 0.4, pitch: 42, velocity: 127 },
            { start: 0.5, length: 0.4, pitch: 36, velocity: 127 },
            { start: 1, length: 0.4, pitch: 38, velocity: 127 },
            { start: 1.5, length: 0.4, pitch: 40, velocity: 127 },
          ],
        },
      ],
    });
    const s = sliced.wav?.left as Float64Array;
    expect(frequency(span(s, 0.05, 0.35))).toBeCloseTo(800, 0);
    expect(frequency(span(s, 0.55, 0.85))).toBeCloseTo(200, 0);
    expect(frequency(span(s, 1.05, 1.35))).toBeCloseTo(400, 0);
    expect(peak(span(s, 1.5, 2))).toBe(0);

    // one_shot plays the whole range whatever the note length; otherwise the note's length.
    const held = await render('sampler-held', sampler({ until_seconds: 1 }, [[0, 0.2, 69]]));
    expect(peak(span(held.wav?.left as Float64Array, 0.25, 0.9))).toBe(0);
    const shot = await render(
      'sampler-shot',
      sampler({ until_seconds: 1, one_shot: true }, [[0, 0.2, 69]]),
    );
    expect(peak(span(shot.wav?.left as Float64Array, 0.25, 0.95))).toBeCloseTo(0.125, 3);
    expect(peak(span(shot.wav?.left as Float64Array, 1.01, 2))).toBe(0);
  }, 120_000);

  it('sounds every instrument on a track for every note', async () => {
    const r = await render('layered', {
      sample_rate: 48000,
      until: 1,
      tracks: [
        {
          id: 'two',
          devices: [sineSynth('low', 0.3), sineSynth('high', 0.2, 1)],
          notes: [{ start: 0, length: 1, pitch: 69, velocity: 127 }],
        },
      ],
    });
    const x = span(r.wav?.left as Float64Array, 0.1, 0.9);
    expect(toneDb(x, 440)).toBeCloseTo(20 * Math.log10(0.3), 0);
    expect(toneDb(x, 880)).toBeCloseTo(20 * Math.log10(0.2), 0);
  }, 120_000);

  it('filters at real 12, 24 and 48 dB per octave slopes', async () => {
    const slopes: Record<string, number> = {};
    for (const type of ['lowpass', 'highpass'] as const) {
      for (const slope of [12, 24, 48]) {
        const r = await render(`slope-${type}-${slope}`, {
          sample_rate: 48000,
          until: 6,
          tracks: [
            {
              id: 'noise',
              devices: [
                {
                  id: 'n',
                  name: 'synth',
                  params: { oscillators: [{ wave: 'noise', level: 0.5 }], amp_envelope: {} },
                },
                {
                  id: 'f',
                  name: 'filter',
                  params: {
                    type,
                    cutoff_hz: type === 'lowpass' ? 1000 : 4000,
                    slope_db_per_octave: slope,
                  },
                },
              ],
              notes: [{ start: 0, length: 6, pitch: 60, velocity: 127 }],
            },
          ],
        });
        const p = spectrum(r.wav?.left as Float64Array);
        // One and two octaves into the stopband (2 and 4 kHz past a 1 kHz low-pass; 2 and 1 kHz
        // under a 4 kHz high-pass), where a Butterworth of that order falls 11.8, 24.1 or 48.2 dB.
        const measured =
          type === 'lowpass'
            ? bandDb(p, 2000) - bandDb(p, 4000)
            : bandDb(p, 2000) - bandDb(p, 1000);
        slopes[`${type} ${slope}`] = Math.round(measured * 100) / 100;
        expect(measured).toBeGreaterThan(slope - 1.5);
        expect(measured).toBeLessThan(slope + 1.5);
      }
    }
    console.log(`filter slopes, dB per octave: ${JSON.stringify(slopes)}`);
  }, 300_000);

  it('holds a true-peak ceiling: nothing between samples passes it either', async () => {
    const hot: MusicProjectInput = {
      sample_rate: 48000,
      until: 3,
      tracks: [
        {
          id: 'loud',
          gain_db: 12,
          devices: [
            {
              id: 'loud-synth',
              name: 'synth',
              params: {
                oscillators: [
                  { wave: 'saw', level: 0.8 },
                  { wave: 'square', octave: 1, detune_cents: 3, level: 0.5 },
                ],
                amp_envelope: {},
              },
            },
            { id: 'loud-piano', name: 'grand_piano', params: { gain_db: 12 } },
          ],
          notes: [60, 64, 67, 71, 74].map((p, i) => ({
            start: i * 0.4,
            length: 1.5,
            pitch: p,
            velocity: 127,
          })),
        },
      ],
      master: {
        devices: [{ id: 'lim', name: 'limiter', params: { ceiling_dbtp: -1, release_ms: 50 } }],
      },
    };
    const r = await render('limiter', hot);
    const ceiling = 10 ** (-1 / 20);
    const x = r.wav as { left: Float64Array; right: Float64Array };
    const tp = Math.max(truePeak(x.left), truePeak(x.right));
    console.log(
      `limiter: true peak ${(20 * Math.log10(tp)).toFixed(3)} dBTP under a -1 dBTP ceiling`,
    );
    expect(tp).toBeLessThanOrEqual(ceiling);
    expect(r.loudness.true_peak_dbtp).toBeLessThanOrEqual(-1);
    // It was limiting: without the limiter the same project goes far over.
    const free = await render('limiter-off', { ...hot, master: { devices: [] } });
    expect(free.sample_peak_dbfs).toBeGreaterThan(6);
    expect(free.clipped_samples).toBeGreaterThan(0);
  }, 120_000);

  it('stretches a clip to a new length with its pitch kept', async () => {
    const a440 = await makeTone('a440-clip', 'sine=frequency=440:sample_rate=48000', 2);
    const r = await render('stretch', {
      sample_rate: 48000,
      until: 4,
      tracks: [{ id: 'c', clips: [{ file: a440, at: 0.5, from: 0, until: 2, stretch_to: 3 }] }],
    });
    const x = r.wav?.left as Float64Array;
    expect(frequency(span(x, 1, 3))).toBeCloseTo(440, 0);
    expect(rmsDb(span(x, 0, 0.45))).toBeLessThan(-100);
    expect(rmsDb(span(x, 3.3, 3.4))).toBeGreaterThan(-30);
    expect(rmsDb(span(x, 3.55, 4))).toBeLessThan(-60);
    // Unstretched, the clip plays its own samples at its place, for its own length.
    const plain = await render('clip', {
      sample_rate: 48000,
      until: 3,
      tracks: [{ id: 'c', clips: [{ file: a440, at: 0.5, from: 0.5, until: 1.5, gain_db: -6 }] }],
    });
    const y = plain.wav?.left as Float64Array;
    expect(peak(span(y, 0.6, 1.4))).toBeCloseTo(0.125 * 10 ** (-6 / 20), 3);
    expect(peak(span(y, 1.5, 3))).toBe(0);
  }, 120_000);

  it('lines up sound through latency (a limiter on one track, none on the other)', async () => {
    for (const rate of [48000, 44100] as const) {
      const click = { start: 1, length: 0.01, pitch: 36, velocity: 127 };
      const r = await render(`latency-${rate}`, {
        sample_rate: rate,
        until: 2,
        tracks: [
          {
            id: 'a',
            devices: [
              { id: 'ka', name: 'kit_909' },
              { id: 'la', name: 'limiter', params: { ceiling_dbtp: -0.1 } },
            ],
            notes: [click],
          },
          { id: 'b', pan: 1, devices: [{ id: 'kb', name: 'kit_909' }], notes: [click] },
        ],
      });
      const x = r.wav as { left: Float64Array; right: Float64Array };
      const first = (y: Float64Array) => y.findIndex((v) => Math.abs(v) > 1e-4);
      // The limited track is alone on the left (b is panned right): its click lands with b's.
      expect(first(x.left)).toBe(first(x.right));
      expect(first(x.right) - rate).toBeGreaterThanOrEqual(0);
      expect(first(x.right) - rate).toBeLessThan(48);
    }
  }, 120_000);

  it('renders the same samples and bytes every time', async () => {
    const files = [];
    for (let i = 0; i < 3; i++) files.push((await render(`same-${i}`, song(4))).file);
    const hashes = await Promise.all(files.map(sha));
    expect(new Set(hashes).size).toBe(1);
  }, 120_000);

  it('renders MP3 from the WAV', async () => {
    const r = await render(
      'mp3',
      { sample_rate: 48000, until: 1, tracks: [tone('a', 69, 0, 1)] },
      { format: 'mp3' },
    );
    const { stdout } = await exec(BIN.ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,sample_rate',
      '-of',
      'json',
      r.file,
    ]);
    expect(JSON.parse(stdout).streams[0]).toMatchObject({
      codec_name: 'mp3',
      sample_rate: '48000',
    });
    expect(r.loudness.true_peak_dbtp).toBeCloseTo(-6, 0);
  }, 120_000);

  it('refuses a wrong project with a typed error naming what was wrong, before rendering', async () => {
    const base = (): MusicProjectInput => ({
      sample_rate: 48000,
      until: 1,
      tracks: [tone('a', 69, 0, 1)],
    });
    const cases: Array<[string, MusicProjectInput, string, RegExp]> = [
      ['rate', { ...base(), sample_rate: 22050 as 44100 }, 'bad_request', /sample_rate/],
      [
        'device',
        { ...base(), tracks: [{ id: 'a', devices: [{ id: 'x', name: 'theremin' }] }] },
        'bad_request',
        /unknown device theremin/,
      ],
      [
        'param',
        {
          ...base(),
          tracks: [
            { id: 'a', devices: [{ id: 'x', name: 'reverb', params: { size: 0.5, colour: 1 } }] },
          ],
        },
        'bad_request',
        /tracks\[0\]\.devices\[0\]\.params/,
      ],
      [
        'range',
        {
          ...base(),
          tracks: [
            {
              id: 'a',
              devices: [{ id: 'x', name: 'filter', params: { type: 'lowpass', cutoff_hz: 90000 } }],
            },
          ],
        },
        'bad_request',
        /cutoff_hz/,
      ],
      [
        'velocity',
        {
          ...base(),
          tracks: [
            { ...tone('a', 69, 0, 1), notes: [{ start: 0, length: 1, pitch: 60, velocity: 0 }] },
          ],
        },
        'bad_request',
        /velocity/,
      ],
      [
        'missing file',
        { ...base(), tracks: [{ id: 'a', clips: [{ file: join(dir, 'nothing.wav'), at: 0 }] }] },
        'not_found',
        /nothing\.wav/,
      ],
      [
        'loop',
        {
          ...base(),
          tracks: [
            { id: 'a', output: 'b' },
            { id: 'b', output: 'a' },
          ],
        },
        'bad_request',
        /loops back/,
      ],
      [
        'output',
        { ...base(), tracks: [{ id: 'a', output: 'nowhere' }] },
        'bad_request',
        /no track nowhere/,
      ],
      [
        'order',
        {
          ...base(),
          tracks: [
            {
              id: 'a',
              devices: [{ id: 'g', name: 'gain', params: { gain_db: 0 } }, sineSynth('s')],
              notes: [{ start: 0, length: 1, pitch: 60, velocity: 1 }],
            },
          ],
        },
        'bad_request',
        /instruments come first/,
      ],
      [
        'no instrument',
        {
          ...base(),
          tracks: [{ id: 'a', notes: [{ start: 0, length: 1, pitch: 60, velocity: 100 }] }],
        },
        'bad_request',
        /no instrument/,
      ],
      [
        'automation param',
        {
          ...base(),
          automation: [
            {
              target: { device: 'a-synth', param: 'filter.colour' },
              points: [{ time: 0, value: 1, curve: 'linear' }],
            },
          ],
        },
        'bad_request',
        /no automatable param filter\.colour/,
      ],
      [
        'automation value',
        {
          ...base(),
          automation: [
            {
              target: { track: 'a', param: 'pan' },
              points: [{ time: 0, value: 3, curve: 'linear' }],
            },
          ],
        },
        'bad_request',
        /out of range/,
      ],
      [
        'too long',
        { ...base(), until: MUSIC_LIMITS.renderSeconds + 1 },
        'limit_exceeded',
        /over the limit/,
      ],
    ];
    for (const [name, project, code, message] of cases) {
      const out = join(dir, `bad-${name.replace(/ /g, '-')}.wav`);
      const error = await renderMusic(project, out).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, name).toBeInstanceOf(CfError);
      expect((error as CfError).code, name).toBe(code);
      expect((error as CfError).message, name).toMatch(message);
      await expect(access(out), name).rejects.toThrow();
    }
  }, 120_000);

  it('never answers a bad project with exit 0 and silence, even unchecked by TypeScript', async () => {
    const good = {
      version: 1,
      sample_rate: 48000,
      from: 0,
      until: 1,
      tracks: [
        {
          id: 'a',
          gain_db: 0,
          pan: 0,
          output: 'master',
          sends: [],
          clips: [],
          devices: [
            {
              id: 's',
              name: 'synth',
              params: {
                oscillators: [{ wave: 'sine', octave: 0, detune_cents: 0, level: 0.5 }],
                amp_envelope: { attack_ms: 0, decay_ms: 0, sustain: 1, release_ms: 0 },
                glide_ms: 0,
                gain_db: 0,
              },
            },
          ],
          notes: [{ start: 0, length: 1, pitch: 69, velocity: 127 }],
        },
      ],
    };
    // Each takes the good project apart as plain JSON.
    type Json = Record<string, unknown>;
    const track = (p: Json) => (p.tracks as Json[])[0] as Json;
    const synth = (p: Json) => (track(p).devices as Json[])[0] as Json;
    const params = (p: Json) => synth(p).params as Json;
    const bad: Record<string, (p: Json) => void> = {
      'missing file': (p) => {
        track(p).clips = [{ file: join(dir, 'gone.wav'), at: 0, from: 0, gain_db: 0 }];
      },
      'unknown device': (p) => {
        synth(p).name = 'synthesiser';
      },
      'unknown param': (p) => {
        params(p).warmth = 1;
      },
      'missing param': (p) => {
        delete params(p).glide_ms;
      },
      'out of range': (p) => {
        ((params(p).oscillators as Json[])[0] as Json).level = 2;
      },
      'wrong type': (p) => {
        ((track(p).notes as Json[])[0] as Json).pitch = 'A4';
      },
      'unknown field': (p) => {
        p.tempo = 120;
      },
    };
    const ok = join(dir, 'raw-ok.wav');
    await writeFile(join(dir, 'raw-ok.json'), JSON.stringify(good));
    await exec(BIN.music, ['render', join(dir, 'raw-ok.json'), ok, '--content', MUSIC_CONTENT]);
    expect(peak((await readWav(ok)).left)).toBeGreaterThan(0.4);
    for (const [name, change] of Object.entries(bad)) {
      const p = structuredClone(good) as unknown as Json;
      change(p);
      const json = join(dir, `raw-${name.replace(/ /g, '-')}.json`);
      const out = join(dir, `raw-${name.replace(/ /g, '-')}.wav`);
      await writeFile(json, JSON.stringify(p));
      const result = await exec(BIN.music, ['render', json, out, '--content', MUSIC_CONTENT]).then(
        () => ({ code: 0, stdout: '' }),
        (e: { code: number; stdout: string }) => e,
      );
      expect(result.code, name).toBe(2);
      const error = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}').error;
      expect(error.code, name).toMatch(/bad_request|not_found/);
      expect(error.message.length, name).toBeGreaterThan(10);
      await expect(access(out), name).rejects.toThrow();
    }
  }, 120_000);

  it('has the same devices, params and ranges in the TypeScript catalog as in the engine', async () => {
    const { stdout } = await exec(BIN.music, ['catalog', '--content', MUSIC_CONTENT], {
      maxBuffer: 1 << 24,
    });
    const engine = JSON.parse(stdout) as Record<
      string,
      { instrument: boolean; params: Record<string, EngineSpec> }
    >;
    interface EngineSpec {
      kind: string;
      min?: number;
      max?: number;
      automatable?: boolean;
      choices?: string[];
      fields?: Record<string, EngineSpec>;
      optional: boolean;
      min_items?: number;
      max_items?: number;
    }
    const devices = musicDevices();
    expect([...devices.keys()].sort()).toEqual(Object.keys(engine).sort());
    const compare = (
      path: string,
      ts: Record<string, import('../src/index.ts').ParamDef>,
      cpp: Record<string, EngineSpec>,
    ) => {
      expect(Object.keys(ts).sort(), path).toEqual(Object.keys(cpp).sort());
      for (const [key, def] of Object.entries(ts)) {
        const e = cpp[key] as EngineSpec;
        const at = `${path}.${key}`;
        const kind = { file: 'string' }[def.kind as string] ?? def.kind;
        expect(e.kind, at).toBe(kind);
        if (def.kind === 'number' || def.kind === 'integer') {
          expect([e.min, e.max], at).toEqual([def.min, def.max]);
          expect(e.optional, at).toBe(def.kind === 'number' && def.optional === true);
        }
        if (def.kind === 'number') expect(e.automatable, at).toBe(def.automatable);
        if (def.kind === 'choice') expect(e.choices, at).toEqual(def.choices.map(String));
        if (def.kind === 'object' || def.kind === 'list') {
          expect(e.optional, at).toBe(def.optional);
          compare(at, def.fields, e.fields as Record<string, EngineSpec>);
        }
        if (def.kind === 'list')
          expect([e.min_items, e.max_items], at).toEqual([def.min_items, def.max_items]);
      }
    };
    for (const [name, def] of devices) {
      expect(def.kind === 'instrument', name).toBe(engine[name]?.instrument);
      compare(name, def.params, engine[name]?.params as Record<string, EngineSpec>);
    }
    // Kits list what each pitch plays.
    expect(devices.get('kit_808')?.pitches).toContainEqual({ pitch: 36, name: 'kick' });
    expect(devices.get('kit_909')?.pitches?.map((p) => p.pitch)).toContain(42);
  }, 60_000);

  it('plays every named instrument and kit', async () => {
    const devices = [...musicDevices().values()].filter(
      (d) => d.kind === 'instrument' && d.name !== 'sampler' && d.name !== 'synth',
    );
    const r = await render('every-instrument', {
      sample_rate: 48000,
      until: devices.length,
      tracks: devices.map((d, i) => ({
        id: d.name,
        devices: [{ id: `${d.name}-dev`, name: d.name }],
        notes: (d.pitches ? d.pitches.map((p) => p.pitch) : [48, 60, 72]).map((pitch, k, all) => ({
          start: i + (k * 0.9) / all.length,
          length: 0.9 / all.length,
          pitch,
          velocity: 100,
        })),
      })),
    });
    const x = r.wav?.left as Float64Array;
    for (const [i, d] of devices.entries())
      expect(rmsDb(span(x, i, i + 0.9)), d.name).toBeGreaterThan(-45);
  }, 120_000);

  it('renders 10 s and 60 s of a song fast enough (numbers in the log)', async () => {
    const times: Record<string, number> = {};
    for (const seconds of [10, 60]) {
      const started = performance.now();
      const r = await render(`speed-${seconds}`, song(seconds));
      times[`${seconds}s_wall_ms`] = Math.round(performance.now() - started);
      times[`${seconds}s_engine_ms`] = Math.round(r.render_ms);
      expect(r.length_seconds).toBe(seconds);
    }
    console.log(
      `music render speed (${cpus()[0]?.model ?? 'cpu'}, ${availableParallelism()} CPUs, ${process.arch}): ${JSON.stringify(times)}`,
    );
    // Far faster than real time: a minute of music in under 30 s, however slow the runner.
    expect(times['60s_wall_ms']).toBeLessThan(30_000);
  }, 300_000);
});

describe('music project checks', () => {
  it('fills in defaults from the catalog and keeps exactly what was given', () => {
    const p = checkMusicProject({
      sample_rate: 44100,
      until: 2,
      tracks: [
        {
          id: 'a',
          devices: [{ id: 'f', name: 'filter', params: { type: 'highpass', cutoff_hz: 120 } }],
        },
      ],
    });
    expect(p.from).toBe(0);
    expect(p.tracks[0]).toMatchObject({
      gain_db: 0,
      pan: 0,
      output: 'master',
      sends: [],
      notes: [],
      clips: [],
    });
    expect(p.tracks[0]?.devices[0]?.params).toEqual({
      type: 'highpass',
      cutoff_hz: 120,
      resonance: Math.SQRT1_2,
      slope_db_per_octave: 12,
    });
    expect(p.tracks[0]?.devices[0]?.enabled).toBe(true);
  });

  it('refuses a wrong param with the device’s params, ranges and defaults in the hint', () => {
    try {
      checkMusicProject({
        sample_rate: 48000,
        until: 1,
        tracks: [{ id: 'a', devices: [{ id: 'd', name: 'delay', params: { time_ms: 0 } }] }],
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CfError);
      expect((e as CfError).message).toMatch(/tracks\[0\]\.devices\[0\]\.params\.time_ms/);
      expect((e as CfError).hint).toMatch(
        /time_ms \(0\.1 to 10000 ms, required\); feedback \(0 to 0\.99, default 0\)/,
      );
    }
  });
});
