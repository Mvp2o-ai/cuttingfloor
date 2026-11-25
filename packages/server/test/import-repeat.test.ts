// A URL another account already imported: the same bytes from the same URL are copied from what
// the server made of them (proxy, probe, measurements), not made again. Needs FFmpeg; skips
// without it unless CUTTINGFLOOR_REQUIRE_ENGINES is set.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

const exec = promisify(execFile);
const ffmpeg = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
if (!ffmpeg && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg is missing');
}

let env: TestEnv;
let files: Server;
let base: string;

beforeAll(async () => {
  if (!ffmpeg) return;
  env = await testRuntime();
  await exec('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    join(env.mediaDir, 'clip.mp4'),
  ]);
  const clip = await readFile(join(env.mediaDir, 'clip.mp4'));
  // Two URLs serving the same bytes.
  files = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' }).end(clip);
  });
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  files?.close();
  await env?.runtime.close();
});

async function importUrl(client: Client, url: string): Promise<string> {
  const started = await ok<{ job_id: string; media_id: string }>(client, 'media.import', {
    source: { url },
  });
  const done = await settled<{ result?: { media_id: string; status: string }; error?: unknown }>(
    client,
    started.job_id,
    60_000,
  );
  if (done.error) throw new Error(`import failed: ${JSON.stringify(done.error)}`);
  expect(done.result?.status).toBe('ready');
  return started.media_id;
}

describe.skipIf(!ffmpeg)('a URL another account imported', () => {
  it('copies what was made of the same bytes into the new account, its own files', async () => {
    const { runtime } = env;
    const a = await importUrl(await connect(runtime, 'acct-a'), `${base}/demo.mp4`);
    // Mark A's measurement: a copy carries it, an import made again measures afresh.
    const first = await runtime.media.get('acct-a', a);
    first.analysis = { loudness_lufs: -12.345 };
    await runtime.media.save('acct-a', first);

    const b = await importUrl(await connect(runtime, 'acct-b'), `${base}/demo.mp4`);
    expect(b).not.toBe(a);
    const copied = await runtime.media.get('acct-b', b);
    expect(copied).toMatchObject({
      status: 'ready',
      fingerprint: first.fingerprint,
      probe: first.probe,
      analysis: { loudness_lufs: -12.345 },
    });
    // Its proxy is a copy under its own media, so it outlives A's.
    expect(copied.proxy).toBeTruthy();
    expect(copied.proxy).not.toBe(first.proxy);
    expect(copied.proxy).toContain(b);
    const clientA = await connect(runtime, 'acct-a');
    await ok(clientA, 'media.delete', { media_id: a });
    expect(await runtime.ws.blobs.head(copied.proxy as string)).toBeTruthy();

    // The same bytes from another URL are imported afresh, so a lookup says nothing about
    // files a caller didn't fetch from that URL itself.
    const c = await importUrl(await connect(runtime, 'acct-c'), `${base}/other.mp4`);
    expect((await runtime.media.get('acct-c', c)).analysis).not.toEqual({ loudness_lufs: -12.345 });
  }, 120_000);
});
