import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, parseApiKeys } from '../src/http.ts';

// create.lipsync end to end over HTTP in hosted mode: the user's sync. labs key arrives in the
// X-Cuttingfloor-Key-Sync header and reaches a stand-in for api.sync.so (assets, generate, poll,
// download); FFmpeg cuts the spans and imports the result. The key must never be stored.

const exec = promisify(execFile);
const ffmpeg = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
if (!ffmpeg && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg is missing');
}

const SYNC_KEY = 'sk-sync-test-secret-0123456789';
const CF_KEY = 'cf_lipsync_test_key_0123456789';

interface Seen {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  body?: Record<string, unknown>;
}

let dir: string;
let runtime: Runtime;
let sync: Server;
let mcp: Server;
let syncBase: string;
let mcpBase: string;
const seen: Seen[] = [];
const uploads = new Map<string, { file: string; type: string }>();
let polls = 0;

async function ffmpegRun(args: string[]) {
  await exec('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
}

async function duration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(stdout.trim());
}

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'lipsync-test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${CF_KEY}`, ...headers } },
    }),
  );
  return client;
}

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
};
const callTool = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as Result;

async function settle(c: Client, jobId: string, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await callTool(c, 'job.get', { job_id: jobId });
    const view = r.structuredContent as { status: string } & Record<string, unknown>;
    if (view.status !== 'working') return view;
    if (Date.now() > until) throw new Error(`job ${jobId} still working`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function importUrl(c: Client, name: string): Promise<string> {
  const r = await callTool(c, 'media.import', { source: { url: `${syncBase}/fixtures/${name}` } });
  const { job_id, media_id } = r.structuredContent as { job_id: string; media_id: string };
  const done = await settle(c, job_id);
  expect(done.status, JSON.stringify(done)).toBe('completed');
  return media_id;
}

/** Every file under the data root, read as text, so a test can check no key was written. */
async function allFiles(root: string): Promise<string> {
  let out = '';
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await stat(path)).size < 5_000_000) out += (await readFile(path)).toString('latin1');
  }
  return out;
}

