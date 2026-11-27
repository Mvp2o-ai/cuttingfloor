// render.spectrogram and render.notes through the SDK client: media end to end where the host
// has FFmpeg, scores against stand-ins for the score store and the score's sound, the 60 s
// limit, and bad arguments.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { colourLevel, LOW_PITCH, type Rgb } from '@cuttingfloor/engine';
import type { ScoreDoc } from '@cuttingfloor/schema';
import { createServer, type ServerDeps } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CallResult, call, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

const exec = promisify(execFile);

const engines = await Promise.all([
  exec('ffmpeg', ['-version']),
  exec('ffprobe', ['-version']),
]).then(
  () => true,
  () => false,
);
if (!engines && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg/ffprobe are missing');
}

const SCORE = `sc_${'a'.repeat(32)}`;

/** Tempo 120 in 4/4; a bass loop at C2 played at beats 0 and 8, and a lead A4. */
function scoreDoc(): ScoreDoc {
  const part = (id: string, name: string, regions: ScoreDoc['parts'][number]['regions']) => ({
    id,
    name,
    gain_db: 0,
    pan: 0,
    mute: false,
    solo: false,
    output: 'master',
    devices: [],
    sends: [],
    regions,
  });
  return {
    version: 1,
    name: 'stub',
    next_id: 100,
    sample_rate: 48_000,
    tempo: [{ at: 0, bpm: 120 }],
    meter: [{ bar: 1, beats: 4, unit: 4 }],
    markers: [],
    parts: [
      part('p_bass', 'Bass', [
        { id: 'r1', type: 'notes', start: 0, length: 4, source: 's1', offset: 0 },
        { id: 'r2', type: 'notes', start: 8, length: 4, source: 's1', offset: 0 },
      ]),
      part('p_lead', 'Lead', [
        { id: 'r3', type: 'notes', start: 0, length: 16, source: 's2', offset: 0 },
        { id: 'r4', type: 'audio', start: 4, media_id: 'm_x', from: 0, until: 1, gain_db: 0 },
      ]),
    ],
    master: { devices: [] },
    sources: {
      s1: {
        notes: [
          { id: 'n1', pitch: 36, at: 0, length: 2, velocity: 100 },
          { id: 'n2', pitch: 43, at: 6, length: 1, velocity: 100 },
        ],
      },
      s2: { notes: [{ id: 'n3', pitch: 69, at: 1, length: 2, velocity: 90 }] },
    },
    automation: [],
    media: { m_x: { name: 'hit.wav', duration: 1 } },
    parent: null,
  };
}

async function client(env: TestEnv, extra: Partial<ServerDeps>): Promise<Client> {
  const server = createServer({
    runtime: env.runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => 'local',
    ...extra,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientSide);
  return c;
}

function image(res: CallResult): Buffer {
  const img = res.content.find((c) => c.type === 'image');
  expect(img?.mimeType).toBe('image/png');
  return Buffer.from(String(img?.data ?? ''), 'base64');
}

/** One pixel of a PNG, read back through FFmpeg. */
async function pixel(env: TestEnv, png: Buffer, x: number, y: number): Promise<Rgb> {
  const file = join(env.dir, `px-${Math.random().toString(36).slice(2)}.png`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, png);
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'],
    { encoding: 'buffer' },
  );
  return [stdout[0] ?? -1, stdout[1] ?? -1, stdout[2] ?? -1];
}

interface Picture {
  from_seconds: number;
  until_seconds: number;
  seconds_per_pixel: number;
  plot: { left: number; top: number; width: number; height: number };
  pitch: { highest_midi: number; row_pixels: number; lowest: string; highest: string };
  bars: Array<{ bar: number; seconds: number; x: number; beats?: number }>;
  image: { url: string; width: number; height: number; bytes: number };
}

