import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { createServer, Runtime } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Sounds end to end, in the image: media.analyze sounds, media.listen and create.stems on real
// audio. The audience clip is "approx 800 laughter and clapter" by lonemonk (freesound.org/s/72844,
// CC BY 3.0, via Wikimedia Commons), fetched once by the Dockerfile's testmodels stage; the
// speech is espeak-ng and the music FFmpeg's own tones.

const exec = promisify(execFile);
const MODELS = process.env.CUTTINGFLOOR_SOUND_MODELS ?? '/usr/share/cuttingfloor/models';
const AUDIENCE = process.env.CUTTINGFLOOR_SOUND_FIXTURE ?? '/opt/models/fixtures/laughter.wav';

const present = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const ready =
  (await present(join(MODELS, 'sounds', 'sed-mn10.onnx'))) &&
  (await present(AUDIENCE)) &&
  (await exec('ffmpeg', ['-version']).then(
    () => true,
    () => false,
  ));
if (!ready && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error(
    'CUTTINGFLOOR_REQUIRE_ENGINES is set but the sound models or fixture are missing',
  );
}

const ff = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);

type Span = { start: number; end: number; peak_seconds: number; peak_probability: number };

describe.skipIf(!ready)('sounds', () => {
  let runtime: Runtime;
  let client: Client;
  let mediaDir: string;

  async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text?: string }>;
    };
    if (res.isError) {
      throw new Error(`${name} failed: ${res.content.map((c) => c.text ?? '').join(' ')}`);
    }
    return res.structuredContent as T;
  }

  async function job<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
    const started = await ok<{ job_id?: string } & Record<string, unknown>>(name, args);
    if (!started.job_id) return started as T;
    const until = Date.now() + 900_000;
    for (;;) {
      const view = await ok<{ status: string; result?: T; error?: unknown }>('job.get', {
        job_id: started.job_id,
      });
      if (view.status !== 'working') {
        if (!view.result) throw new Error(`${name}: ${JSON.stringify(view.error)}`);
        return view.result;
      }
      if (Date.now() > until) throw new Error(`${name} still working`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async function importFile(file: string): Promise<string> {
    const r = await job<{ media_id: string }>('media.import', { source: { path: file } });
    return r.media_id;
  }

  /** RMS of a WAV between two times, in dBFS. */
  async function level(file: string, from: number, to: number): Promise<number> {
    const { stderr } = await exec('ffmpeg', [
      '-hide_banner',
      '-ss',
      String(from),
      '-to',
      String(to),
      '-i',
      file,
      '-af',
      'astats=measure_overall=RMS_level:measure_perchannel=0',
      '-f',
      'null',
      '-',
    ]);
    const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(stderr);
    return m?.[1] === '-inf' || !m ? -120 : Number(m[1]);
  }

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-sounds-'));
    mediaDir = join(dir, 'media');
    await mkdir(mediaDir, { recursive: true });
    runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'local',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [mediaDir],
      exportsDir: join(dir, 'exports'),
      maxJobs: 2,
      outputUrlTtlMs: 3_600_000,
      maxDownloadBytes: 1024 ** 3,
      allowPrivateUrls: true,
      inlineMaxBytes: 32 * 1024 ** 2,
      motionUrl: null,
    });
    await runtime.start({ sweep: false });
    const server = createServer({
      runtime,
      credentials: new LocalCredentialStore({}, false),
      owner: () => 'local',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: 'sounds-test', version: '0.0.0' });
    await client.connect(b);

    // 0–~3 s speech, 4–~14 s the audience laughing then clapping, 1 s of quiet after.
    await exec('espeak-ng', [
      '-s',
      '150',
      '-w',
      join(mediaDir, 'speech.wav'),
      'Thanks for coming tonight. Here is the story.',
    ]);
    await ff([
      '-i',
      join(mediaDir, 'speech.wav'),
      '-i',
      AUDIENCE,
      '-filter_complex',
      '[0:a]aresample=44100,aformat=channel_layouts=stereo,apad=whole_dur=4[s];[1:a]aresample=44100,aformat=channel_layouts=stereo,apad=pad_dur=1[l];[s][l]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      join(mediaDir, 'show.wav'),
    ]);
    // Speech over a steady chord, for the stems.
    await ff([
      '-i',
      join(mediaDir, 'speech.wav'),
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=8,volume=0.15',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=8,volume=0.1',
      '-filter_complex',
      '[0:a]aresample=44100,adelay=3000|3000,apad=whole_dur=8[v];[1:a][2:a]amix=inputs=2:normalize=0[m];[v][m]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[out]',
      '-map',
      '[out]',
      '-t',
      '8',
      join(mediaDir, 'mix.wav'),
    ]);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await runtime?.stop();
  });

  it('names the sounds it hears, per 40 ms, at the cut-off given', async () => {
    const id = await importFile(join(mediaDir, 'show.wav'));
    const t = Date.now();
    const res = await job<{
      sounds: {
        spans: Record<string, Span[]>;
        peaks: Record<string, number>;
        scores: { step_seconds: number; values: Record<string, number[]> };
      };
    }>('media.analyze', {
      media_id: id,
      kind: 'sounds',
      labels: ['Laughter', 'applause', 'Speech', 'Dog'],
      min_probability: 0.3,
    });
    console.log(`media.analyze sounds: ${(Date.now() - t) / 1000}s for 15 s of sound`);
    const { spans, peaks, scores } = res.sounds;
    expect(Object.keys(spans).sort()).toEqual(['Applause', 'Dog', 'Laughter', 'Speech']);
    expect(spans.Dog).toEqual([]);
    expect(peaks.Laughter).toBeGreaterThan(0.5);
    const laugh = spans.Laughter?.[0] as Span;
    expect(laugh.start).toBeGreaterThanOrEqual(3.5);
    expect(laugh.start).toBeLessThan(6);
    expect(spans.Speech?.some((s) => s.start < 3)).toBe(true);
    expect(spans.Applause?.some((s) => s.peak_seconds > 7 && s.peak_seconds < 14.5)).toBe(true);
    expect(scores.step_seconds).toBe(0.04);
    expect(scores.values.Laughter?.length).toBeGreaterThan(360);

    // Without labels: every sound that reaches the cut-off, kept with the media.
    const all = await job<{ sounds: { spans: Record<string, Span[]> } }>('media.analyze', {
      media_id: id,
      kind: 'sounds',
      min_probability: 0.5,
    });
    expect(Object.keys(all.sounds.spans)).toContain('Laughter');
    const info = await ok<{
      analyses: { sounds: { heard: string[] } };
      sounds: { scores: { values: Record<string, number[]> } };
    }>('media.get', { media_id: id, include: ['sounds'] });
    expect(info.analyses.sounds.heard).toContain('Laughter');
    expect(Object.keys(info.sounds.scores.values)).toContain('Laughter');
  }, 300_000);

  it('finds sounds described in plain words', async () => {
    const id = await importFile(join(mediaDir, 'show.wav'));
    const t = Date.now();
    const res = await job<{
      asked: Record<string, string>;
      matches: Record<string, Span[]>;
      peaks: Record<string, number>;
      scores: { start_seconds: number; values: Record<string, number[]> };
    }>('media.listen', {
      media_id: id,
      sounds: { laugh: 'people laughing', clap: 'a crowd clapping', bark: 'a dog barking' },
    });
    console.log(`media.listen: ${(Date.now() - t) / 1000}s for 15 s of sound, 3 sounds`);
    expect(res.asked.laugh).toBe('The sound of People laughing');
    expect(res.matches.laugh?.[0]?.start).toBeGreaterThanOrEqual(3.5);
    expect(res.matches.clap?.some((s) => s.peak_seconds > 7)).toBe(true);
    expect(res.peaks.bark).toBeLessThan(0.5);

    // A range: times stay media seconds.
    const part = await job<{ matches: Record<string, Span[]>; scores: { start_seconds: number } }>(
      'media.listen',
      { media_id: id, sounds: { laugh: 'laughter' }, from_seconds: 4, until_seconds: 9 },
    );
    expect(part.scores.start_seconds).toBe(4);
    expect(part.matches.laugh?.every((s) => s.start >= 4 && s.end <= 9.1)).toBe(true);
  }, 300_000);

  it('separates the voice from the music as new media', async () => {
    const id = await importFile(join(mediaDir, 'mix.wav'));
    const t = Date.now();
    const res = await job<{
      stems: Record<string, { media_id: string; duration_seconds: number; has_audio: boolean }>;
    }>('create.stems', { media_id: id, stems: ['vocals', 'no_vocals'] });
    console.log(`create.stems: ${(Date.now() - t) / 1000}s for 8 s of sound`);
    const { vocals, no_vocals } = res.stems as Record<
      string,
      { media_id: string; duration_seconds: number }
    >;
    expect(vocals?.media_id).toMatch(/^m_/);
    expect(Math.abs((vocals?.duration_seconds ?? 0) - 8)).toBeLessThan(0.05);
    const file = (m: string) => join(runtime.media.dir('local', m), 'source.wav');
    // Before the speech: the chord is in no_vocals, hardly any in vocals.
    const vocalsQuiet = await level(file(vocals?.media_id as string), 0.5, 2.5);
    const musicThere = await level(file(no_vocals?.media_id as string), 0.5, 2.5);
    expect(musicThere - vocalsQuiet).toBeGreaterThan(20);
    // During the speech, vocals carries it.
    expect(await level(file(vocals?.media_id as string), 3.2, 5)).toBeGreaterThan(-40);

    // The same media and stems again: the same media, at once.
    const again = await ok<{ stems?: Record<string, { media_id: string }> }>('create.stems', {
      media_id: id,
      stems: ['vocals'],
    });
    expect(again.stems?.vocals?.media_id).toBe(vocals?.media_id);
  }, 600_000);
});