describe.skipIf(!ffmpeg)('create.lipsync with a stand-in sync. labs', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cf-lipsync-'));
    // A 4 s talking "video", 2 s of new "speech", and the provider's 2 s result.
    await ffmpegRun([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'talk.mp4'),
    ]);
    await ffmpegRun(['-f', 'lavfi', '-i', 'sine=frequency=600:duration=2', join(dir, 'line.wav')]);
    await ffmpegRun([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=25:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=600:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'synced.mp4'),
    ]);

    sync = createPlainServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const raw = await readBody(req);
      if (url.pathname.startsWith('/fixtures/') || url.pathname.startsWith('/out/')) {
        const file = join(
          dir,
          url.pathname.startsWith('/out/') ? 'synced.mp4' : url.pathname.slice(10),
        );
        res.writeHead(200, { 'content-length': (await stat(file)).size });
        createReadStream(file).pipe(res);
        return;
      }
      const entry: Seen = { method: req.method ?? '', path: url.pathname, headers: req.headers };
      if (url.pathname.startsWith('/upload/')) {
        seen.push(entry);
        const n = url.pathname.slice('/upload/'.length);
        const file = join(dir, `uploaded-${n}`);
        await writeFile(file, raw);
        uploads.set(n, { file, type: String(req.headers['content-type']) });
        return res.writeHead(200).end();
      }
      if (raw.length) entry.body = JSON.parse(raw.toString()) as Record<string, unknown>;
      seen.push(entry);
      if (req.headers['x-api-key'] !== SYNC_KEY) {
        return json(res, 401, { statusCode: 401, message: 'Invalid API key' });
      }
      if (url.pathname === '/v2/assets/upload' && req.method === 'POST') {
        const n = String(seen.filter((s) => s.path === '/v2/assets/upload').length);
        return json(res, 201, {
          uploadUrl: `${syncBase}/upload/${n}`,
          url: `https://assets.example/uploads/${n}/${entry.body?.fileName}`,
          expiresIn: 3600,
        });
      }
      if (url.pathname === '/v2/assets' && req.method === 'POST') {
        return json(res, 201, { id: `asset-${String(entry.body?.url).split('/')[4]}` });
      }
      if (url.pathname === '/v2/generate' && req.method === 'POST') {
        if (entry.body?.model === 'sync-3') {
          return json(res, 422, {
            statusCode: 422,
            message: "The input exceeds your plan's output-duration limit.",
            errorCode: 'generation_plan_duration_exceeded',
            suggestion: 'Shorten the input media or upgrade your plan',
          });
        }
        polls = 0;
        return json(res, 201, {
          id: 'gen-1',
          status: 'PENDING',
          createdAt: new Date().toISOString(),
        });
      }
      if (url.pathname === '/v2/generate/gen-1' && req.method === 'GET') {
        polls++;
        return polls < 2
          ? json(res, 200, { id: 'gen-1', status: 'PROCESSING' })
          : json(res, 200, {
              id: 'gen-1',
              status: 'COMPLETED',
              outputUrl: `${syncBase}/out/gen-1.mp4`,
              outputDuration: 2,
            });
      }
      return json(res, 404, { statusCode: 404, message: 'not found' });
    });
    await new Promise<void>((r) => sync.listen(0, '127.0.0.1', r));
    syncBase = `http://127.0.0.1:${(sync.address() as AddressInfo).port}`;

    runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'hosted',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [],
      exportsDir: null,
      maxJobs: 2,
      outputUrlTtlMs: 60_000,
      maxDownloadBytes: 1024 ** 3,
      allowPrivateUrls: true,
      inlineMaxBytes: 1024 ** 2,
      motionUrl: null,
      syncUrl: syncBase,
    });
    await runtime.start({ sweep: false });
    mcp = createHttpServer({
      runtime,
      // Hosted, nothing but the server's own TypeSafe key comes from the environment.
      credentials: new LocalCredentialStore({}, false),
      apiKeys: parseApiKeys(`creator:${CF_KEY}`),
    });
    await new Promise<void>((r) => mcp.listen(0, '127.0.0.1', r));
    mcpBase = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(() => {
    sync?.close();
    mcp?.close();
  });

  it('asks for the key before any job, saying where it goes hosted and locally', async () => {
    const c = await connect({});
    const r = await callTool(c, 'create.lipsync', {
      video: 'm_nnnnnnnnnnnnnnnnnnnnnnnnnn',
      audio: 'm_nnnnnnnnnnnnnnnnnnnnnnnnnn',
    });
    expect(r.isError).toBe(true);
    const err = r.structuredContent as {
      code: string;
      detail: Record<string, unknown>;
      hint: string;
    };
    expect(err.code).toBe('credential_required');
    expect(err.detail).toEqual({
      provider: 'sync',
      env: 'SYNC_API_KEY',
      header: 'X-Cuttingfloor-Key-Sync',
    });
    expect(err.hint).toMatch(/X-Cuttingfloor-Key-Sync: <key>/);
    expect(err.hint).toMatch(/SYNC_API_KEY=<key>/);
    const jobs = (await callTool(c, 'job.list', {})).structuredContent as { jobs: unknown[] };
    expect(jobs.jobs).toHaveLength(0);
    // Health says whether this request carries a key, never the key.
    const health = await c.readResource({ uri: 'video://server/health' });
    const body = JSON.parse(String((health.contents[0] as { text: string }).text));
    expect(body.providers.sync).toEqual({ configured: false });
    const keyed = await connect({ 'X-Cuttingfloor-Key-Sync': SYNC_KEY });
    const h2 = await keyed.readResource({ uri: 'video://server/health' });
    const text = String((h2.contents[0] as { text: string }).text);
    expect(JSON.parse(text).providers.sync).toEqual({ configured: true, source: 'header' });
    expect(text).not.toContain(SYNC_KEY);
  });

  it('re-syncs a span of the video to new speech with the header key and imports the result', async () => {
    const c = await connect({ 'X-Cuttingfloor-Key-Sync': SYNC_KEY });
    const video = await importUrl(c, 'talk.mp4');
    const audio = await importUrl(c, 'line.wav');
    seen.length = 0;
    const r = await callTool(c, 'create.lipsync', {
      video,
      audio,
      range: { start_seconds: 1, end_seconds: 3 },
      audio_range: { start_seconds: 0, end_seconds: 1.5 },
    });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const started = r.structuredContent as { job_id: string; media_id: string };
    const done = await settle(c, started.job_id);
    expect(done.status, JSON.stringify(done)).toBe('completed');
    const result = done.result as {
      media_id: string;
      duration_seconds: number;
      has_audio: boolean;
    };
    expect(result.media_id).toBe(started.media_id);
    expect(result.duration_seconds).toBeCloseTo(2, 0);
    expect(result.has_audio).toBe(true);

    // The key went in x-api-key to the API only, never to the storage upload.
    const api = seen.filter((s) => s.path.startsWith('/v2/'));
    expect(api.length).toBeGreaterThanOrEqual(6);
    for (const s of api) expect(s.headers['x-api-key']).toBe(SYNC_KEY);
    for (const s of seen.filter((s) => s.path.startsWith('/upload/')))
      expect(s.headers['x-api-key']).toBeUndefined();
    // Only the spans were sent: 2 s of picture, 1.5 s of speech.
    const [v, a] = [uploads.get('1'), uploads.get('2')];
    expect(v?.type).toBe('video/mp4');
    expect(a?.type).toBe('audio/wav');
    expect(await duration(v?.file as string)).toBeCloseTo(2, 1);
    expect(await duration(a?.file as string)).toBeCloseTo(1.5, 1);
    const assets = seen.filter((s) => s.path === '/v2/assets').map((s) => s.body?.type);
    expect(assets).toEqual(['VIDEO', 'AUDIO']);
    const gen = seen.find((s) => s.path === '/v2/generate');
    expect(gen?.body).toEqual({
      model: 'lipsync-2',
      input: [
        { type: 'video', assetId: 'asset-1' },
        { type: 'audio', assetId: 'asset-2' },
      ],
      options: { sync_mode: 'remap' },
    });
    expect(String(gen?.headers['idempotency-key'])).toMatch(/^cf-/);

    // The same recipe returns the same media without asking the provider again.
    const generations = seen.filter((s) => s.path === '/v2/generate').length;
    const again = await callTool(c, 'create.lipsync', {
      video,
      audio,
      range: { start_seconds: 1, end_seconds: 3 },
      audio_range: { start_seconds: 0, end_seconds: 1.5 },
    });
    // Made before: the media comes back at once, with no job.
    const twice = again.structuredContent as { job_id?: string; media_id: string };
    expect(twice.job_id).toBeUndefined();
    expect(twice.media_id).toBe(started.media_id);
    expect(seen.filter((s) => s.path === '/v2/generate').length).toBe(generations);

    // Nothing written under the data root holds the key.
    expect(await allFiles(join(dir, 'data'))).not.toContain(SYNC_KEY);
  }, 120_000);

  it("returns the provider's limits as facts, and a refused key as credential_invalid", async () => {
    const c = await connect({ 'X-Cuttingfloor-Key-Sync': SYNC_KEY });
    const video = await importUrl(c, 'talk.mp4');
    const audio = await importUrl(c, 'line.wav');
    const r = await callTool(c, 'create.lipsync', { video, audio, model: 'sync-3' });
    const job = (r.structuredContent as { job_id: string }).job_id;
    const failed = await settle(c, job);
    expect(failed.status).toBe('failed');
    const error = failed.error as { code: string; detail: Record<string, unknown>; hint: string };
    expect(error.code).toBe('limit_exceeded');
    expect(error.detail).toEqual({
      provider: 'sync',
      status: 422,
      error_code: 'generation_plan_duration_exceeded',
    });
    expect(error.hint).toMatch(/Shorten the input media/);
    expect(error.hint).toMatch(/range/);

    const wrong = await connect({ 'X-Cuttingfloor-Key-Sync': 'sk-wrong' });
    const w = await callTool(wrong, 'create.lipsync', {
      video,
      audio,
      range: { start_seconds: 0, end_seconds: 1 },
    });
    const refused = await settle(wrong, (w.structuredContent as { job_id: string }).job_id);
    expect(refused.status).toBe('failed');
    const e2 = refused.error as { code: string; hint: string; message: string };
    expect(e2.code).toBe('credential_invalid');
    expect(e2.hint).toMatch(/X-Cuttingfloor-Key-Sync/);
    expect(JSON.stringify(refused)).not.toContain('sk-wrong');
    expect(await allFiles(join(dir, 'data'))).not.toContain('sk-wrong');
  }, 120_000);

  it('refuses media without the stream it needs, before any job', async () => {
    const c = await connect({ 'X-Cuttingfloor-Key-Sync': SYNC_KEY });
    const audio = await importUrl(c, 'line.wav');
    const r = await callTool(c, 'create.lipsync', { video: audio, audio });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe('bad_request');
    const late = await callTool(c, 'create.lipsync', {
      video: await importUrl(c, 'talk.mp4'),
      audio,
      range: { start_seconds: 9, end_seconds: 10 },
    });
    expect((late.structuredContent as { code: string; hint: string }).hint).toMatch(/up to 4/);
  }, 60_000);
});