/** The pixel in the middle of a pitch's row at time t. */
function where(p: Picture, pitch: number, t: number): [number, number] {
  return [
    Math.round(p.plot.left + (t - p.from_seconds) / p.seconds_per_pixel),
    Math.round(
      p.plot.top + (p.pitch.highest_midi - pitch) * p.pitch.row_pixels + p.pitch.row_pixels / 2,
    ),
  ];
}

describe('render.spectrogram and render.notes: arguments and limits', () => {
  let env: TestEnv;
  let c: Client;
  beforeAll(async () => {
    env = await testRuntime();
    c = await client(env, {});
  });

  it('refuses more than 60 s, naming the limit', async () => {
    const res = await call(c, 'render.spectrogram', {
      media_id: `m_${'a'.repeat(26)}`,
      from_seconds: 10,
      until_seconds: 71,
    });
    expect(res.isError).toBe(true);
    expect(res.structured.code).toBe('limit_exceeded');
    expect(String(res.structured.message)).toContain('up to 60 s');
  });

  it('refuses bad arguments', async () => {
    const bad = async (tool: string, args: Record<string, unknown>) => {
      const res = await call(c, tool, args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      return res;
    };
    await bad('render.spectrogram', {});
    await bad('render.spectrogram', { media_id: `m_${'a'.repeat(26)}`, score_id: SCORE });
    await bad('render.spectrogram', {
      media_id: `m_${'a'.repeat(26)}`,
      from_seconds: 5,
      until_seconds: 4,
    });
    await bad('render.spectrogram', { media_id: `m_${'a'.repeat(26)}`, long_edge: 100 });
    const bars = await bad('render.spectrogram', {
      media_id: `m_${'a'.repeat(26)}`,
      beats_per_bar: 4,
    });
    expect(String(bars.structured.message)).toContain('tempo');
    const tempo = await bad('render.spectrogram', { score_id: SCORE, tempo: 120 });
    expect(String(tempo.structured.message)).toContain('own tempo');
    await bad('render.notes', { score_id: 'nope' });
    await bad('render.notes', { score_id: SCORE, from_beats: 4, until_beats: 2 });
    const missing = await bad('render.spectrogram', { media_id: `m_${'b'.repeat(26)}` });
    expect(missing.structured.code).toBe('not_found');
  });

  it("reads a score from the server's own store: one it never had is not found", async () => {
    const notes = await call(c, 'render.notes', { score_id: SCORE });
    expect(notes.structured.code).toBe('not_found');
    const sound = await call(c, 'render.spectrogram', { score_id: SCORE });
    expect(sound.structured.code).toBe('not_found');
  });
});

describe('render.notes against a stand-in score store', () => {
  let env: TestEnv;
  let c: Client;
  const asked: string[] = [];
  beforeAll(async () => {
    env = await testRuntime();
    c = await client(env, {
      loadScore: async (owner, id) => {
        asked.push(`${owner} ${id}`);
        return scoreDoc();
      },
    });
  });

  it('draws the notes the score plays and says what the picture covers', async () => {
    const res = await call(c, 'render.notes', { score_id: SCORE });
    expect(res.isError, JSON.stringify(res.structured)).toBe(false);
    expect(asked).toContain(`local ${SCORE}`);
    const r = res.structured as unknown as Picture & {
      parts: Array<{ part_id: string; name: string; colour: string; notes: number }>;
      notes: number;
      audio_regions: number;
      until_beats: number;
    };
    expect(r.until_beats).toBe(16);
    expect(r.from_seconds).toBe(0);
    expect(r.until_seconds).toBe(8);
    expect(r.pitch.lowest).toBe('C1');
    expect(r.pitch.highest).toBe('B9');
    // The loop at beats 0 and 8 (its note at beat 6 is outside the region), and the lead.
    expect(r.parts.map((p) => [p.part_id, p.notes])).toEqual([
      ['p_bass', 2],
      ['p_lead', 1],
    ]);
    expect(r.parts[0]?.colour).not.toBe(r.parts[1]?.colour);
    expect(r.audio_regions).toBe(1);
    expect(r.bars.map((b) => [b.bar, b.beats, b.seconds])).toEqual([
      [1, 0, 0],
      [2, 4, 2],
      [3, 8, 4],
      [4, 12, 6],
    ]);
    expect(r.image.url).toContain('/outputs/');
    const png = image(res);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(r.image.bytes).toBe(png.length);
  });

  it('draws only the parts asked for, and refuses one the score lacks', async () => {
    const res = await ok<{ parts: Array<{ part_id: string }>; notes: number }>(c, 'render.notes', {
      score_id: SCORE,
      parts: ['p_lead'],
      from_beats: 0,
      until_beats: 8,
    });
    expect(res.parts.map((p) => p.part_id)).toEqual(['p_lead']);
    expect(res.notes).toBe(1);
    const none = await call(c, 'render.notes', { score_id: SCORE, parts: ['p_drums'] });
    expect(none.structured.code).toBe('not_found');
    expect(String(none.structured.hint)).toContain('p_bass (Bass)');
  });

  it.skipIf(!engines)('puts notes on the rows and columns they play', async () => {
    const res = await call(c, 'render.notes', { score_id: SCORE });
    const r = res.structured as unknown as Picture;
    const png = image(res);
    const bg = await pixel(env, png, ...where(r, 36, 7.75));
    const sum = (p: Rgb) => p[0] + p[1] + p[2];
    // The bass at C2 in both loops (beats 0–2 and 8–10), the lead at A4 from beat 1.
    for (const [pitch, t] of [
      [36, 0.5],
      [36, 4.5],
      [69, 1],
    ] as const) {
      expect(sum(await pixel(env, png, ...where(r, pitch, t)))).toBeGreaterThan(sum(bg) + 150);
    }
    expect(sum(await pixel(env, png, ...where(r, 43, 3.25)))).toBeLessThan(sum(bg) + 20);
  });
});

describe.skipIf(!engines)('render.spectrogram of media and of a score', () => {
  let env: TestEnv;
  let c: Client;
  const rendered: Array<{ from: number; until: number }> = [];
  beforeAll(async () => {
    env = await testRuntime();
    // The score's sound: an A4 (the lead) from 0.5 s to 1.5 s, cut to the range asked for.
    const full = join(env.dir, 'score-full.wav');
    await exec('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-af',
      'adelay=500,apad=whole_dur=8',
      full,
    ]);
    c = await client(env, {
      loadScore: async () => scoreDoc(),
      renderScoreSound: async (_owner, _id, range) => {
        rendered.push({ from: range.from_seconds, until: range.until_seconds });
        const out = join(env.dir, `score-${rendered.length}.wav`);
        await exec('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-ss',
          String(range.from_seconds),
          '-t',
          String(range.until_seconds - range.from_seconds),
          '-i',
          full,
          out,
        ]);
        return { wav: out, doc: scoreDoc() };
      },
    });
    await exec('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=3',
      join(env.mediaDir, 'a4.wav'),
    ]);
    await exec('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=110:sample_rate=48000:duration=3',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      join(env.mediaDir, 'clip.mp4'),
    ]);
  });

  async function importMedia(name: string): Promise<string> {
    const started = await ok<{ job_id: string; media_id: string }>(c, 'media.import', {
      source: { path: join(env.mediaDir, name) },
    });
    const done = await settled<{ error?: unknown }>(c, started.job_id, 120_000);
    if (done.error) throw new Error(`import failed: ${JSON.stringify(done.error)}`);
    return started.media_id;
  }

  it('draws an audio file with bar lines from a tempo, the tone on its row', {
    timeout: 120_000,
  }, async () => {
    const id = await importMedia('a4.wav');
    const res = await call(c, 'render.spectrogram', {
      media_id: id,
      tempo: 120,
      beats_per_bar: 2,
      first_bar_seconds: 0.5,
    });
    expect(res.isError, JSON.stringify(res.structured)).toBe(false);
    const r = res.structured as unknown as Picture & {
      level: { black_db: number; brightest_db: number; peak_db: number };
      window_seconds: Record<string, number>;
      beat_lines: number;
      media_id: string;
    };
    expect(r.media_id).toBe(id);
    expect(r.from_seconds).toBe(0);
    expect(r.until_seconds).toBeCloseTo(3, 1);
    expect(r.level).toMatchObject({ black_db: -90, brightest_db: 0 });
    // FFmpeg's sine is amplitude 1/8: -18 dBFS.
    expect(r.level.peak_db).toBeGreaterThan(-20);
    expect(r.level.peak_db).toBeLessThan(-16);
    expect(r.window_seconds.C2).toBeGreaterThan(r.window_seconds.C6 as number);
    // A bar every second from 0.5 s: bars 1–3 at 0.5, 1.5, 2.5 s.
    expect(r.bars.map((b) => [b.bar, b.seconds])).toEqual([
      [1, 0.5],
      [2, 1.5],
      [3, 2.5],
    ]);
    for (const b of r.bars)
      expect(b.x).toBe(Math.round(r.plot.left + b.seconds / r.seconds_per_pixel));
    // Beats at 0.5 s to 2.5 s; 3 s is the end of the file.
    expect(r.beat_lines).toBe(5);
    const png = image(res);
    const level = async (pitch: number) =>
      colourLevel(await pixel(env, png, ...where(r, pitch, 1.25)));
    expect(await level(69)).toBeGreaterThan(-20);
    expect(await level(67)).toBeLessThan(-70);
    expect(await level(72)).toBeLessThan(-70);
    expect(r.image.url).toContain('/outputs/');
  });

  it('draws the sound of a video', { timeout: 120_000 }, async () => {
    const id = await importMedia('clip.mp4');
    const res = await call(c, 'render.spectrogram', {
      media_id: id,
      from_seconds: 1,
      until_seconds: 2,
      long_edge: 640,
    });
    expect(res.isError, JSON.stringify(res.structured)).toBe(false);
    const r = res.structured as unknown as Picture;
    expect(r.image.width).toBe(640);
    const png = image(res);
    // 110 Hz is A2 (45).
    expect(colourLevel(await pixel(env, png, ...where(r, 45, 1.5)))).toBeGreaterThan(-30);
    expect(colourLevel(await pixel(env, png, ...where(r, 69, 1.5)))).toBeLessThan(-70);
    expect(LOW_PITCH).toBe(24);
  });

  it('draws a score through its rendered sound, with its own bars', {
    timeout: 120_000,
  }, async () => {
    const res = await call(c, 'render.spectrogram', {
      score_id: SCORE,
      from_seconds: 0,
      until_seconds: 4,
    });
    expect(res.isError, JSON.stringify(res.structured)).toBe(false);
    const r = res.structured as unknown as Picture & { score_id: string };
    expect(r.score_id).toBe(SCORE);
    // Read with room either side for the low rows' windows.
    expect(rendered.at(-1)?.from).toBe(0);
    expect(rendered.at(-1)?.until).toBeGreaterThan(4.9);
    expect(r.bars.map((b) => [b.bar, b.beats, b.seconds])).toEqual([
      [1, 0, 0],
      [2, 4, 2],
    ]);
    const png = image(res);
    expect(colourLevel(await pixel(env, png, ...where(r, 69, 1)))).toBeGreaterThan(-25);
    expect(colourLevel(await pixel(env, png, ...where(r, 69, 3.25)))).toBeLessThan(-70);
    // Without until_seconds: the score's music ends at beat 16, 8 s.
    const whole = await ok<{ until_seconds: number }>(c, 'render.spectrogram', { score_id: SCORE });
    expect(whole.until_seconds).toBe(8);
  });
});
