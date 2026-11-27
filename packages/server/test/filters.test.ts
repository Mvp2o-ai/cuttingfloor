import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MediaListenResult, MediaSeekResult } from '@cuttingfloor/schema';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

// The result filters on media.listen and media.seek (min_seconds, include) through the SDK
// client. Both need FFmpeg; media.seek asks a stand-in for the judgment service, media.listen
// needs the sound models the image ships. Each skips without them unless
// CUTTINGFLOOR_REQUIRE_ENGINES says they must be there.

const exec = promisify(execFile);
const ffmpeg = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const MODELS = process.env.CUTTINGFLOOR_SOUND_MODELS ?? '/usr/share/cuttingfloor/models';
const listenModels = await access(join(MODELS, 'sounds', 'flexsed.onnx')).then(
  () => true,
  () => false,
);
if (process.env.CUTTINGFLOOR_REQUIRE_ENGINES && !(ffmpeg && listenModels)) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but FFmpeg or the sound models are missing');
}

const ff = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);

describe.skipIf(!ffmpeg)('media.seek filters', () => {
  let env: TestEnv;
  let jev: Server;
  let client: Client;
  let media_id: string;

  beforeAll(async () => {
    jev = createPlainServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        questions: Record<string, unknown>;
      };
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 0.9 }]),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 1 } }));
    });
    await new Promise<void>((r) => jev.listen(0, '127.0.0.1', r));
    env = await testRuntime({
      typesafeUrl: `http://127.0.0.1:${(jev.address() as AddressInfo).port}`,
    });
    client = await connect(env.runtime, 'seek', { TYPESAFE_API_KEY: 'ts-seek-key' });
    const file = join(env.mediaDir, 'grey.mp4');
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:size=320x180:rate=25',
      '-t',
      '4',
      '-pix_fmt',
      'yuv420p',
      file,
    ]);
    const started = await ok<{ job_id?: string; media_id: string }>(client, 'media.import', {
      source: { path: file },
    });
    if (started.job_id) await settled(client, started.job_id, 120_000);
    media_id = started.media_id;
  }, 120_000);

  afterAll(async () => {
    jev?.close();
    await env?.runtime.stop();
  });

  async function seek(args: Record<string, unknown>) {
    const started = await ok<{ job_id: string }>(client, 'media.seek', {
      media_id,
      criteria: { grey: 'the picture is grey' },
      ...args,
    });
    const done = await settled<{ result: Record<string, unknown> }>(client, started.job_id);
    return MediaSeekResult.strict().parse(done.result);
  }

  it('returns everything without the filters, as before', async () => {
    const all = await seek({});
    expect(all.matches?.grey).toHaveLength(1);
    expect(all.samples).toHaveLength(4);
  });

  it('leaves out what include leaves out, and runs shorter than min_seconds', async () => {
    const matches = await seek({ include: ['matches'] });
    expect(matches.samples).toBeUndefined();
    expect(matches.matches?.grey?.[0]).toMatchObject({ start: 0, end: 3 });
    const samples = await seek({ include: ['samples'] });
    expect(samples.matches).toBeUndefined();
    expect(samples.samples).toHaveLength(4);
    const long = await seek({ min_seconds: 3 });
    expect(long.matches?.grey).toHaveLength(1);
    const longer = await seek({ min_seconds: 3.5 });
    expect(longer.matches?.grey).toEqual([]);
  });
});

describe.skipIf(!ffmpeg || !listenModels)('media.listen filters', () => {
  let env: TestEnv;
  let client: Client;
  let media_id: string;

  beforeAll(async () => {
    env = await testRuntime();
    client = await connect(env.runtime);
    // Rain-like noise all the way through: a sound that is there most of the time.
    const file = join(env.mediaDir, 'hiss.wav');
    await ff(['-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:a=0.3:d=30', file]);
    const started = await ok<{ job_id?: string; media_id: string }>(client, 'media.import', {
      source: { path: file },
    });
    if (started.job_id) await settled(client, started.job_id, 120_000);
    media_id = started.media_id;
  }, 120_000);

  afterAll(() => env?.runtime.stop());

  async function listen(args: Record<string, unknown>) {
    const started = await ok<{ job_id: string }>(client, 'media.listen', {
      media_id,
      sounds: { rain: 'rain', speech: 'a man speaking' },
      ...args,
    });
    const done = await settled<{ result: Record<string, unknown> }>(
      client,
      started.job_id,
      240_000,
    );
    return MediaListenResult.strict().parse(done.result);
  }

  it('returns only what include names, and only runs at least min_seconds long', async () => {
    const all = await listen({ min_probability: 0.3 });
    expect(all.matches && all.peaks && all.scores).toBeTruthy();
    const peaks = await listen({ min_probability: 0.3, include: ['peaks'] });
    expect(peaks.matches).toBeUndefined();
    expect(peaks.scores).toBeUndefined();
    expect(peaks.peaks).toEqual(all.peaks);
    const long = await listen({ min_probability: 0.3, min_seconds: 1 });
    for (const [name, runs] of Object.entries(long.matches ?? {})) {
      for (const r of runs) expect(r.end - r.start).toBeGreaterThanOrEqual(1);
      expect(runs.length).toBeLessThanOrEqual(all.matches?.[name]?.length ?? 0);
    }
  }, 600_000);
});
