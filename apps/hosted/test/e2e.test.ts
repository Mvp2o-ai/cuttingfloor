import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { startMotionWorker } from '@cuttingfloor/motion';
import { createServer, Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createTaskSessionFromClient,
  resultFromTaskOutcome,
} from '@modelcontextprotocol/ext-tasks/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';

interface TestEnv {
  runtime: Runtime;
  dir: string;
  mediaDir: string;
  exportsDir: string;
}

async function testRuntime(motionUrl: string | null = null): Promise<TestEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-e2e-'));
  const mediaDir = join(dir, 'media');
  const exportsDir = join(dir, 'exports');
  await mkdir(mediaDir, { recursive: true });
  const runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'local',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [mediaDir],
    exportsDir,
    maxJobs: 2,
    outputUrlTtlMs: 3_600_000,
    maxDownloadBytes: 1024 ** 3,
    allowPrivateUrls: true,
    inlineMaxBytes: 32 * 1024 ** 2,
    motionUrl,
    ...(process.env.CUTTINGFLOOR_MODELS ? { modelsDir: process.env.CUTTINGFLOOR_MODELS } : {}),
  });
  await runtime.start({ sweep: false });
  return { runtime, dir, mediaDir, exportsDir };
}

interface CallResult {
  isError: boolean;
  structured: Record<string, unknown>;
  content: Array<{ type: string; [k: string]: unknown }>;
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: CallResult['content'];
  };
  return {
    isError: Boolean(res.isError),
    structured: res.structuredContent ?? {},
    content: res.content,
  };
}

async function ok<T = Record<string, unknown>>(
  c: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await call(c, name, args);
  if (res.isError) {
    // Protocol-level failures (e.g. an output that fails its schema) carry only text.
    const text = res.content.map((c) => (c.type === 'text' ? String(c.text) : '')).join(' ');
    throw new Error(`${name} failed: ${JSON.stringify(res.structured)} ${text}`);
  }
  return res.structured as T;
}

const exec = promisify(execFile);

async function enginesAvailable(): Promise<boolean> {
  try {
    await exec('melt', ['--version']);
    await exec('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

const engines = await enginesAvailable();
if (!engines && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg/melt are missing');
}

// The motion worker runs in-process here with a test Chromium (no sandbox: tests run as root in
// docker build); the sandbox itself is checked in its container by scripts/smoke-motion.ts.
const chromium = await exec('/usr/bin/chromium', ['--version']).then(
  () => true,
  () => false,
);
if (engines && !chromium && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but Chromium is missing');
}
// code.run scripts use namespaces where this host allows them; docker build does not.
const namespaces = await exec('unshare', [
  '--user',
  '--map-current-user',
  '--pid',
  '--fork',
  '--net',
  'true',
]).then(
  () => true,
  () => false,
);
if (!namespaces) process.env.CUTTINGFLOOR_CODE_ISOLATION = 'none';
let motionWorker: Server | undefined;

async function startTestMotion(): Promise<string | null> {
  if (!chromium) return null;
  process.env.CUTTINGFLOOR_CHROMIUM = fileURLToPath(
    new URL('./fixtures/chromium-test', import.meta.url),
  );
  motionWorker = await startMotionWorker({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(motionWorker.address() as AddressInfo).port}`;
}

const ff = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);

async function ffprobe(file: string) {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-count_packets',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(stdout) as {
    format: { duration: string };
    streams: Array<{
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      nb_read_packets?: string;
      duration?: string;
      profile?: string;
    }>;
  };
}

/** When a file's picture first turns white and its audio first rises above -30 dB, in seconds. */
async function flashAndBeep(file: string): Promise<{ flash: number; beep: number }> {
  const big = { maxBuffer: 512 * 1024 * 1024 };
  const vf = 'signalstats,metadata=print:key=lavfi.signalstats.YAVG';
  const { stderr: v } = await exec(
    'ffmpeg',
    ['-hide_banner', '-i', file, '-an', '-vf', vf, '-f', 'null', '-'],
    big,
  );
  let flash = Number.NaN;
  let t = 0;
  for (const line of v.split('\n')) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) t = Number(pts[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && Number(y[1]) > 128) {
      flash = t;
      break;
    }
  }
  const af = 'silencedetect=n=-30dB:d=0.05';
  const { stderr: a } = await exec(
    'ffmpeg',
    ['-hide_banner', '-i', file, '-vn', '-af', af, '-f', 'null', '-'],
    big,
  );
  return { flash, beep: Number(/silence_end: ([\d.]+)/.exec(a)?.[1]) };
}

/** Mean Y/U/V of an image region (crop w:h:x:y). */
async function regionStats(
  image: Buffer,
  crop: string,
): Promise<{ y: number; u: number; v: number }> {
  const file = join(env.dir, `stat-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(file, image);
  const { stderr } = await exec('ffmpeg', [
    '-hide_banner',
    '-i',
    file,
    '-vf',
    `crop=${crop},signalstats,metadata=print`,
    '-f',
    'null',
    '-',
  ]);
  const get = (k: string) =>
    Number(new RegExp(`lavfi.signalstats.${k}=([\\d.]+)`).exec(stderr)?.[1]);
  return { y: get('YAVG'), u: get('UAVG'), v: get('VAVG') };
}

/** RGB of one pixel of an image. */
async function pixel(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const file = join(env.dir, `px-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(file, image);
  const { stdout } = await exec(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'],
    { encoding: 'buffer' },
  );
  return [stdout[0] ?? -1, stdout[1] ?? -1, stdout[2] ?? -1];
}

/** Rough colour name of an RGB pixel, so assertions read as what a viewer sees. */
function colour([r, g, b]: [number, number, number]): string {
  const hi = (v: number) => v > 170;
  const lo = (v: number) => v < 70;
  if (hi(r) && hi(g) && hi(b)) return 'white';
  if (lo(r) && lo(g) && lo(b)) return 'black';
  if (hi(r) && lo(g) && lo(b)) return 'red';
  if (lo(r) && hi(g) && lo(b)) return 'green';
  if (lo(r) && lo(g) && hi(b)) return 'blue';
  if (hi(r) && hi(g) && lo(b)) return 'yellow';
  if (hi(r) && lo(g) && hi(b)) return 'magenta';
  if (lo(r) && hi(g) && hi(b)) return 'cyan';
  return `rgb(${r},${g},${b})`;
}

let env: TestEnv;
let http: Server;
let base: string;
let client: Client;
let fileServer: Server;
let fileBase: string;

async function waitJob(jobId: string, timeoutMs = 240_000): Promise<Record<string, unknown>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const view = await ok<{ status: string; result?: Record<string, unknown>; error?: unknown }>(
      client,
      'job.get',
      { job_id: jobId },
    );
    if (view.status !== 'working') return view;
    if (Date.now() > until) throw new Error(`job ${jobId} still working`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function importMedia(
  source: Record<string, string>,
): Promise<Record<string, unknown> & { media_id: string }> {
  const started = await ok<{ job_id?: string; media_id: string }>(client, 'media.import', {
    source,
  });
  expect(started.media_id).toMatch(/^m_/);
  // A file with the same content as an earlier import answers at once, with no job.
  if (!started.job_id) {
    return ok<Record<string, unknown> & { media_id: string }>(client, 'media.get', {
      media_id: started.media_id,
    });
  }
  const done = await waitJob(started.job_id);
  if (done.status !== 'completed' || done.error)
    throw new Error(`import failed: ${JSON.stringify(done.error)}`);
  return done.result as Record<string, unknown> & { media_id: string };
}

const media: Record<string, string> = {};

describe.skipIf(!engines)('end to end with FFmpeg and MLT', () => {
  beforeAll(async () => {
    env = await testRuntime(await startTestMotion());
    const m = env.mediaDir;
    await Promise.all([
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '8',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '50',
        '-c:a',
        'aac',
        '-shortest',
        join(m, 'av.mp4'),
      ]),
      ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=720x1280:rate=25',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        join(m, 'portrait.mp4'),
      ]),
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x480:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=48000',
        '-t',
        '6',
        '-vf',
        "setpts='(N+floor(N/3)*0.5)/30/TB'",
        '-fps_mode',
        'passthrough',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        join(m, 'vfr.mp4'),
      ]),
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-t',
        '3',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p10le',
        '-x264-params',
        'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
        join(m, 'hdr.mp4'),
      ]),
      ff(['-f', 'lavfi', '-i', 'color=c=blue:size=400x300', '-frames:v', '1', join(m, 'card.png')]),
      ff([
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000',
        '-t',
        '5',
        '-c:a',
        'pcm_s16le',
        join(m, 'tone.wav'),
      ]),
      // Frame n has luma 16 + 8·(n mod 25): frame accuracy is readable from pixels.
      ff([
        '-f',
        'lavfi',
        '-i',
        'nullsrc=size=320x180:rate=25',
        '-t',
        '4',
        '-vf',
        "geq=lum='16+8*mod(N,25)':cb=128:cr=128",
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-qp',
        '0',
        join(m, 'numbered.mp4'),
      ]),
      ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=1280x720:rate=25',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        join(m, 'black.mp4'),
      ]),
      // 5 minutes of VFR (every 7th frame dropped, timestamps kept) with a white flash and a
      // 1 kHz beep both starting at 299 s: sync at the end is measurable after conform and export.
      ff([
        '-f',
        'lavfi',
        '-i',
        "color=c=black:size=320x180:rate=30:d=300,drawbox=enable='gte(t,299)':color=white:t=fill,select='not(eq(mod(n\\,7)\\,0))'",
        '-f',
        'lavfi',
        '-i',
        "sine=frequency=1000:sample_rate=48000:duration=300,volume=enable='lt(t,299)':volume=0",
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        join(m, 'sync.mov'),
      ]),
      // Crafted inputs: a playlist pointing at a local file, and MLT XML named like a video.
      writeFile(
        join(m, 'evil.m3u8'),
        '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n',
      ),
      writeFile(
        join(m, 'fake.mp4'),
        '<?xml version="1.0"?><mlt><producer id="x"><property name="resource">/etc/passwd</property></producer></mlt>',
      ),
    ]);
    await ff([
      '-display_rotation:v:0',
      '90',
      '-i',
      join(m, 'av.mp4'),
      '-c',
      'copy',
      '-t',
      '3',
      join(m, 'rotated.mp4'),
    ]);

    http = createHttpServer({
      runtime: env.runtime,
      credentials: new LocalCredentialStore({}, false),
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    (env.runtime.config as { publicUrl: string }).publicUrl = base;
    client = new Client({ name: 'e2e', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

    fileServer = createPlainServer(async (req, res) => {
      // Serve only plain file names from the fixture folder.
      const body = await readFile(join(env.mediaDir, basename(req.url ?? '/'))).catch(() => null);
      if (!body) res.writeHead(404).end();
      else res.writeHead(200, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((r) => fileServer.listen(0, '127.0.0.1', r));
    fileBase = `http://127.0.0.1:${(fileServer.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    http?.close();
    fileServer?.close();
    motionWorker?.close();
  });

  it('imports and conforms media as jobs', async () => {
    const av = await importMedia({ path: join(env.mediaDir, 'av.mp4') });
    expect(av).toMatchObject({
      status: 'ready',
      kind: 'video',
      has_audio: true,
      width: 1280,
      height: 720,
      conform: [],
    });
    expect((av.analysis as { loudness_lufs: number }).loudness_lufs).toBeLessThan(0);
    media.av = av.media_id;

    const vfr = await importMedia({ path: join(env.mediaDir, 'vfr.mp4') });
    expect(vfr.conform).toContain('vfr');
    media.vfr = vfr.media_id;

    const rotated = await importMedia({ path: join(env.mediaDir, 'rotated.mp4') });
    expect(rotated.conform).toContain('rotation');
    expect([rotated.width, rotated.height]).toEqual([720, 1280]);

    const hdr = await importMedia({ path: join(env.mediaDir, 'hdr.mp4') });
    expect(hdr.conform).toContain('hdr');

    const card = await importMedia({ path: join(env.mediaDir, 'card.png') });
    expect(card).toMatchObject({ kind: 'image', duration_seconds: null });
    media.card = card.media_id;

    media.portrait = (await importMedia({ path: join(env.mediaDir, 'portrait.mp4') })).media_id;
    media.tone = (await importMedia({ path: join(env.mediaDir, 'tone.wav') })).media_id;
  }, 300_000);

  it('dedupes a repeat import and imports from a URL', async () => {
    // A file imported before answers at once with its existing media_id.
    const again = await ok<{ media_id: string; status: string }>(client, 'media.import', {
      source: { path: join(env.mediaDir, 'av.mp4') },
    });
    expect(again).toMatchObject({ media_id: media.av, status: 'ready' });
    const fromUrl = await importMedia({ url: `${fileBase}/tone.wav` });
    expect(fromUrl).toMatchObject({ status: 'ready', kind: 'audio' });
  }, 120_000);

  it('imports a file sent through media.upload, resumed part way', async () => {
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(env.mediaDir, 'sent.mp4'),
    ]);
    const bytes = await readFile(join(env.mediaDir, 'sent.mp4'));
    const up = await ok<{ upload_id: string; url: string }>(client, 'media.upload', {
      name: 'sent.mp4',
      bytes: bytes.length,
    });
    // The first part, then the rest from where the server says it stands.
    const half = Math.floor(bytes.length / 2);
    const first = await fetch(up.url, {
      method: 'PUT',
      headers: { 'content-range': `bytes 0-${half - 1}/${bytes.length}` },
      body: bytes.subarray(0, half),
    });
    expect(first.headers.get('upload-complete')).toBe('false');
    const offset = Number((await fetch(up.url, { method: 'HEAD' })).headers.get('upload-offset'));
    expect(offset).toBe(half);
    const rest = await fetch(up.url, {
      method: 'PUT',
      headers: { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` },
      body: bytes.subarray(offset),
    });
    expect(await rest.json()).toMatchObject({ complete: true, received: bytes.length });

    const sent = await importMedia({ upload_id: up.upload_id });
    expect(sent).toMatchObject({ status: 'ready', kind: 'video', width: 640, name: 'sent.mp4' });
    // Imported uploads are moved into the media, so the link has nothing left.
    expect((await fetch(up.url, { method: 'HEAD' })).status).toBe(404);

    // The same bytes again are the media already imported.
    const again = await ok<{ upload_id: string; url: string }>(client, 'media.upload', {
      name: 'copy.mp4',
    });
    await fetch(again.url, { method: 'PUT', body: await readFile(join(env.mediaDir, 'av.mp4')) });
    const dup = await ok<{ media_id: string }>(client, 'media.import', {
      source: { upload_id: again.upload_id },
    });
    expect(dup.media_id).toBe(media.av);
  }, 120_000);

  it('imports a data: URI and a file the client attached', async () => {
    const png = await readFile(join(env.mediaDir, 'card.png'));
    await ff([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=48000',
      '-t',
      '1',
      join(env.mediaDir, 'chime.wav'),
    ]);
    const chime = await readFile(join(env.mediaDir, 'chime.wav'));
    const inline = await importMedia({
      data: `data:audio/wav;base64,${chime.toString('base64')}`,
      sha256: createHash('sha256').update(chime).digest('hex'),
    });
    expect(inline).toMatchObject({ status: 'ready', kind: 'audio', name: 'inline.wav' });
    // The same picture as an earlier import is that media.
    const card = await ok<{ media_id: string }>(client, 'media.import', {
      source: { data: `data:image/png;base64,${png.toString('base64')}` },
    });
    expect(card.media_id).toBe(media.card);

    const started = await ok<{ job_id: string }>(client, 'media.import', {
      file: {
        download_url: `${fileBase}/portrait.mp4`,
        file_id: 'file_1',
        mime_type: 'video/mp4',
        file_name: 'from the chat.mp4',
      },
    });
    const done = await waitJob(started.job_id);
    expect(done.result).toMatchObject({ status: 'ready', name: 'from the chat.mp4' });
  }, 120_000);

  let timeline = '';

  it('edits with inline previews that show the right pixels', async () => {
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'E2E cut',
      sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
      tracks: { video: 2, audio: 2 },
    });
    const res = await call(client, 'edit.batch', {
      timeline_id,
      preview: 'inline',
      ops: [
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: media.av, source: { in: 0, out: 100 } },
        },
        // A gap from 100 to 125, then the portrait clip.
        {
          tool: 'clip.add',
          args: {
            track_id: 't1',
            media_id: media.portrait,
            at_frame: 125,
            source: { in: 0, out: 50 },
          },
        },
        {
          tool: 'clip.add',
          args: { track_id: 't2', media_id: media.card, at_frame: 25, duration_frames: 25 },
        },
        {
          tool: 'clip.add',
          args: { track_id: 't4', media_id: media.tone, at_frame: 0, source: { in: 0, out: 125 } },
        },
      ],
    });
    expect(res.isError).toBe(false);
    const image = res.content.find((c) => c.type === 'image') as
      | { data: string; mimeType: string }
      | undefined;
    expect(image?.mimeType).toBe('image/webp');
    const bytes = Buffer.from(image?.data ?? '', 'base64');
    expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
    timeline = res.structured.timeline_id as string;
    expect((res.structured.preview as { status: string }).status).toBe('ready');

    const frames = await call(client, 'render.frames', {
      timeline_id: timeline,
      frames: [10, 30, 110, 140],
      layout: 'single',
      format: 'png',
    });
    const [src, title, gap, portrait] = frames.content
      .filter((c) => c.type === 'image')
      .map((c) => Buffer.from(c.data as string, 'base64'));
    if (!src || !title || !gap || !portrait) throw new Error('missing frames');
    expect((await regionStats(src, 'iw:ih:0:0')).y).toBeGreaterThan(40);
    // The still on V2 covers V1, fitted with its aspect kept: blue in the middle.
    const blue = await regionStats(title, '40:40:iw/2-20:ih/2-20');
    expect(blue.u).toBeGreaterThan(180);
    expect((await regionStats(gap, 'iw:ih:0:0')).y).toBeLessThan(20);
    // Portrait media is pillarboxed: red centre, black edges.
    const centre = await regionStats(portrait, '40:40:iw/2-20:ih/2-20');
    const edge = await regionStats(portrait, '40:40:0:ih/2-20');
    expect(centre.v).toBeGreaterThan(180);
    expect(edge.y).toBeLessThan(20);

    const grid = await call(client, 'render.frames', {
      timeline_id: timeline,
      frames: [0, 50, 100, 150],
    });
    expect(grid.content.filter((c) => c.type === 'image')).toHaveLength(1);
  }, 120_000);

  it('links frames and media for download, and renders JPEG at a quality', async () => {
    const sizes: number[] = [];
    for (const quality of [30, 95]) {
      const res = await ok<{ images: Array<{ url: string; mime_type: string; bytes: number }> }>(
        client,
        'render.frames',
        { timeline_id: timeline, frames: [10, 30], layout: 'single', format: 'jpeg', quality },
      );
      expect(res.images).toHaveLength(2);
      expect(res.images[0]?.mime_type).toBe('image/jpeg');
      const got = await fetch(res.images[0]?.url ?? '');
      expect(got.headers.get('content-type')).toBe('image/jpeg');
      const body = Buffer.from(await got.arrayBuffer());
      expect(body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
      expect(body.length).toBe(res.images[0]?.bytes);
      sizes.push(body.length);
    }
    expect(sizes[0]).toBeLessThan(sizes[1] as number);
    const info = await ok<{ url: string }>(client, 'media.get', { media_id: media.card });
    const file = await fetch(info.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(
      await readFile(join(env.mediaDir, 'card.png')),
    );
  }, 120_000);

  it('serves previews as links that render on read', async () => {
    const trimmed = await ok<{ timeline_id: string; preview: { uri: string; frames: number[] } }>(
      client,
      'clip.trim',
      {
        timeline_id: timeline,
        clip_id: 'c6',
        edge: 'end',
        to_frame: 90,
      },
    );
    expect(trimmed.preview.frames.length).toBeGreaterThan(1);
    const res = await client.readResource({ uri: trimmed.preview.uri });
    const blob = res.contents[0] && 'blob' in res.contents[0] ? res.contents[0].blob : '';
    expect(Buffer.from(blob, 'base64').subarray(8, 12).toString()).toBe('WEBP');
    await expect(
      client.readResource({ uri: `video://timeline/${trimmed.timeline_id}/frames/99999.webp` }),
    ).rejects.toThrow(/past the end/);
  }, 60_000);

  it('measures the render: gaps, frames, loudness, and black and silence with given settings', async () => {
    type Span = { start: number; end: number };
    const report = await ok<{
      gaps: Span[];
      frames: { expected: number; rendered: number };
      black?: Span[];
      integrated_lufs: number | null;
    }>(client, 'qa.check', { timeline_id: timeline });
    expect(report.gaps).toEqual([{ start: 100, end: 125 }]);
    expect(report.frames).toEqual({ expected: 175, rendered: 175 });
    // Nothing is looked for that was not asked for.
    expect(report.black).toBeUndefined();

    // Planted: black picture 50–100, silence 50–125 (no audio there), a gap 100–125.
    const black = (await importMedia({ path: join(env.mediaDir, 'black.mp4') })).media_id;
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'qa',
      sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
    });
    const planted = await ok<{ timeline_id: string }>(client, 'edit.batch', {
      timeline_id,
      preview: 'none',
      ops: [
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: media.av, source: { in: 0, out: 50 } },
        },
        { tool: 'clip.add', args: { track_id: 't1', media_id: black, source: { in: 0, out: 50 } } },
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: media.av, at_frame: 125, source: { in: 50, out: 100 } },
        },
      ],
    });
    const qa = await ok<{
      gaps: Span[];
      black: Span[];
      silences: Span[];
      integrated_lufs: number | null;
      true_peak_dbtp: number | null;
    }>(client, 'qa.check', {
      timeline_id: planted.timeline_id,
      black: { pixel_threshold: 0.1, picture_share: 0.98, min_seconds: 0.5 },
      silence: { threshold_db: -50, min_seconds: 1 },
    });
    expect(qa.gaps).toEqual([{ start: 100, end: 125 }]);
    expect(qa.black[0]?.start).toBeGreaterThanOrEqual(49);
    expect(qa.black[0]?.end).toBeLessThanOrEqual(101);
    expect(qa.silences[0]?.start).toBeLessThanOrEqual(51);
    expect(qa.silences[0]?.end).toBeGreaterThanOrEqual(124);
    expect(qa.integrated_lufs).toBeLessThan(0);
    expect(qa.true_peak_dbtp).toBeLessThan(0);
  }, 120_000);

  it('renders the exact source frame', async () => {
    const numbered = (await importMedia({ path: join(env.mediaDir, 'numbered.mp4') })).media_id;
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'frames',
      sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
    });
    const added = await ok<{ timeline_id: string }>(client, 'clip.add', {
      timeline_id,
      track_id: 't1',
      media_id: numbered,
      at_frame: 10,
      source: { in: 7, out: 40 },
      preview: 'none',
    });
    const res = await call(client, 'render.frames', {
      timeline_id: added.timeline_id,
      frames: [10, 15, 27],
      layout: 'single',
      format: 'png',
      long_edge: 320,
    });
    const images = res.content
      .filter((c) => c.type === 'image')
      .map((c) => Buffer.from(c.data as string, 'base64'));
    // Timeline frame 10 shows source frame 7, 15 → 12, 27 → 24.
    const lumas = await Promise.all(images.map((img) => regionStats(img, '64:64:128:58')));
    expect(lumas.map((l) => Math.round((l.y - 16) / 8))).toEqual([7, 12, 24]);
  }, 120_000);

  describe('compositing', () => {
    let base = '';
    const ids: Record<string, string> = {};

    /** One frame of a timeline as a 1280×720 PNG. */
    async function frameImage(timelineId: string, frame: number): Promise<Buffer> {
      const res = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames: [frame],
        layout: 'single',
        format: 'png',
        long_edge: 1280,
      });
      if (res.isError) throw new Error(JSON.stringify(res.structured));
      const image = res.content.find((c) => c.type === 'image');
      return Buffer.from((image?.data as string) ?? '', 'base64');
    }

    /** Names the colour at each point of a frame. */
    async function look(
      timelineId: string,
      frame: number,
      points: Array<[number, number]>,
    ): Promise<string[]> {
      const image = await frameImage(timelineId, frame);
      return Promise.all(points.map(async ([x, y]) => colour(await pixel(image, x, y))));
    }

    /** One edit on top of the base timeline (green V1 under red 4:3 on V2, 50 frames). */
    async function withEdit(tool: string, args: Record<string, unknown>): Promise<string> {
      return (
        await ok<{ timeline_id: string }>(client, tool, {
          timeline_id: base,
          preview: 'none',
          ...args,
        })
      ).timeline_id;
    }

    beforeAll(async () => {
      const m = env.mediaDir;
      // Fixtures, made one at a time to keep memory low: a 4:3 red picture, a 16:9 green
      // one, a 4:3 picture split red | blue, and a white disc on transparency (ProRes 4444,
      // so it keeps its alpha).
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=640x480:rate=25',
        '-t',
        '3',
        '-pix_fmt',
        'yuv420p',
        join(m, 'red43.mp4'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x00ff00:size=1280x720:rate=25',
        '-t',
        '3',
        '-pix_fmt',
        'yuv420p',
        join(m, 'green.mp4'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        "color=c=red:size=640x480:rate=25,format=rgb24,geq=r='if(lt(X,320),255,0)':g=0:b='if(lt(X,320),0,255)'",
        '-t',
        '3',
        '-pix_fmt',
        'yuv444p',
        join(m, 'halves.mp4'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        "color=c=white:size=640x480:rate=25,format=rgba,geq=r=255:g=255:b=255:a='if(lt(hypot(X-320,Y-240),200),255,0)'",
        '-t',
        '3',
        '-c:v',
        'prores_ks',
        '-profile:v',
        '4',
        '-pix_fmt',
        'yuva444p10le',
        join(m, 'disc.mov'),
      ]);
      for (const name of ['red43', 'green', 'halves'])
        ids[name] = (await importMedia({ path: join(env.mediaDir, `${name}.mp4`) })).media_id;
      ids.disc = (await importMedia({ path: join(env.mediaDir, 'disc.mov') })).media_id;
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'compositing',
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: 2, audio: 0 },
      });
      base = (
        await ok<{ timeline_id: string }>(client, 'edit.batch', {
          timeline_id,
          preview: 'none',
          ops: [
            {
              tool: 'clip.add',
              args: {
                track_id: 't1',
                media_id: ids.green,
                av: 'video',
                source: { in: 0, out: 50 },
              },
            },
            {
              tool: 'clip.add',
              args: {
                track_id: 't2',
                media_id: ids.red43,
                av: 'video',
                source: { in: 0, out: 50 },
              },
            },
          ],
        })
      ).timeline_id;
    }, 300_000);

    it('fits a picture with its aspect kept and transparent bars', async () => {
      expect(
        await look(base, 10, [
          [100, 360],
          [640, 360],
          [1180, 360],
        ]),
      ).toEqual(['green', 'red', 'green']);
    }, 60_000);

    it('positions, scales and rotates', async () => {
      // Half size at the top-left quarter: 480×360 centred on (320, 180).
      const pip = await withEdit('clip.set_transform', {
        clip_id: 'c4',
        scale: 0.5,
        x: 0.25,
        y: 0.25,
      });
      expect(
        await look(pip, 10, [
          [320, 180],
          [100, 100],
          [640, 360],
          [700, 180],
        ]),
      ).toEqual(['red', 'red', 'green', 'green']);
      // A quarter turn makes the half-size picture 360 wide and 480 tall about the centre.
      const turned = await withEdit('clip.set_transform', {
        clip_id: 'c4',
        scale: 0.5,
        rotation: 90,
      });
      expect(
        await look(turned, 10, [
          [640, 150],
          [430, 360],
          [500, 360],
        ]),
      ).toEqual(['red', 'green', 'red']);
    }, 60_000);

    it('animates with keyframes and fades', async () => {
      const moving = await withEdit('clip.set_transform', {
        clip_id: 'c4',
        scale: 0.25,
        x: {
          keyframes: [
            { frame: 0, value: 0.125 },
            { frame: 40, value: 0.875 },
          ],
        },
      });
      // 240×180 boxes: at frame 0 centred on x 160; at frame 20 on x 640; at frame 40 on x 1120.
      expect(
        await look(moving, 0, [
          [160, 360],
          [640, 360],
        ]),
      ).toEqual(['red', 'green']);
      expect(
        await look(moving, 20, [
          [160, 360],
          [640, 360],
        ]),
      ).toEqual(['green', 'red']);
      expect(
        await look(moving, 45, [
          [1120, 360],
          [640, 360],
        ]),
      ).toEqual(['red', 'green']);
      const half = await withEdit('clip.set_transform', { clip_id: 'c4', opacity: 0.5 });
      // Half red over green.
      const [r, g] = await pixel(await frameImage(half, 10), 640, 360);
      expect(r).toBeGreaterThan(90);
      expect(r).toBeLessThan(165);
      expect(g).toBeGreaterThan(90);
      expect(g).toBeLessThan(165);
      const faded = await withEdit('clip.set_animation', {
        clip_id: 'c4',
        in: { name: 'fade', duration_frames: 10 },
      });
      expect(await look(faded, 0, [[640, 360]])).toEqual(['green']);
      expect(await look(faded, 20, [[640, 360]])).toEqual(['red']);
    }, 120_000);

    it('blends', async () => {
      const multiplied = await withEdit('clip.set_blend', { clip_id: 'c4', mode: 'multiply' });
      expect(
        await look(multiplied, 10, [
          [640, 360],
          [100, 360],
        ]),
      ).toEqual(['black', 'green']);
      const screened = await withEdit('clip.set_blend', { clip_id: 'c4', mode: 'screen' });
      expect(await look(screened, 10, [[640, 360]])).toEqual(['yellow']);
    }, 60_000);

    it('masks, inverts and crops in the picture, never in the bars', async () => {
      // An ellipse half the picture's size: the picture's corner area shows V1 through.
      const ellipse = await withEdit('clip.set_mask', {
        clip_id: 'c4',
        mask: { shape: 'ellipse' },
      });
      expect(
        await look(ellipse, 10, [
          [640, 360],
          [200, 40],
          [100, 360],
        ]),
      ).toEqual(['red', 'green', 'green']);
      const inverted = await withEdit('clip.set_mask', {
        clip_id: 'c4',
        mask: { shape: 'ellipse', invert: true },
      });
      expect(
        await look(inverted, 10, [
          [640, 360],
          [200, 40],
          [100, 360],
        ]),
      ).toEqual(['green', 'red', 'green']);
      // A linear mask keeps the lower half; the bars beside it stay clear.
      const linear = await withEdit('clip.set_mask', { clip_id: 'c4', mask: { shape: 'linear' } });
      expect(
        await look(linear, 10, [
          [640, 200],
          [640, 600],
          [100, 600],
        ]),
      ).toEqual(['green', 'red', 'green']);
      // Cropping the left half hides it and leaves the right half where it was.
      const cropped = await withEdit('clip.set_transform', { clip_id: 'c4', crop: { left: 0.5 } });
      expect(
        await look(cropped, 10, [
          [300, 360],
          [900, 360],
          [100, 360],
        ]),
      ).toEqual(['green', 'red', 'green']);
    }, 120_000);

    it('flips', async () => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'clip.add', {
        timeline_id: base,
        track_id: 't2',
        media_id: ids.halves,
        av: 'video',
        at_frame: 0,
        source: { in: 0, out: 50 },
        preview: 'none',
      });
      expect(
        await look(timeline_id, 10, [
          [400, 360],
          [880, 360],
        ]),
      ).toEqual(['red', 'blue']);
      const flipped = await ok<{ timeline_id: string }>(client, 'clip.set_transform', {
        timeline_id,
        clip_id: 'c5',
        flip: 'horizontal',
        preview: 'none',
      });
      expect(
        await look(flipped.timeline_id, 10, [
          [400, 360],
          [880, 360],
        ]),
      ).toEqual(['blue', 'red']);
    }, 60_000);

    it("keeps a picture's own transparency under a mask", async () => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'clip.add', {
        timeline_id: base,
        track_id: 't2',
        media_id: ids.disc,
        av: 'video',
        at_frame: 0,
        source: { in: 0, out: 50 },
        preview: 'none',
      });
      // Disc of radius 200 source px = 300 px on screen, centred; transparent around it.
      expect(
        await look(timeline_id, 10, [
          [640, 360],
          [200, 40],
        ]),
      ).toEqual(['white', 'green']);
      const masked = await ok<{ timeline_id: string }>(client, 'clip.set_mask', {
        timeline_id,
        clip_id: 'c5',
        mask: { shape: 'rectangle', x: 0.25, width: 0.5, height: 1 },
        preview: 'none',
      });
      // Left half of the disc stays, right half is masked, and the transparent corners stay clear.
      expect(
        await look(masked.timeline_id, 10, [
          [500, 360],
          [780, 360],
          [200, 40],
        ]),
      ).toEqual(['white', 'green', 'green']);
    }, 120_000);

    it('composites a nested timeline, transparent where it is empty', async () => {
      // Inner: the 4:3 red picture alone on a 16:9 timeline, so its sides are empty.
      const { timeline_id: blank } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'inner',
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: 1, audio: 0 },
      });
      const inner = await ok<{ timeline_id: string }>(client, 'clip.add', {
        timeline_id: blank,
        track_id: 't1',
        media_id: ids.red43,
        av: 'video',
        source: { in: 0, out: 50 },
        preview: 'none',
      });
      const outer = await ok<{ timeline_id: string }>(client, 'edit.batch', {
        timeline_id: base,
        preview: 'none',
        ops: [
          { tool: 'clip.remove', args: { clip_id: 'c4' } },
          {
            tool: 'clip.add',
            args: { track_id: 't2', nested_timeline_id: inner.timeline_id, at_frame: 0 },
          },
          { tool: 'clip.set_transform', args: { clip_id: { $ref: 'ops[1].clip_id' }, scale: 0.5 } },
        ],
      });
      // Half size: the nested frame spans 320–960; its red picture 400–880; green shows through
      // the nested timeline's empty sides.
      expect(
        await look(outer.timeline_id, 10, [
          [640, 360],
          [360, 360],
          [100, 360],
        ]),
      ).toEqual(['red', 'green', 'green']);
      const view = await ok<{ nested: Record<string, { duration: number }> }>(
        client,
        'timeline.get',
        {
          timeline_id: outer.timeline_id,
        },
      );
      expect(Object.values(view.nested)[0]?.duration).toBe(50);
    }, 120_000);

    it('reports export progress while it renders, not only at the end', async () => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'slow',
        sequence: { width: 1920, height: 1080, fps: { num: 25, den: 1 } },
      });
      const slow = await ok<{ timeline_id: string }>(client, 'edit.batch', {
        timeline_id,
        preview: 'none',
        ops: [
          { tool: 'clip.add', args: { track_id: 't1', media_id: media.av } },
          { tool: 'clip.add', args: { track_id: 't1', media_id: media.av } },
          { tool: 'clip.add', args: { track_id: 't1', media_id: media.av } },
          { tool: 'filter.add', args: { timeline: true, name: 'blur', params: { radius: 0.02 } } },
        ],
      });
      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: slow.timeline_id,
        preset: 'master_prores_422hq',
        filename: 'progress-check',
      });
      const seen: number[] = [];
      for (;;) {
        const view = await ok<{ status: string; progress?: number }>(client, 'job.get', {
          job_id: started.job_id,
        });
        if (view.progress !== undefined) seen.push(view.progress);
        if (view.status !== 'working') break;
        // Progress part way through is the point; the rest of the render adds nothing.
        if (seen.some((p) => p > 0 && p < 1)) {
          await ok(client, 'job.cancel', { job_id: started.job_id });
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      expect(seen.some((p) => p > 0 && p < 1)).toBe(true);
    }, 240_000);

    it('renders a small review of a range that reads back as video for a model to watch', async () => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'review',
        sequence: { width: 1920, height: 1080, fps: { num: 25, den: 1 } },
      });
      const cut = await ok<{ timeline_id: string }>(client, 'clip.add', {
        timeline_id,
        track_id: 't1',
        media_id: media.av,
        preview: 'none',
      });
      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: cut.timeline_id,
        preset: 'review_h264',
        range: { start: 0, end: 50 },
        filename: 'review-check',
      });
      const done = await waitJob(started.job_id, 120_000);
      if (done.error) throw new Error(`export failed: ${JSON.stringify(done.error)}`);
      expect(done.result).toMatchObject({
        width: 854,
        height: 480,
        fps: 25,
        duration_seconds: 2,
        mime_type: 'video/mp4',
        uri: `video://jobs/${started.job_id}/output`,
      });
      // What a host sees: links to the file, marked for the model, one fetchable over https.
      const got = await client.callTool({ name: 'job.get', arguments: { job_id: started.job_id } });
      const links = (got.content as Array<Record<string, unknown>>).filter(
        (c) => c.type === 'resource_link',
      );
      expect(links.map((l) => String(l.uri).split(':')[0])).toEqual(['video', 'http']);
      for (const l of links) {
        expect(l).toMatchObject({
          mimeType: 'video/mp4',
          annotations: { audience: ['assistant'] },
        });
      }
      const read = await client.readResource({ uri: `video://jobs/${started.job_id}/output` });
      const file = read.contents[0] as { mimeType: string; blob: string };
      expect(file.mimeType).toBe('video/mp4');
      expect(Buffer.from(file.blob, 'base64').subarray(4, 8).toString()).toBe('ftyp');
    }, 120_000);

    it('exports what the preview shows', async () => {
      const pip = await withEdit('clip.set_transform', {
        clip_id: 'c4',
        scale: 0.5,
        x: 0.25,
        y: 0.25,
        rotation: 10,
      });
      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: pip,
        preset: 'web_1080p_h264',
        range: { start: 10, end: 12 },
      });
      const done = (await waitJob(started.job_id)) as { result?: { file?: string } };
      const file = done.result?.file ?? '';
      const still = join(env.dir, 'export-frame.png');
      await ff(['-i', file, '-frames:v', '1', '-vf', 'scale=1280:720', still]);
      const exported = await readFile(still);
      const points: Array<[number, number]> = [
        [320, 180],
        [640, 360],
        [200, 150],
        [900, 600],
      ];
      const fromExport = await Promise.all(
        points.map(async ([x, y]) => colour(await pixel(exported, x, y))),
      );
      expect(fromExport).toEqual(await look(pip, 10, points));
    }, 180_000);
  });

  describe('timing', () => {
    let ramp = '';
    let beep = '';

    /** Source frame shown at each timeline frame: the fixture's luma is 16 + 2·frame. */
    async function sourceFrames(timelineId: string, frames: number[]): Promise<number[]> {
      const res = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames,
        layout: 'single',
        format: 'png',
        long_edge: 320,
      });
      if (res.isError) throw new Error(JSON.stringify(res.structured));
      const images = res.content
        .filter((c) => c.type === 'image')
        .map((c) => Buffer.from(c.data as string, 'base64'));
      const lumas = await Promise.all(images.map((img) => regionStats(img, '64:64:128:58')));
      return lumas.map((l) => Math.round((l.y - 16) / 2));
    }

    /** A timeline holding one clip of the ramp fixture, plus `ops` applied to it (clip c4). */
    async function withClip(
      ops: Array<{ tool: string; args: Record<string, unknown> }>,
      media = ramp,
    ) {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'timing',
        sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
      });
      return (
        await ok<{ timeline_id: string }>(client, 'edit.batch', {
          timeline_id,
          preview: 'none',
          ops: [{ tool: 'clip.add', args: { track_id: 't1', media_id: media } }, ...ops],
        })
      ).timeline_id;
    }

    /** Exports a timeline's sound and returns it as mono 48 kHz samples. */
    async function exportedAudio(timelineId: string): Promise<Int16Array> {
      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: timelineId,
        preset: 'web_1080p_h264',
      });
      const done = (await waitJob(started.job_id)) as { result?: { file: string } };
      if (!done.result) throw new Error(JSON.stringify(done));
      const { stdout } = await exec(
        'ffmpeg',
        ['-v', 'error', '-i', done.result.file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      );
      return new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
    }

    const pitch = (pcm: Int16Array) => {
      let crossings = 0;
      for (let i = 1; i < pcm.length; i++)
        if ((pcm[i - 1] ?? 0) < 0 !== (pcm[i] ?? 0) < 0) crossings++;
      return crossings / 2 / (pcm.length / 48_000);
    };

    beforeAll(async () => {
      const m = env.mediaDir;
      // 100 frames whose luma is 16 + 2·frame, with a steady 440 Hz tone.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'nullsrc=size=320x180:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '4',
        '-vf',
        "geq=lum='16+2*N':cb=128:cr=128",
        '-c:v',
        'libx264',
        '-qp',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        '-shortest',
        join(m, 'ramp.mov'),
      ]);
      // 4 s of silence with a beep from 0.5 to 0.7 s.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-f',
        'lavfi',
        '-i',
        "sine=frequency=1000:sample_rate=48000,volume=enable='not(between(t,0.5,0.7))':volume=0",
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        '-shortest',
        join(m, 'beep.mov'),
      ]);
      ramp = (await importMedia({ path: join(m, 'ramp.mov') })).media_id;
      beep = (await importMedia({ path: join(m, 'beep.mov') })).media_id;
    }, 300_000);

    it('plays twice as fast, in reverse and through a ramp, frame-exact', async () => {
      const fast = await withClip([{ tool: 'clip.set_speed', args: { clip_id: 'c4', rate: 2 } }]);
      expect(await sourceFrames(fast, [0, 10, 40, 49])).toEqual([0, 20, 80, 98]);
      const back = await withClip([
        { tool: 'clip.set_speed', args: { clip_id: 'c4', reverse: true } },
      ]);
      expect(await sourceFrames(back, [0, 10, 99])).toEqual([99, 89, 0]);
      const ramped = await withClip([
        {
          tool: 'clip.set_speed',
          args: {
            clip_id: 'c4',
            curve: [
              { at: 0, rate: 1 },
              { at: 0.5, rate: 3 },
              { at: 1, rate: 1 },
            ],
          },
        },
      ]);
      const seen = await sourceFrames(ramped, [0, 10, 20, 30, 40, 49]);
      // Slow at the ends, fast in the middle: the steps grow, then shrink.
      const steps = seen.slice(1).map((v, i) => v - (seen[i] as number));
      expect(seen[0]).toBe(0);
      expect(steps[2]).toBeGreaterThan(steps[0] as number);
      expect(steps[4]).toBeLessThan(steps[2] as number);
      expect(seen[5]).toBeGreaterThan(95);
    }, 120_000);

    it('holds a freeze frame and carries on after it', async () => {
      const frozen = await withClip([
        { tool: 'clip.freeze', args: { clip_id: 'c4', at_frame: 30, duration_frames: 10 } },
      ]);
      expect(await sourceFrames(frozen, [29, 30, 39, 40, 41])).toEqual([29, 30, 30, 30, 31]);
    }, 60_000);

    it('keeps pitch when sped up unless told not to', async () => {
      const kept = await withClip([{ tool: 'clip.set_speed', args: { clip_id: 'c4', rate: 2 } }]);
      // Zero crossings through AAC read a little high; the point is ~440 against ~880.
      const keptHz = pitch(await exportedAudio(kept));
      expect(keptHz).toBeGreaterThan(400);
      expect(keptHz).toBeLessThan(500);
      const chipmunk = await withClip([
        { tool: 'clip.set_speed', args: { clip_id: 'c4', rate: 2, preserve_pitch: false } },
      ]);
      const chipmunkHz = pitch(await exportedAudio(chipmunk));
      expect(chipmunkHz).toBeGreaterThan(820);
      expect(chipmunkHz).toBeLessThan(960);
    }, 180_000);

    it('plays sound backwards', async () => {
      const back = await withClip(
        [{ tool: 'clip.set_speed', args: { clip_id: 'c4', reverse: true } }],
        beep,
      );
      const pcm = await exportedAudio(back);
      const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      expect(peak).toBeGreaterThan(1000);
      const loud = pcm.findIndex((v) => Math.abs(v) > peak / 2);
      // The beep at 0.5–0.7 s comes out at 3.3–3.5 s.
      expect(loud / 48_000).toBeGreaterThan(3.2);
      expect(loud / 48_000).toBeLessThan(3.4);
    }, 120_000);

    it('extracts a range and closes the gap', async () => {
      const cut = await withClip([
        { tool: 'range.extract', args: { range: { start: 20, end: 60 } } },
      ]);
      expect(await sourceFrames(cut, [19, 20, 59])).toEqual([19, 60, 99]);
    }, 60_000);
  });

  describe('transitions', () => {
    const ids: Record<string, string> = {};

    async function colours(timelineId: string, frame: number, points: Array<[number, number]>) {
      const res = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames: [frame],
        layout: 'single',
        format: 'png',
        long_edge: 1280,
      });
      if (res.isError) throw new Error(JSON.stringify(res.structured));
      const image = Buffer.from((res.content[0]?.data as string) ?? '', 'base64');
      return Promise.all(points.map(async ([x, y]) => pixel(image, x, y)));
    }

    /** Green 0–50 cutting to blue 50–100, with a 20-frame transition centred on the cut. */
    async function cut(kind: string): Promise<string> {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: kind,
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: 1, audio: 0 },
      });
      return (
        await ok<{ timeline_id: string }>(client, 'edit.batch', {
          timeline_id,
          preview: 'none',
          ops: [
            {
              tool: 'clip.add',
              args: {
                track_id: 't1',
                media_id: ids.green,
                av: 'video',
                source: { in: 0, out: 50 },
              },
            },
            {
              tool: 'clip.add',
              args: {
                track_id: 't1',
                media_id: ids.blue,
                av: 'video',
                source: { in: 25, out: 75 },
              },
            },
            {
              tool: 'transition.add',
              args: {
                clip_id: { $ref: 'ops[0].clip_id' },
                kind,
                duration_frames: 20,
                mode: 'handles',
              },
            },
          ],
        })
      ).timeline_id;
    }

    beforeAll(async () => {
      const m = env.mediaDir;
      for (const [name, colour] of [
        ['green2', '0x00ff00'],
        ['blue', '0x0000ff'],
      ] as const) {
        await ff([
          '-f',
          'lavfi',
          '-i',
          `color=c=${colour}:size=1280x720:rate=25`,
          '-t',
          '4',
          '-pix_fmt',
          'yuv420p',
          join(m, `${name}.mp4`),
        ]);
        ids[name === 'green2' ? 'green' : name] = (
          await importMedia({ path: join(m, `${name}.mp4`) })
        ).media_id;
      }
      // A steady tone and silence, each with a picture, for the crossfade.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        '-shortest',
        join(m, 'tone4.mov'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=stereo',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        '-shortest',
        join(m, 'quiet.mov'),
      ]);
      ids.tone = (await importMedia({ path: join(m, 'tone4.mov') })).media_id;
      ids.quiet = (await importMedia({ path: join(m, 'quiet.mov') })).media_id;
    }, 300_000);

    it('dissolves, and leaves both sides untouched outside the transition', async () => {
      const t = await cut('dissolve');
      expect((await colours(t, 39, [[640, 360]])).map(colour)).toEqual(['green']);
      expect((await colours(t, 60, [[640, 360]])).map(colour)).toEqual(['blue']);
      const [[r, g, b] = [0, 0, 0]] = await colours(t, 50, [[640, 360]]);
      expect(r).toBeLessThan(40);
      expect(g).toBeGreaterThan(80);
      expect(g).toBeLessThan(180);
      expect(b).toBeGreaterThan(80);
      expect(b).toBeLessThan(180);
    }, 120_000);

    it('wipes, slides, pushes and opens an iris', async () => {
      const wipe = await cut('wipe_right');
      expect(
        (
          await colours(wipe, 50, [
            [200, 360],
            [1100, 360],
          ])
        ).map(colour),
      ).toEqual(['blue', 'green']);
      const slide = await cut('slide_left');
      // The incoming clip is a little past halfway in from the right.
      expect(
        (
          await colours(slide, 50, [
            [300, 360],
            [1200, 360],
          ])
        ).map(colour),
      ).toEqual(['green', 'blue']);
      const push = await cut('push_up');
      // Green is pushed up and out; blue comes up behind it from the bottom.
      expect(
        (
          await colours(push, 50, [
            [640, 100],
            [640, 650],
          ])
        ).map(colour),
      ).toEqual(['green', 'blue']);
      const iris = await cut('iris');
      expect(
        (
          await colours(iris, 50, [
            [640, 360],
            [40, 40],
          ])
        ).map(colour),
      ).toEqual(['blue', 'green']);
    }, 180_000);

    it('zooms and spins, and renders every kind', async () => {
      // Zoom in: the incoming clip is half faded in at the cut, so the centre is a mix.
      const [[, g1, b1] = [0, 0, 0]] = await colours(await cut('zoom_in'), 50, [[640, 360]]);
      expect(Math.min(g1, b1)).toBeGreaterThan(60);
      // Spin: the incoming clip, still turning and small, covers the centre but not the corner.
      expect(
        (
          await colours(await cut('spin'), 52, [
            [640, 360],
            [20, 20],
          ])
        ).map(colour),
      ).toEqual(['blue', 'green']);
      const kinds = [
        'dissolve',
        'dip_to_black',
        'dip_to_white',
        'wipe_left',
        'wipe_right',
        'wipe_up',
        'wipe_down',
        'slide_left',
        'slide_right',
        'slide_up',
        'slide_down',
        'push_left',
        'push_right',
        'push_up',
        'push_down',
        'zoom_in',
        'zoom_out',
        'iris',
        'spin',
      ];
      for (const kind of kinds) {
        const t = await cut(kind);
        const before = (await colours(t, 35, [[640, 360]])).map(colour);
        const after = (await colours(t, 65, [[640, 360]])).map(colour);
        expect([kind, ...before, ...after]).toEqual([kind, 'green', 'blue']);
      }
    }, 300_000);

    it('dips to white at the cut', async () => {
      const dip = await cut('dip_to_white');
      expect((await colours(dip, 50, [[640, 360]])).map(colour)).toEqual(['white']);
      expect((await colours(dip, 41, [[640, 360]])).map(colour)).toEqual(['green']);
      expect((await colours(dip, 59, [[640, 360]])).map(colour)).toEqual(['blue']);
    }, 120_000);

    it('crossfades linked sound with an equal-power curve', async () => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'crossfade',
        sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
      });
      const faded = await ok<{ timeline_id: string }>(client, 'edit.batch', {
        timeline_id,
        preview: 'none',
        ops: [
          {
            tool: 'clip.add',
            args: { track_id: 't1', media_id: ids.tone, source: { in: 0, out: 50 } },
          },
          {
            tool: 'clip.add',
            args: { track_id: 't1', media_id: ids.quiet, source: { in: 25, out: 75 } },
          },
          {
            tool: 'transition.add',
            args: {
              clip_id: { $ref: 'ops[0].clip_id' },
              kind: 'dissolve',
              duration_frames: 50,
              mode: 'handles',
            },
          },
        ],
      });
      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: faded.timeline_id,
        preset: 'web_1080p_h264',
      });
      const done = (await waitJob(started.job_id)) as { result?: { file: string } };
      if (!done.result) throw new Error(JSON.stringify(done));
      const { stdout } = await exec(
        'ffmpeg',
        ['-v', 'error', '-i', done.result.file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      );
      const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
      const rms = (fromS: number, toS: number) => {
        let sum = 0;
        let n = 0;
        for (let i = Math.round(fromS * 48_000); i < Math.round(toS * 48_000); i++) {
          sum += (pcm[i] ?? 0) ** 2;
          n++;
        }
        return Math.sqrt(sum / n);
      };
      // The fade runs 1–3 s: full before, about 0.71 at the middle, silent after.
      const full = rms(0.2, 0.9);
      expect(rms(1.95, 2.05) / full).toBeGreaterThan(0.55);
      expect(rms(1.95, 2.05) / full).toBeLessThan(0.85);
      expect(rms(2.7, 2.9) / full).toBeLessThan(0.4);
      expect(rms(3.2, 3.8) / full).toBeLessThan(0.02);
    }, 180_000);
  });

  describe('text', () => {
    let green = '';

    async function frame(timelineId: string, f: number): Promise<Buffer> {
      const res = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames: [f],
        layout: 'single',
        format: 'png',
        long_edge: 1280,
      });
      if (res.isError) throw new Error(JSON.stringify(res.structured));
      return Buffer.from((res.content[0]?.data as string) ?? '', 'base64');
    }

    /** A green 2 s timeline with a second video track for text, plus `ops`. */
    async function onGreen(ops: Array<{ tool: string; args: Record<string, unknown> }>) {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'text',
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: 2, audio: 0 },
      });
      return (
        await ok<{ timeline_id: string }>(client, 'edit.batch', {
          timeline_id,
          preview: 'none',
          ops: [
            {
              tool: 'clip.add',
              args: { track_id: 't1', media_id: green, av: 'video', source: { in: 0, out: 50 } },
            },
            ...ops,
          ],
        })
      ).timeline_id;
    }

    beforeAll(async () => {
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x00ff00:size=1280x720:rate=25',
        '-t',
        '3',
        '-pix_fmt',
        'yuv420p',
        join(env.mediaDir, 'green3.mp4'),
      ]);
      green = (await importMedia({ path: join(env.mediaDir, 'green3.mp4') })).media_id;
    }, 120_000);

    it('sets a title on a box over the picture', async () => {
      const t = await onGreen([
        {
          tool: 'title.add',
          args: {
            track_id: 't2',
            text: 'HELLO',
            at_frame: 0,
            duration_frames: 50,
            style: {
              size: 0.2,
              color: '#FFFFFF',
              box: { color: '#000000', padding: 0.4 },
              shadow: null,
            },
          },
        },
      ]);
      const image = await frame(t, 10);
      const across = await Promise.all(
        [440, 520, 600, 680, 760, 840].map(async (x) => colour(await pixel(image, x, 360))),
      );
      expect(across.every((c) => c === 'white' || c === 'black')).toBe(true);
      expect(across).toContain('white');
      expect(colour(await pixel(image, 40, 40))).toBe('green');
    }, 120_000);

    it('shows a title that starts later in the timeline, in frames and in exports', async () => {
      // libass reads the timeline time, so text placed after frame 0 must be timed there too.
      const t = await onGreen([
        {
          tool: 'title.add',
          args: {
            track_id: 't2',
            text: 'LATER',
            at_frame: 30,
            duration_frames: 20,
            style: { size: 0.25, color: '#FFFFFF', shadow: null, outline: null },
          },
        },
      ]);
      const whiteAcross = async (image: Buffer) =>
        (
          await Promise.all(
            [440, 520, 600, 680, 760, 840].map(async (x) => colour(await pixel(image, x, 360))),
          )
        ).includes('white');
      expect(await whiteAcross(await frame(t, 10))).toBe(false);
      expect(await whiteAcross(await frame(t, 30))).toBe(true);
      expect(await whiteAcross(await frame(t, 40))).toBe(true);

      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: t,
        preset: 'master_prores_422hq',
        filename: 'title-later',
      });
      const job = await waitJob(started.job_id);
      const file = join(
        env.exportsDir,
        String((job.result as { file: string }).file)
          .split('/')
          .pop() ?? '',
      );
      const still = join(env.dir, 'title-later.png');
      await ff(['-i', file, '-vf', 'select=eq(n\\,40)', '-frames:v', '1', still]);
      expect(await whiteAcross(await readFile(still))).toBe(true);
    }, 240_000);

    it('imports a rendered export as media and re-frames it to 9:16', async () => {
      const wide = await onGreen([
        {
          tool: 'title.add',
          args: {
            track_id: 't2',
            text: 'WIDE',
            at_frame: 0,
            duration_frames: 50,
            style: { size: 0.25, shadow: null, outline: null },
          },
        },
      ]);
      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: wide,
        preset: 'master_prores_422hq',
        filename: 'wide-master',
      });
      await waitJob(started.job_id);
      const imported = await importMedia({ job_id: started.job_id });
      expect(imported).toMatchObject({ width: 1280, height: 720 });
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'tall',
        sequence: { width: 720, height: 1280, fps: { num: 25, den: 1 } },
        tracks: { video: 1, audio: 0 },
      });
      const tall = await ok<{ timeline_id: string }>(client, 'edit.batch', {
        timeline_id,
        preview: 'none',
        ops: [
          { tool: 'clip.add', args: { track_id: 't1', media_id: imported.media_id, av: 'video' } },
          {
            tool: 'clip.set_transform',
            args: { clip_id: { $ref: 'ops[0].clip_id' }, fit: 'cover' },
          },
        ],
      });
      // Covered: green reaches the top and bottom edges of the tall frame.
      const res = await call(client, 'render.frames', {
        timeline_id: tall.timeline_id,
        frames: [10],
        layout: 'single',
        format: 'png',
        size: 'full',
      });
      const image = Buffer.from((res.content[0]?.data as string) ?? '', 'base64');
      expect(colour(await pixel(image, 20, 20))).toBe('green');
      expect(colour(await pixel(image, 700, 1260))).toBe('green');
    }, 240_000);

    it('shows a graphic at its own pixel size with fit none, in previews and full size', async () => {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'native',
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: 1, audio: 0 },
      });
      // card.png is 400x300 blue; contain would scale it to 960x720 on this 1280x720 frame.
      const placed = await ok<{ timeline_id: string }>(client, 'edit.batch', {
        timeline_id,
        preview: 'none',
        ops: [
          { tool: 'clip.add', args: { track_id: 't1', media_id: media.card, duration_frames: 25 } },
          {
            tool: 'clip.set_transform',
            args: { clip_id: { $ref: 'ops[0].clip_id' }, fit: 'none' },
          },
        ],
      });
      for (const [size, k] of [
        ['full', 1],
        ['preview', 0.5],
      ] as const) {
        const res = await call(client, 'render.frames', {
          timeline_id: placed.timeline_id,
          frames: [5],
          layout: 'single',
          format: 'png',
          size,
        });
        const image = Buffer.from((res.content[0]?.data as string) ?? '', 'base64');
        expect(colour(await pixel(image, 640 * k, 360 * k)), size).toBe('blue');
        expect(colour(await pixel(image, 820 * k, 360 * k)), size).toBe('blue');
        expect(colour(await pixel(image, 860 * k, 360 * k)), size).toBe('black');
        expect(colour(await pixel(image, 640 * k, 530 * k)), size).toBe('black');
      }
    }, 120_000);

    it('moves a caption highlight from word to word in time', async () => {
      const t = await onGreen([
        {
          tool: 'caption.add',
          args: {
            track_id: 't2',
            segments: [
              {
                start_frame: 0,
                end_frame: 50,
                text: 'AAAA BBBB',
                words: [
                  { text: 'AAAA', start_frame: 0, end_frame: 25 },
                  { text: 'BBBB', start_frame: 25, end_frame: 50 },
                ],
              },
            ],
            style: { size: 0.15, outline: null, highlight: { mode: 'word', color: '#FF0000' } },
          },
        },
      ]);
      const redness = async (f: number) => {
        const image = await frame(t, f);
        const band = (x: number) => regionStats(image, `300:80:${x}:540`);
        return { left: (await band(320)).v, right: (await band(660)).v };
      };
      const early = await redness(10);
      const late = await redness(40);
      expect(early.left).toBeGreaterThan(early.right + 10);
      expect(late.right).toBeGreaterThan(late.left + 10);
    }, 120_000);

    it('reads SRT, types a title out, and sets text in an imported font', async () => {
      const srt =
        '1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n2\n00:00:01,000 --> 00:00:02,000\nSecond\n';
      const subs = await ok<{ timeline_id: string; clip_ids: string[] }>(client, 'caption.add', {
        timeline_id: await onGreen([]),
        track_id: 't2',
        srt,
        preview: 'none',
      });
      expect(subs.clip_ids).toHaveLength(2);
      const band = async (t: string, f: number) => regionStats(await frame(t, f), '160:48:560:600');
      // White text over green pulls the band's chroma towards neutral: V rises from green's.
      const plain = await band(await onGreen([]), 10);
      expect((await band(subs.timeline_id, 10)).v).toBeGreaterThan(plain.v + 5);

      const typed = await onGreen([
        {
          tool: 'title.add',
          args: {
            track_id: 't2',
            text: 'TYPEWRITER',
            at_frame: 0,
            duration_frames: 50,
            style: { size: 0.15, reveal: 'typewriter', reveal_frames: 20, shadow: null },
          },
        },
      ]);
      const mid = (f: number) => frame(typed, f).then((img) => regionStats(img, '900:120:190:300'));
      expect((await mid(0)).v).toBeCloseTo(plain.v, 0);
      expect((await mid(30)).v).toBeGreaterThan(plain.v + 5);

      await exec('cp', [
        '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
        join(env.mediaDir, 'serif.ttf'),
      ]);
      const font = await importMedia({ path: join(env.mediaDir, 'serif.ttf') });
      expect(font).toMatchObject({ kind: 'font', font_family: 'DejaVu Serif', status: 'ready' });
      const serif = await onGreen([
        {
          tool: 'title.add',
          args: {
            track_id: 't2',
            text: 'Serif',
            at_frame: 0,
            duration_frames: 50,
            style: { font_media_id: font.media_id },
          },
        },
      ]);
      expect((await mid30(serif)).v).toBeGreaterThan(plain.v + 5);
      async function mid30(t: string) {
        return regionStats(await frame(t, 30), '200:60:540:330');
      }
    }, 180_000);
  });

  describe('audio', () => {
    const ids: Record<string, string> = {};

    /** Exports a timeline and returns its sound as stereo 48 kHz samples. */
    async function exportPcm(
      timelineId: string,
    ): Promise<{ left: Float64Array; right: Float64Array }> {
      const started = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: timelineId,
        preset: 'web_1080p_h264',
        overwrite: true,
      });
      const done = (await waitJob(started.job_id)) as { result?: { file: string } };
      if (!done.result) throw new Error(JSON.stringify(done));
      const { stdout } = await exec(
        'ffmpeg',
        ['-v', 'error', '-i', done.result.file, '-ac', '2', '-ar', '48000', '-f', 's16le', '-'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      );
      const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
      const left = new Float64Array(pcm.length / 2);
      const right = new Float64Array(pcm.length / 2);
      for (let i = 0; i < left.length; i++) {
        left[i] = pcm[2 * i] ?? 0;
        right[i] = pcm[2 * i + 1] ?? 0;
      }
      return { left, right };
    }

    const rms = (x: Float64Array, fromS: number, toS: number) => {
      let sum = 0;
      const a = Math.round(fromS * 48_000);
      const b = Math.min(x.length, Math.round(toS * 48_000));
      for (let i = a; i < b; i++) sum += (x[i] ?? 0) ** 2;
      return Math.sqrt(sum / Math.max(1, b - a));
    };

    /** A timeline with a linked clip of the steady tone (c5 picture, c6 sound) plus `ops`. */
    async function tone(ops: Array<{ tool: string; args: Record<string, unknown> }>) {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'audio',
        sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
        tracks: { video: 1, audio: 2 },
      });
      return (
        await ok<{ timeline_id: string }>(client, 'edit.batch', {
          timeline_id,
          preview: 'none',
          ops: [
            {
              tool: 'clip.add',
              args: { track_id: 't1', media_id: ids.tone, source: { in: 0, out: 75 } },
            },
            ...ops,
          ],
        })
      ).timeline_id;
    }

    beforeAll(async () => {
      const m = env.mediaDir;
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=48000',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        '-shortest',
        join(m, 'steady.mov'),
      ]);
      ids.tone = (await importMedia({ path: join(m, 'steady.mov') })).media_id;
    }, 180_000);

    it('lowers by gain, previews a waveform with loudness, and pans', async () => {
      const plain = await exportPcm(await tone([]));
      const quieter = await tone([]);
      const res = await call(client, 'audio.set_gain', {
        timeline_id: quieter,
        clip_id: 'c5',
        gain_db: -6,
        preview: 'inline',
      });
      expect(res.isError).toBe(false);
      expect(res.content.some((c) => c.type === 'image')).toBe(true);
      const preview = res.structured.preview as { uri: string; loudness: { lufs: number } };
      expect(preview.uri).toMatch(/\/waveform\/0_75\.webp$/);
      expect(preview.loudness.lufs).toBeLessThan(-10);
      const half = await exportPcm(res.structured.timeline_id as string);
      const ratio = rms(half.left, 0.5, 2.5) / rms(plain.left, 0.5, 2.5);
      expect(ratio).toBeGreaterThan(0.45);
      expect(ratio).toBeLessThan(0.56);
      const right = await exportPcm(
        await tone([{ tool: 'audio.set_pan', args: { clip_id: 'c6', pan: 1 } }]),
      );
      expect(rms(right.left, 0.5, 2.5)).toBeLessThan(rms(right.right, 0.5, 2.5) * 0.1);
    }, 240_000);

    it('shifts pitch and cuts highs with audio effects', async () => {
      const crossings = (x: Float64Array) => {
        let n = 0;
        for (let i = 1; i < x.length; i++) if ((x[i - 1] ?? 0) < 0 !== (x[i] ?? 0) < 0) n++;
        return n / 2 / (x.length / 48_000);
      };
      const up = await exportPcm(
        await tone([
          { tool: 'filter.add', args: { clip_id: 'c6', name: 'pitch', params: { semitones: 12 } } },
        ]),
      );
      const hz = crossings(up.left.subarray(24_000, 120_000));
      expect(hz).toBeGreaterThan(600);
      expect(hz).toBeLessThan(720);
      const plain = await exportPcm(await tone([]));
      const muffled = await exportPcm(
        await tone([
          {
            tool: 'filter.add',
            args: { clip_id: 'c6', name: 'lowpass', params: { frequency: 200 } },
          },
        ]),
      );
      expect(rms(muffled.left, 0.5, 2.5)).toBeLessThan(rms(plain.left, 0.5, 2.5) * 0.7);
    }, 240_000);

    it('fades in', async () => {
      const faded = await exportPcm(
        await tone([{ tool: 'audio.fade', args: { clip_id: 'c6', in_frames: 25 } }]),
      );
      expect(rms(faded.left, 0, 0.2)).toBeLessThan(rms(faded.left, 1.5, 2.5) * 0.35);
    }, 120_000);

    it('limits the master to its ceiling, measured by qa.check', async () => {
      const loud = await ok<{ timeline_id: string }>(client, 'audio.set_master', {
        // The tone sits near -18 dBFS, so +20 dB drives it into the limiter.
        timeline_id: await tone([]),
        gain_db: 20,
        limit_db: -1,
        preview: 'none',
      });
      const report = await ok<{ integrated_lufs: number; true_peak_dbtp: number }>(
        client,
        'qa.check',
        { timeline_id: loud.timeline_id },
      );
      expect(report.true_peak_dbtp).toBeLessThanOrEqual(-1);
      expect(report.integrated_lufs).toBeGreaterThan(-10);
    }, 240_000);
  });

  describe('effects', () => {
    const ids: Record<string, string> = {};

    async function rgb(timelineId: string, f: number, x: number, y: number) {
      const res = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames: [f],
        layout: 'single',
        format: 'png',
        long_edge: 1280,
      });
      if (res.isError) throw new Error(JSON.stringify(res.structured));
      return pixel(Buffer.from((res.content[0]?.data as string) ?? '', 'base64'), x, y);
    }

    async function build(ops: Array<{ tool: string; args: Record<string, unknown> }>, tracks = 3) {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'effects',
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: tracks, audio: 0 },
      });
      return (
        await ok<{ timeline_id: string }>(client, 'edit.batch', {
          timeline_id,
          preview: 'none',
          ops,
        })
      ).timeline_id;
    }

    beforeAll(async () => {
      const m = env.mediaDir;
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=0xff0000:size=1280x720:rate=25',
        '-t',
        '3',
        '-pix_fmt',
        'yuv420p',
        join(m, 'red169.mp4'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x00ff00:size=1280x720:rate=25,drawbox=x=480:y=260:w=320:h=200:color=white:t=fill',
        '-t',
        '3',
        '-pix_fmt',
        'yuv420p',
        join(m, 'screen.mp4'),
      ]);
      // A 2×2×2 LUT that sends every colour to blue.
      const cube = ['LUT_3D_SIZE 2', ...Array.from({ length: 8 }, () => '0 0 1')].join('\n');
      await writeFile(join(m, 'blue.cube'), `${cube}\n`);
      ids.red = (await importMedia({ path: join(m, 'red169.mp4') })).media_id;
      ids.screen = (await importMedia({ path: join(m, 'screen.mp4') })).media_id;
      const lut = await importMedia({ path: join(m, 'blue.cube') });
      expect(lut).toMatchObject({ kind: 'lut', status: 'ready' });
      ids.lut = lut.media_id;
    }, 180_000);

    it('greys a clip, keys out a green screen and applies a LUT', async () => {
      const grey = await build([
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: ids.red, av: 'video', source: { in: 0, out: 50 } },
        },
        { tool: 'filter.add', args: { clip_id: { $ref: 'ops[0].clip_id' }, name: 'grayscale' } },
      ]);
      const [r, g, b] = await rgb(grey, 10, 640, 360);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(12);
      const keyed = await build([
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: ids.red, av: 'video', source: { in: 0, out: 50 } },
        },
        {
          tool: 'clip.add',
          args: { track_id: 't2', media_id: ids.screen, av: 'video', source: { in: 0, out: 50 } },
        },
        {
          tool: 'filter.add',
          args: {
            clip_id: { $ref: 'ops[1].clip_id' },
            name: 'chroma_key',
            params: { color: '#00FF00' },
          },
        },
      ]);
      expect(colour(await rgb(keyed, 10, 100, 100))).toBe('red');
      expect(colour(await rgb(keyed, 10, 640, 360))).toBe('white');
      const looked = await build([
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: ids.red, av: 'video', source: { in: 0, out: 50 } },
        },
        {
          tool: 'filter.add',
          args: { clip_id: { $ref: 'ops[0].clip_id' }, name: 'lut', params: { media_id: ids.lut } },
        },
      ]);
      expect(colour(await rgb(looked, 10, 640, 360))).toBe('blue');
    }, 180_000);

    it('changes only what is below an adjustment clip, only while it runs, and the whole timeline', async () => {
      const adjusted = await build([
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: ids.red, av: 'video', source: { in: 0, out: 50 } },
        },
        { tool: 'adjustment.add', args: { track_id: 't2', at_frame: 10, duration_frames: 10 } },
        { tool: 'filter.add', args: { clip_id: { $ref: 'ops[1].clip_id' }, name: 'invert' } },
        {
          tool: 'clip.add',
          args: {
            track_id: 't3',
            media_id: ids.red,
            av: 'video',
            at_frame: 0,
            source: { in: 0, out: 50 },
          },
        },
        {
          tool: 'clip.set_transform',
          args: { clip_id: { $ref: 'ops[3].clip_id' }, scale: 0.25, x: 0.15, y: 0.15 },
        },
      ]);
      // Inside the zone the red below inverts to cyan; the small red clip above stays red.
      expect(colour(await rgb(adjusted, 15, 900, 500))).not.toBe('red');
      expect(colour(await rgb(adjusted, 15, 190, 110))).toBe('red');
      expect(colour(await rgb(adjusted, 30, 900, 500))).toBe('red');
      const inverted = await build([
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: ids.red, av: 'video', source: { in: 0, out: 50 } },
        },
        { tool: 'filter.add', args: { timeline: true, name: 'invert' } },
      ]);
      const [r, g, b] = await rgb(inverted, 30, 640, 360);
      expect(r).toBeLessThan(40);
      expect(g).toBeGreaterThan(200);
      expect(b).toBeGreaterThan(200);
    }, 180_000);
  });

  describe('create', () => {
    const ids: Record<string, string> = {};

    async function made(tool: string, args: Record<string, unknown>) {
      const started = await ok<{ job_id?: string; media_id: string }>(client, tool, args);
      // A recipe made before answers at once with the media, with no job.
      const done = (
        started.job_id
          ? await waitJob(started.job_id, 300_000)
          : { status: 'completed', result: started }
      ) as {
        status: string;
        result?: Record<string, unknown> & { media_id: string };
        error?: { code: string; message: string };
      };
      return { started, done };
    }

    async function create(tool: string, args: Record<string, unknown>) {
      const { done } = await made(tool, args);
      if (!done.result) throw new Error(`${tool} failed: ${JSON.stringify(done.error)}`);
      return done.result;
    }

    /** Red video on V1 and the created media over it on V2, as a 1280×720 frame. */
    async function over(mediaId: string, frame: number, length = 50): Promise<Buffer> {
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'create',
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: 2, audio: 0 },
      });
      const built = await ok<{ timeline_id: string }>(client, 'edit.batch', {
        timeline_id,
        preview: 'none',
        ops: [
          { tool: 'clip.add', args: { track_id: 't1', media_id: ids.red, av: 'video' } },
          {
            tool: 'clip.add',
            args: { track_id: 't2', media_id: mediaId, at_frame: 0, duration_frames: length },
          },
        ],
      });
      const res = await call(client, 'render.frames', {
        timeline_id: built.timeline_id,
        frames: [frame],
        layout: 'single',
        format: 'png',
        long_edge: 1280,
      });
      if (res.isError) throw new Error(JSON.stringify(res.structured));
      const image = res.content.find((c) => c.type === 'image');
      return Buffer.from((image?.data as string) ?? '', 'base64');
    }

    const look = async (image: Buffer, points: Array<[number, number]>) =>
      Promise.all(points.map(async ([x, y]) => colour(await pixel(image, x, y))));

    beforeAll(async () => {
      const m = env.mediaDir;
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=1280x720:rate=25',
        '-t',
        '4',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        join(m, 'red.mp4'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=0x00ff00:size=64x64',
        '-frames:v',
        '1',
        join(m, 'green.png'),
      ]);
      ids.red = (await importMedia({ path: join(m, 'red.mp4') })).media_id;
      ids.green = (await importMedia({ path: join(m, 'green.png') })).media_id;
    }, 120_000);

    it('makes solid and gradient mattes, once per recipe', async () => {
      const gradient = { from: '#000000', to: '#ffffff', angle: 90 };
      const first = await create('create.matte', { gradient, width: 1280, height: 720 });
      expect(first).toMatchObject({ kind: 'image', width: 1280, height: 720, status: 'ready' });
      // Left to right: black at the left edge, white at the right.
      const frame = await over(first.media_id, 0);
      const [left, right] = await Promise.all([pixel(frame, 4, 360), pixel(frame, 1275, 360)]);
      expect(left[0]).toBeLessThan(20);
      expect(right[0]).toBeGreaterThan(235);
      const mid = await pixel(frame, 640, 360);
      expect(mid[0]).toBeGreaterThan(100);
      expect(mid[0]).toBeLessThan(156);

      const again = await made('create.matte', { gradient, width: 1280, height: 720 });
      expect(again.started.media_id).toBe(first.media_id);
      expect(again.done.status).toBe('completed');

      const half = await create('create.matte', { color: '#0000ff80', width: 320, height: 180 });
      expect(half).toMatchObject({ kind: 'image', width: 320, height: 180 });
      const bad = await call(client, 'create.matte', { width: 320, height: 180 });
      expect(bad.isError).toBe(true);
    });

    it('speaks a voiceover with every word timed to the text as written', async () => {
      const text = 'Welcome to cutting floor. Every word here is timed, even 2026.';
      const voice = await create('create.voiceover', { text, voice: 'bm_george' });
      expect(voice).toMatchObject({ kind: 'audio', has_audio: true, status: 'ready' });
      const seconds = voice.duration_seconds as number;
      expect(seconds).toBeGreaterThan(2);
      expect(seconds).toBeLessThan(12);
      const info = await ok<{
        transcript: { words: Array<{ text: string; start: number; end: number }> };
      }>(client, 'media.get', { media_id: voice.media_id, include: ['transcript'] });
      const words = info.transcript.words;
      expect(words.map((w) => w.text)).toEqual(text.split(' '));
      for (let i = 1; i < words.length; i++) {
        expect(words[i]?.start).toBeGreaterThanOrEqual(words[i - 1]?.start ?? 0);
      }
      expect(words.at(-1)?.end).toBeLessThanOrEqual(seconds + 0.25);
      // Speech, not silence: loud enough to hear.
      const { stderr } = await exec('ffmpeg', [
        '-hide_banner',
        '-i',
        (await env.runtime.media.get('local', voice.media_id)).file as string,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      expect(Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1])).toBeGreaterThan(-35);
    }, 300_000);

    it('cuts a person out of a picture and a video (keeping the sound), and any subject out of a picture', async () => {
      const m = env.mediaDir;
      await exec('cp', [join(import.meta.dirname, 'fixtures', 'face.jpg'), join(m, 'cutout.jpg')]);
      await ff([
        '-loop',
        '1',
        '-i',
        join(m, 'cutout.jpg'),
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=48000',
        '-t',
        '1',
        '-r',
        '25',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        join(m, 'cutout.mp4'),
      ]);
      /** Alpha (0–255) at a point of a file's first frame. */
      const alpha = async (file: string, x: number, y: number) => {
        const { stdout } = await exec(
          'ffmpeg',
          [
            '-v',
            'error',
            '-i',
            file,
            '-frames:v',
            '1',
            '-vf',
            `crop=1:1:${x}:${y},format=rgba`,
            '-f',
            'rawvideo',
            '-',
          ],
          { encoding: 'buffer' },
        );
        return stdout[3] ?? -1;
      };
      const file = async (id: string) => (await env.runtime.media.get('local', id)).file as string;

      const picture = await importMedia({ path: join(m, 'cutout.jpg') });
      const still = await create('create.cutout', {
        media_id: picture.media_id,
        subject: 'people',
      });
      expect(still).toMatchObject({ kind: 'image', width: 480, height: 600 });
      const png = await file(still.media_id);
      expect(await alpha(png, 295, 160)).toBeGreaterThan(200); // face
      expect(await alpha(png, 330, 330)).toBeGreaterThan(200); // suit
      expect(await alpha(png, 80, 200)).toBeLessThan(60); // moon
      expect(await alpha(png, 10, 10)).toBeLessThan(60); // sky

      const clip = await importMedia({ path: join(m, 'cutout.mp4') });
      const video = await create('create.cutout', { media_id: clip.media_id });
      expect(video).toMatchObject({ kind: 'video', has_audio: true, width: 480, height: 600 });
      const mov = await file(video.media_id);
      const probe = await ffprobe(mov);
      const v = probe.streams.find((st) => st.codec_type === 'video');
      expect(v?.codec_name).toBe('prores');
      expect(Number(v?.nb_read_packets)).toBe(25);
      expect(await alpha(mov, 295, 160)).toBeGreaterThan(200);
      expect(await alpha(mov, 80, 200)).toBeLessThan(60);

      // Any subject (BiRefNet, the default for pictures): the person, and an object.
      const any = await create('create.cutout', { media_id: picture.media_id });
      expect(any.media_id).not.toBe(still.media_id);
      const anyPng = await file(any.media_id);
      expect(await alpha(anyPng, 295, 160)).toBeGreaterThan(200); // face
      expect(await alpha(anyPng, 330, 330)).toBeGreaterThan(200); // suit
      expect(await alpha(anyPng, 10, 10)).toBeLessThan(60); // sky
      await ff([
        '-f',
        'lavfi',
        '-i',
        "color=c=0x6f8fae:size=640x480,format=rgb24,geq=r='if(lt(hypot(X-320\\,Y-260)\\,130)\\,225\\,111+X/20)':g='if(lt(hypot(X-320\\,Y-260)\\,130)\\,40\\,143)':b='if(lt(hypot(X-320\\,Y-260)\\,130)\\,50\\,174-Y/20)'",
        '-frames:v',
        '1',
        join(m, 'ball.png'),
      ]);
      const ball = await importMedia({ path: join(m, 'ball.png') });
      const cut = await file((await create('create.cutout', { media_id: ball.media_id })).media_id);
      expect(await alpha(cut, 320, 260)).toBeGreaterThan(200); // the ball
      expect(await alpha(cut, 20, 20)).toBeLessThan(60); // the backdrop
      expect(await alpha(cut, 620, 460)).toBeLessThan(60);
    }, 600_000);

    it.skipIf(!chromium)(
      'renders an HTML still with assets, transparent where unpainted',
      async () => {
        const still = await create('create.still', {
          html: `<div style="position:absolute;left:0;top:0;width:640px;height:720px;background:#0000ff"></div>
<img src="assets/g.png" style="position:absolute;right:0;top:0;width:320px;height:180px">`,
          width: 1280,
          height: 720,
          assets: [{ name: 'g.png', media_id: ids.green }],
        });
        expect(still).toMatchObject({ kind: 'image', width: 1280, height: 720 });
        const frame = await over(still.media_id, 10);
        // Blue on the left, the green asset top right, the red video showing through elsewhere.
        expect(
          await look(frame, [
            [300, 400],
            [1200, 60],
            [1000, 500],
          ]),
        ).toEqual(['blue', 'green', 'red']);
      },
      180_000,
    );

    it.skipIf(!chromium)(
      'renders CSS and requestAnimationFrame animation frame-exactly, with alpha, over video',
      async () => {
        const motion = await create('create.motion', {
          html: `<style>@keyframes slide { from { transform: translateX(40px) } to { transform: translateX(1040px) } }</style>
<div style="position:absolute;left:0;top:260px;width:200px;height:200px;background:#ffffff;animation:slide 2s linear forwards"></div>
<canvas id="c" width="1280" height="120" style="position:absolute;left:0;top:560px"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  function draw(now) {
    ctx.clearRect(0, 0, 1280, 120);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(40 + (1000 * Math.min(now, 2000)) / 2000, 0, 200, 120);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>`,
          duration_seconds: 2,
          width: 1280,
          height: 720,
          fps: 25,
        });
        expect(motion).toMatchObject({ kind: 'video', width: 1280, height: 720 });
        expect(motion.duration_seconds as number).toBeCloseTo(2, 1);
        // CSS box at x 40–240 and the canvas box under it at the start; red video elsewhere.
        expect(
          await look(await over(motion.media_id, 0), [
            [140, 360],
            [140, 620],
            [1140, 360],
            [640, 100],
          ]),
        ).toEqual(['white', 'blue', 'red', 'red']);
        // Frame 49 is t = 1.96 s: both boxes at x 1020–1220 (CSS and canvas agree).
        expect(
          await look(await over(motion.media_id, 49), [
            [140, 360],
            [1120, 360],
            [1120, 620],
          ]),
        ).toEqual(['red', 'white', 'blue']);
        // The same recipe renders the same file.
        const again = await made('create.motion', {
          html: '<div style="width:10px;height:10px;background:#fff;animation:x 1s"></div><style>@keyframes x{to{opacity:0}}</style>',
          duration_seconds: 1,
          width: 320,
          height: 180,
        });
        const twice = await made('create.motion', {
          html: '<div style="width:10px;height:10px;background:#fff;animation:x 1s"></div><style>@keyframes x{to{opacity:0}}</style>',
          duration_seconds: 1,
          width: 320,
          height: 180,
        });
        expect(twice.done.result?.media_id).toBe(again.done.result?.media_id);
      },
      180_000,
    );

    it.skipIf(!chromium)(
      'renders across several browsers as one would, even a page that counts its own frames',
      async () => {
        // Three browsers share the 50 frames. The box moves 20 px per animation frame the page
        // has seen, not per second, so a browser that skipped any frame would draw it short.
        const before = process.env.CUTTINGFLOOR_MOTION_WORKERS;
        process.env.CUTTINGFLOOR_MOTION_WORKERS = '3';
        try {
          const motion = await create('create.motion', {
            html: `<canvas id="c" width="1280" height="720"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  let seen = 0;
  function draw() {
    seen += 1;
    ctx.clearRect(0, 0, 1280, 720);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(20 * seen, 300, 20, 120);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>`,
            duration_seconds: 2,
            width: 1280,
            height: 720,
            fps: 25,
          });
          // The page draws once while loading and once more at frame 0, so frame n has seen
          // n + 2 frames: its box spans x 20(n + 2) to 20(n + 3). 37 and 47 are other browsers'.
          for (const n of [0, 37, 47]) {
            const x = 20 * (n + 2);
            expect(
              await look(await over(motion.media_id, n), [
                [x + 10, 360],
                [x - 30, 360],
                [x + 50, 360],
              ]),
            ).toEqual(['white', 'red', 'red']);
          }
        } finally {
          if (before === undefined) delete process.env.CUTTINGFLOOR_MOTION_WORKERS;
          else process.env.CUTTINGFLOOR_MOTION_WORKERS = before;
        }
      },
      180_000,
    );

    it.skipIf(!chromium)(
      'loads bundled libraries from lib/',
      async () => {
        const motion = await create('create.motion', {
          html: `<div id="b" style="position:absolute;left:0;top:0;width:100px;height:100px;background:#fff"></div>
<script src="lib/anime.umd.min.js"></script>
<script>anime.animate('#b', { x: 500, duration: 1000, ease: 'linear' });</script>`,
          duration_seconds: 1,
          width: 640,
          height: 360,
          fps: 10,
        });
        // Timeline frame 20 (0.8 s) shows the graphic's frame 8: anime.js runs on the virtual
        // clock, so its box is at x 400–500 of 640, doubled to fill the 1280 frame.
        const end = await over(motion.media_id, 20);
        expect(
          await look(end, [
            [900, 100],
            [100, 100],
          ]),
        ).toEqual(['white', 'red']);
      },
      180_000,
    );

    it.skipIf(!chromium)(
      'refuses network references and reports broken pages',
      async () => {
        const remote = await call(client, 'create.motion', {
          html: '<img src="https://example.com/logo.png">',
          duration_seconds: 1,
        });
        // Checked in the worker, so it surfaces as the job's error.
        const job = remote.isError
          ? { error: remote.structured }
          : await waitJob((remote.structured as { job_id: string }).job_id);
        expect((job.error as { code: string }).code).toBe('bad_request');

        const broken = await made('create.still', {
          html: '<script>throw new Error("boom")</script><p>still renders</p>',
          width: 320,
          height: 180,
        });
        expect(broken.done.status).toBe('completed');

        const video = await call(client, 'create.still', {
          html: '<img src="assets/v.mp4">',
          assets: [{ name: 'v.mp4', media_id: ids.red }],
        });
        expect(video.isError).toBe(true);
        expect((video.structured as { code: string }).code).toBe('bad_request');
      },
      120_000,
    );
  });

  describe('export formats', () => {
    let timelineId = '';
    let captioned = '';
    let clipMedia = '';

    async function exported(args: Record<string, unknown>) {
      const started = await call(client, args.format ? 'export.timeline' : 'export.video', args);
      if (started.isError)
        return { error: started.structured as { code: string; message: string } };
      const job = await waitJob((started.structured as { job_id: string }).job_id, 600_000);
      if (job.error) return { error: job.error as { code: string; message: string } };
      const result = job.result as Record<string, unknown> & { uri: string; warnings?: string[] };
      const id = (started.structured as { job_id: string }).job_id;
      const dir = env.runtime.ws.ownerDir('local', 'outputs', id);
      const { readdir } = await import('node:fs/promises');
      const [name] = await readdir(dir);
      return { result, file: join(dir, name as string) };
    }

    beforeAll(async () => {
      await ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '3',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        join(env.mediaDir, 'formats.mp4'),
      ]);
      clipMedia = (await importMedia({ path: join(env.mediaDir, 'formats.mp4') })).media_id;
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'formats',
        sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
        tracks: { video: 2, audio: 1 },
      });
      const built = await ok<{ timeline_id: string }>(client, 'edit.batch', {
        timeline_id,
        preview: 'none',
        ops: [
          {
            tool: 'clip.add',
            args: { track_id: 't1', media_id: clipMedia, source: { in: 0, out: 50 } },
          },
          {
            tool: 'clip.add',
            args: { track_id: 't1', media_id: clipMedia, source: { in: 25, out: 75 } },
          },
        ],
      });
      timelineId = built.timeline_id;
      const cap = await ok<{ timeline_id: string }>(client, 'caption.add', {
        timeline_id: timelineId,
        track_id: 't2',
        segments: [
          { start_frame: 0, end_frame: 25, text: 'Hello there' },
          { start_frame: 30, end_frame: 60, text: 'General export' },
        ],
        preview: 'none',
      });
      captioned = cap.timeline_id;
    }, 300_000);

    it('exports GIF, audio, AV1 and overridden presets; refuses misfits', async () => {
      const gif = await exported({ timeline_id: timelineId, preset: 'gif' });
      expect(gif.result?.mime_type).toBe('image/gif');
      const g = (await ffprobe(gif.file as string)).streams[0];
      expect(g).toMatchObject({ codec_name: 'gif', width: 640, height: 360 });
      expect(Number(g?.nb_read_packets)).toBe(60); // 4 s at 15 fps

      const wav = await exported({ timeline_id: timelineId, preset: 'audio_wav_48k' });
      const w = await ffprobe(wav.file as string);
      expect(w.streams.map((st) => st.codec_type)).toEqual(['audio']);
      expect(Number(w.format.duration)).toBeCloseTo(4, 1);
      const mp3 = await exported({ timeline_id: timelineId, preset: 'audio_mp3' });
      expect((await ffprobe(mp3.file as string)).streams[0]?.codec_name).toBe('mp3');

      const av1 = await exported({ timeline_id: timelineId, preset: 'web_1080p_av1' });
      const a = await ffprobe(av1.file as string);
      expect(a.streams.map((st) => st.codec_name).sort()).toEqual(['av1', 'opus']);

      const small = await exported({
        timeline_id: timelineId,
        preset: 'web_1080p_h264',
        overrides: { width: 640, fps: 10, crf: 28 },
        filename: 'small',
      });
      expect(small.result).toMatchObject({ width: 640, height: 360, frames: 40 });
      const sv = (await ffprobe(small.file as string)).streams.find(
        (st) => st.codec_type === 'video',
      );
      expect(sv).toMatchObject({ width: 640, height: 360 });
      expect(Number(sv?.nb_read_packets)).toBe(40);

      const social = await exported({ timeline_id: timelineId, preset: 'social_9x16_h264' });
      expect(social.error?.code).toBe('bad_request');
      const prores = await exported({
        timeline_id: timelineId,
        preset: 'master_prores_422hq',
        overrides: { crf: 10 },
      });
      expect(prores.error?.code).toBe('bad_request');
    }, 900_000);

    it('shows footage bigger than the frame as it is, in previews and exports', async () => {
      // MLT 7.30's qtblend garbles a full-frame source larger than the frame unless it's kept off
      // its shortcut (composite.ts); solid test colours hide that, so this uses colour bars.
      const bars = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
      const at = (w: number, h: number) =>
        bars.map(
          (_, i) => [Math.round(((i + 0.5) * w) / 6), Math.round(h * 0.94)] as [number, number],
        );
      const seen = async (png: Buffer, w: number, h: number) =>
        Promise.all(at(w, h).map(async ([x, y]) => colour(await pixel(png, x, y))));
      const preview = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames: [10],
        layout: 'single',
        format: 'png',
      });
      const small = Buffer.from(
        (preview.content.find((c) => c.type === 'image')?.data as string) ?? '',
        'base64',
      );
      expect(await seen(small, 640, 360)).toEqual(bars);
      const full = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames: [10],
        layout: 'single',
        size: 'full',
        format: 'png',
      });
      const big = Buffer.from(
        (full.content.find((c) => c.type === 'image')?.data as string) ?? '',
        'base64',
      );
      expect(await seen(big, 1280, 720)).toEqual(bars);
      const out = await exported({
        timeline_id: timelineId,
        preset: 'web_1080p_h264',
        overrides: { width: 640 },
        filename: 'bars',
      });
      const frame = join(env.dir, 'bars.png');
      await ff(['-i', out.file as string, '-vf', 'select=eq(n\\,10)', '-frames:v', '1', frame]);
      expect(await seen(await readFile(frame), 640, 360)).toEqual(bars);
    }, 300_000);

    it('renders frames at full size from the original media', async () => {
      const res = await call(client, 'render.frames', {
        timeline_id: timelineId,
        frames: [10],
        layout: 'single',
        size: 'full',
        format: 'png',
      });
      const png = Buffer.from(
        (res.content.find((c) => c.type === 'image')?.data as string) ?? '',
        'base64',
      );
      const file = join(env.dir, 'full.png');
      await writeFile(file, png);
      expect((await ffprobe(file)).streams[0]).toMatchObject({ width: 1280, height: 720 });
    }, 120_000);

    it('hands the edit to other editors and writes captions', async () => {
      const otio = await exported({ timeline_id: captioned, format: 'otio' });
      const doc = JSON.parse(await readFile(otio.file as string, 'utf8'));
      expect(doc.OTIO_SCHEMA).toMatch(/^Timeline/);
      const tracks = doc.tracks.children as Array<{
        kind: string;
        children: Array<{ OTIO_SCHEMA: string }>;
      }>;
      expect(
        tracks
          .find((t) => t.kind === 'Video')
          ?.children.filter((c) => c.OTIO_SCHEMA.startsWith('Clip')).length,
      ).toBe(2);
      expect(JSON.stringify(doc)).toContain('formats.mp4');

      const fcp = await exported({ timeline_id: captioned, format: 'fcpxml' });
      const xml = await readFile(fcp.file as string, 'utf8');
      expect(xml).toMatch(/<fcpxml version="1\.1\d"/);
      expect(xml).toContain('formats.mp4');
      // xmllint-free well-formedness: Node can't parse XML, FFmpeg can't either; check balance.
      expect((xml.match(/<spine>/g) ?? []).length).toBe((xml.match(/<\/spine>/g) ?? []).length);

      const edl = await exported({ timeline_id: captioned, format: 'edl' });
      const text = await readFile(edl.file as string, 'utf8');
      expect(text).toMatch(/^TITLE: /m);
      expect(text).toMatch(/^001 /m);
      expect(text).toMatch(/^002 /m);
      expect(edl.result?.warnings?.join(' ')).toMatch(/track|caption|title/i);

      const srt = await exported({ timeline_id: captioned, format: 'srt' });
      expect(await readFile(srt.file as string, 'utf8')).toMatch(
        /1\n00:00:00,000 --> 00:00:01,000\nHello there/,
      );
      const vtt = await exported({ timeline_id: captioned, format: 'vtt' });
      expect(await readFile(vtt.file as string, 'utf8')).toMatch(/^WEBVTT/);

      const zip = await exported({
        timeline_id: captioned,
        format: 'otio',
        media: 'collect',
        filename: 'bundle',
      });
      expect(zip.result?.mime_type).toBe('application/zip');
      const { stdout } = await exec('zip', ['-sf', zip.file as string]);
      expect(stdout).toContain('bundle.otio');
      expect(stdout).toMatch(/media\/formats\.mp4/);
    }, 600_000);
  });

  describe('code', () => {
    it.skipIf(!chromium)(
      'says when output was cut and when a rendered page kept its placeholder name',
      async () => {
        const started = await ok<{ job_id: string }>(client, 'code.run', {
          timeout_seconds: 300,
          script: `
import { still } from 'cuttingfloor';
// Started together, they render one at a time.
await Promise.all([
  still({ html: '<b>x</b>', width: 64, height: 64 }),
  still({ html: '<b>y</b>', width: 64, height: 64, out: 'out/named.png' }),
]);
console.log('a'.repeat(40000));
console.log('the end');
`,
        });
        const done = await waitJob(started.job_id, 300_000);
        if (done.error) throw new Error(`code.run failed: ${JSON.stringify(done.error)}`);
        const result = done.result as {
          stdout: string;
          outputs: Array<{ name: string; type: string; url: string }>;
          warnings?: string[];
        };
        expect(result.outputs.map((o) => o.name).sort()).toEqual(['named.png', 'still-1.png']);
        expect(result.outputs.map((o) => o.type)).toEqual(['media', 'media']);
        const png = await fetch(result.outputs[0]?.url ?? '');
        expect(png.headers.get('content-type')).toBe('image/png');
        expect(result.stdout).toMatch(/^\[\d+ earlier characters of stdout cut/);
        expect(result.stdout).toMatch(/the end\n$/);
        expect(result.warnings).toEqual([
          expect.stringMatching(/^still-1\.png kept the placeholder/),
        ]);
      },
      300_000,
    );

    it.skipIf(!chromium)(
      'a script renders a graphic, imports it, cuts to the beat and previews; tools refine and export',
      async () => {
        const m = env.mediaDir;
        await ff([
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=640x360:rate=25',
          '-f',
          'lavfi',
          '-i',
          "aevalsrc=exprs='if(lt(mod(t-0.25\\,0.5)\\,0.02)\\,sin(2*PI*1500*t)\\,0)':s=44100:d=8",
          '-t',
          '8',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          join(m, 'beatclip.mp4'),
        ]);
        const clip = await importMedia({ path: join(m, 'beatclip.mp4') });
        const started = await ok<{ job_id: string }>(client, 'code.run', {
          inputs: { media_ids: [clip.media_id] },
          timeout_seconds: 600,
          script: `
import { existsSync } from 'node:fs';
import { cf, importFile, motion } from 'cuttingfloor';
const clip = '${clip.media_id}';
if (!existsSync('in/' + clip + '.mp4')) throw new Error('input missing');
// 1. A graphic, rendered right here, imported as media.
const file = await motion({
  html: '<style>@keyframes s{from{transform:translateX(0)}to{transform:translateX(440px)}}</style><div style="position:absolute;left:0;top:0;width:200px;height:120px;background:#fff;animation:s 2s linear forwards"></div>',
  width: 640, height: 360, fps: 25, duration: 2,
});
const graphic = await importFile(file, 'box.mov');
// 2. Cuts on the beat: one beat of picture from every other beat, back to back.
const { beats } = await cf.media.analyze({ media_id: clip, kind: 'beats' });
const frames = beats.beats.filter((t) => t > 0.5 && t < 7).map((t) => Math.round(t * 25));
const { timeline_id: empty } = await cf.timeline.create({
  name: 'beat cut',
  sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } },
  tracks: { video: 2, audio: 1 },
});
const ops = [];
for (let i = 0; i + 1 < frames.length; i += 2) {
  ops.push({ tool: 'clip.add', args: { track_id: 't1', media_id: clip, source: { in: frames[i], out: frames[i + 1] } } });
}
ops.push({ tool: 'clip.add', args: { track_id: 't2', media_id: graphic.media_id, at_frame: 0 } });
const built = await cf.edit.batch({ timeline_id: empty, ops, preview: 'none' });
// 3. A preview, through the same tools.
const preview = await cf.render.frames({ timeline_id: built.timeline_id, frames: [0], layout: 'single', format: 'png' });
console.log(JSON.stringify({ timeline_id: built.timeline_id, cuts: ops.length - 1, graphic: graphic.media_id, preview: preview.images.length }));
`,
        });
        const done = await waitJob(started.job_id, 600_000);
        if (done.error) throw new Error(`code.run failed: ${JSON.stringify(done.error)}`);
        const result = done.result as { stdout: string; exit_code: number };
        expect(result.exit_code).toBe(0);
        const said = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as {
          timeline_id: string;
          cuts: number;
          graphic: string;
          preview: number;
        };
        expect(said.cuts).toBeGreaterThanOrEqual(5);
        expect(said.preview).toBe(1);
        const view = await ok<{
          tracks: Array<{
            id: string;
            clips: Array<{ id: string; start: number; end: number }>;
          }>;
        }>(client, 'timeline.get', { timeline_id: said.timeline_id });
        const cuts = view.tracks.find((t) => t.id === 't1')?.clips ?? [];
        expect(cuts.length).toBe(said.cuts);
        // Each cut is one beat long (0.5 s at 120 BPM, give or take a frame).
        for (const c of cuts) expect(Math.abs(c.end - c.start - 12.5)).toBeLessThanOrEqual(1.5);

        // The agent takes over with individual tools: tighten the last cut, then export.
        const last = cuts[cuts.length - 1] as { id: string; start: number; end: number };
        const trimmed = await ok<{ timeline_id: string }>(client, 'clip.trim', {
          timeline_id: said.timeline_id,
          clip_id: last.id,
          edge: 'end',
          to_frame: last.end - 3,
          preview: 'none',
        });
        const exp = await ok<{ job_id: string }>(client, 'export.video', {
          timeline_id: trimmed.timeline_id,
          preset: 'web_1080p_h264',
        });
        const exported = await waitJob(exp.job_id, 600_000);
        expect(exported.status).toBe('completed');
        const file = (exported.result as { file?: string; local_path?: string }) ?? {};
        expect(file).toBeTruthy();
        // The graphic is on top at the start: white top-left in the first frame.
        const first = await call(client, 'render.frames', {
          timeline_id: trimmed.timeline_id,
          frames: [0],
          layout: 'single',
          format: 'png',
        });
        const image = Buffer.from(
          (first.content.find((c) => c.type === 'image')?.data as string) ?? '',
          'base64',
        );
        expect(colour(await pixel(image, 20, 20))).toBe('white');
      },
      900_000,
    );
  });

  describe('analysis', () => {
    async function analyze(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const started = await ok<{ job_id: string }>(client, 'media.analyze', args);
      const done = (await waitJob(started.job_id, 600_000)) as {
        result?: Record<string, unknown>;
        error?: unknown;
      };
      if (!done.result) throw new Error(`analyze failed: ${JSON.stringify(done)}`);
      return done.result;
    }

    it('transcribes speech into timed words and captions a clip from them', async () => {
      const m = env.mediaDir;
      await exec('espeak-ng', [
        '-s',
        '140',
        '-w',
        join(m, 'speech-raw.wav'),
        'The quick brown fox jumps over the lazy dog.',
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-i',
        join(m, 'speech-raw.wav'),
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        join(m, 'speech.mp4'),
      ]);
      const media = await importMedia({ path: join(m, 'speech.mp4') });
      const res = await analyze({
        media_id: media.media_id,
        kind: 'transcript',
        model: 'tiny',
        language: 'en',
      });
      const transcript = res.transcript as {
        words: Array<{ text: string; start: number; end: number }>;
      };
      const text = transcript.words.map((w) => w.text.toLowerCase()).join(' ');
      expect(text).toMatch(/quick/);
      expect(text).toMatch(/fox/);
      expect(text).toMatch(/dog/);
      const fox = transcript.words.find((w) => /fox/i.test(w.text));
      const quick = transcript.words.find((w) => /quick/i.test(w.text));
      expect(fox && quick && fox.start > quick.start).toBe(true);
      const info = await ok<{ analyses: { transcript: { words: number } } }>(client, 'media.get', {
        media_id: media.media_id,
      });
      expect(info.analyses.transcript.words).toBe(transcript.words.length);

      // Grouping words into captions is the agent's call: here, three at a time.
      const segments = [];
      for (let i = 0; i < transcript.words.length; i += 3) {
        const group = transcript.words.slice(i, i + 3);
        segments.push({
          start: group[0]?.start ?? 0,
          end: group[group.length - 1]?.end ?? 0,
          text: group.map((w) => w.text).join(' '),
          words: group,
        });
      }
      const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'captions',
        sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
        tracks: { video: 2, audio: 1 },
      });
      const captioned = await ok<{ timeline_id: string; clip_ids: string[] }>(
        client,
        'edit.batch',
        {
          timeline_id,
          preview: 'none',
          ops: [
            { tool: 'clip.add', args: { track_id: 't1', media_id: media.media_id } },
            {
              tool: 'caption.add',
              args: {
                track_id: 't2',
                in_clip: { clip_id: { $ref: 'ops[0].clip_id' }, segments },
              },
            },
          ],
        },
      );
      const view = await ok<{
        tracks: Array<{ clips: Array<{ text?: string; words?: unknown[] }> }>;
      }>(client, 'timeline.get', {
        timeline_id: captioned.timeline_id,
      });
      const captions = view.tracks[1]?.clips ?? [];
      expect(captions.length).toBeGreaterThanOrEqual(3);
      expect(captions.every((c) => (c.words?.length ?? 0) <= 3)).toBe(true);
    }, 600_000);

    it('finds silences and scene cuts with the settings it is given', async () => {
      // Tone, then 1 s of quiet from 2 s, then a quieter tone (-30 dBFS) from 3 s; red, then
      // blue at 2.5 s.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=red:size=320x180:rate=25:d=2.5[a];color=c=blue:size=320x180:rate=25:d=2.5[b];[a][b]concat=n=2:v=1:a=0[out0]',
        '-f',
        'lavfi',
        '-i',
        "aevalsrc=exprs='if(lt(t\\,2)\\,0.5\\,if(lt(t\\,3)\\,0\\,0.0316))*sin(2*PI*440*t)':s=48000:d=5",
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        join(env.mediaDir, 'scenes.mp4'),
      ]);
      const media = await importMedia({ path: join(env.mediaDir, 'scenes.mp4') });
      const loose = await analyze({
        media_id: media.media_id,
        kind: 'silence',
        threshold_db: -50,
        min_seconds: 0.5,
      });
      const strict = await analyze({
        media_id: media.media_id,
        kind: 'silence',
        threshold_db: -20,
        min_seconds: 0.5,
      });
      const spans = (r: Record<string, unknown>) =>
        r.silences as Array<{ start: number; end: number }>;
      // At -50 dB only the gap is quiet; at -20 dB the quieter tone counts too.
      expect(spans(loose)).toHaveLength(1);
      expect(spans(loose)[0]?.start).toBeCloseTo(2, 0);
      expect(spans(strict).at(-1)?.end).toBeGreaterThan(4.5);
      const cuts = await analyze({ media_id: media.media_id, kind: 'scenes', threshold: 10 });
      expect((cuts.scenes as number[]).some((t) => Math.abs(t - 2.5) < 0.1)).toBe(true);
      const missing = await call(client, 'media.analyze', {
        media_id: media.media_id,
        kind: 'silence',
      });
      expect(missing.structured.code).toBe('bad_request');
    }, 300_000);

    it('finds the beat of a click track', async () => {
      await ff([
        '-f',
        'lavfi',
        '-i',
        "aevalsrc=exprs='if(lt(mod(t-0.25\\,0.5)\\,0.02)\\,sin(2*PI*1500*t)\\,0)':s=44100:d=10",
        '-c:a',
        'pcm_s16le',
        join(env.mediaDir, 'clicks.wav'),
      ]);
      const media = await importMedia({ path: join(env.mediaDir, 'clicks.wav') });
      const res = await analyze({ media_id: media.media_id, kind: 'beats' });
      const beats = res.beats as { bpm: number; beats: number[] };
      expect(beats.bpm).toBeGreaterThan(117);
      expect(beats.bpm).toBeLessThan(123);
      const inside = beats.beats.filter((t) => t > 1 && t < 9);
      expect(
        inside.every((t) => Math.abs((t - 0.25) / 0.5 - Math.round((t - 0.25) / 0.5)) * 0.5 < 0.05),
      ).toBe(true);
    }, 300_000);

    it('finds a face, and follows a region as the picture moves', async () => {
      const m = env.mediaDir;
      await exec('cp', [join(import.meta.dirname, 'fixtures', 'face.jpg'), join(m, 'face.jpg')]);
      await ff([
        '-loop',
        '1',
        '-i',
        join(m, 'face.jpg'),
        '-t',
        '2',
        '-r',
        '25',
        '-vf',
        'scale=480:600',
        '-pix_fmt',
        'yuv420p',
        join(m, 'face.mp4'),
      ]);
      const faceMedia = await importMedia({ path: join(m, 'face.mp4') });
      const res = await analyze({ media_id: faceMedia.media_id, kind: 'faces' });
      const faces = res.faces as {
        frames: Array<{ faces: Array<{ x: number; y: number; w: number; h: number }> }>;
      };
      expect(faces.frames.filter((f) => f.faces.length === 1).length).toBeGreaterThan(5);
      const face = faces.frames[0]?.faces[0];
      // The face is in the upper middle of the portrait.
      expect(face && face.x + face.w / 2).toBeGreaterThan(0.35);
      expect(face && face.x + face.w / 2).toBeLessThan(0.75);
      expect(face && face.y + face.h / 2).toBeLessThan(0.5);

      // A 640×360 window panning down the portrait at 60 px/s: content moves up.
      await ff([
        '-loop',
        '1',
        '-i',
        join(m, 'face.jpg'),
        '-t',
        '3',
        '-r',
        '25',
        '-vf',
        'scale=640:800,crop=640:360:0:60+t*60',
        '-pix_fmt',
        'yuv420p',
        join(m, 'pan.mp4'),
      ]);
      const pan = await importMedia({ path: join(m, 'pan.mp4') });
      const tracked = await analyze({
        media_id: pan.media_id,
        kind: 'track',
        region: { at_seconds: 0, x: 0.35, y: 0.25, w: 0.3, h: 0.5 },
        until_seconds: 2,
      });
      const points = (
        tracked.track as { points: Array<{ time: number; y: number; found: boolean }> }
      ).points;
      expect(points.length).toBeGreaterThan(40);
      const first = points[0];
      const later = points.find((p) => p.time >= 1.9);
      // 2 s × 60 px = 120 px of 360 is a third of the frame.
      expect(first && later && first.y - later.y).toBeGreaterThan(0.2);
      expect(first && later && first.y - later.y).toBeLessThan(0.45);
    }, 300_000);
  });

  describe('look', () => {
    const KEY = 'ts-e2e-secret-key';
    let jev: Server;
    const seen: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
    let busy = 1;

    /** Width and height from a JPEG's start-of-frame marker. */
    function jpegSize(b: Buffer): { width: number; height: number; baseline: boolean } {
      for (let i = 2; i < b.length; ) {
        const marker = b[i + 1] as number;
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xc2) {
          return {
            height: b.readUInt16BE(i + 5),
            width: b.readUInt16BE(i + 7),
            baseline: marker === 0xc0,
          };
        }
        i += 2 + len;
      }
      throw new Error('no SOF');
    }

    /** A connection whose server holds the given TypeSafe key, acting as the local owner. */
    async function keyed(key: string): Promise<Client> {
      const server = createServer({
        runtime: env.runtime,
        credentials: new LocalCredentialStore({ TYPESAFE_API_KEY: key }, false),
        owner: () => 'local',
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const c = new Client({ name: 'look', version: '0' });
      await c.connect(b);
      return c;
    }

    beforeAll(async () => {
      // A stand-in for api.typesafe.ai: rate-limits the first call, refuses a wrong key, and
      // answers every question with fixed values so the conversion can be checked exactly.
      jev = createPlainServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        seen.push({ headers: req.headers, body });
        if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end('{}');
        if (busy-- > 0) return res.writeHead(429).end('{}');
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(body.questions as Record<string, { type: string }>)) {
          answers[id] =
            q.type === 'noul'
              ? { type: 'noul', noul: 0.81 }
              : q.type === 'choice'
                ? {
                    type: 'choice',
                    choice: 'bars',
                    probabilities: { bars: 0.9, none: 0.1 },
                    confidence: 0.8,
                  }
                : q.type === 'score'
                  ? {
                      type: 'score',
                      score: 1.5,
                      legend: {},
                      probabilities: { 0: 0, 1: 0.5, 2: 0.5 },
                      confidence: 0.4,
                    }
                  : {
                      type: 'box',
                      box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.6 },
                      confidence: 0.9,
                    };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'jev-1.14.0',
            answers,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
      await new Promise<void>((r) => jev.listen(0, '127.0.0.1', r));
      (env.runtime.config as { typesafeUrl?: string }).typesafeUrl =
        `http://127.0.0.1:${(jev.address() as AddressInfo).port}`;
    });
    afterAll(() => jev?.close());

    it('asks every question of each sampled frame and keeps the answers with the media', async () => {
      await ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-t',
        '3',
        '-pix_fmt',
        'yuv420p',
        join(env.mediaDir, 'look.mp4'),
      ]);
      const media = await importMedia({ path: join(env.mediaDir, 'look.mp4') });
      const c = await keyed(KEY);
      const started = await ok<{ job_id: string }>(c, 'media.analyze', {
        media_id: media.media_id,
        kind: 'look',
        every_seconds: 1,
        with_previous: true,
        questions: {
          bars: { type: 'noul', instructions: 'Does `frame` show colour bars?' },
          kind: {
            type: 'choice',
            instructions: 'What fills `frame`?',
            criteria: { bars: null, none: 'Anything else' },
          },
          busy: {
            type: 'score',
            instructions: 'How busy is `frame`?',
            criteria: ['Empty', 'Some', 'Full'],
          },
          clock: { type: 'box', instructions: 'the moving clock in `frame`' },
        },
      });
      const done = (await waitJob(started.job_id)) as { result?: Record<string, unknown> };
      const result = done.result as {
        frames: number;
        summary: Record<string, unknown>;
        look: { frames: Array<{ time: number; answers: Record<string, unknown> }> };
      };
      // Times 0, 1 and 2: the first is shown only as `previous`, so two frames are asked.
      expect(result.frames).toBe(2);
      expect(result.look.frames.map((f) => f.time)).toEqual([1, 2]);
      expect(result.look.frames[0]?.answers).toEqual({
        bars: { noul: 0.81 },
        kind: { choice: 'bars', probabilities: { bars: 0.9, none: 0.1 }, confidence: 0.8 },
        busy: { score: 1.5, probabilities: { 0: 0, 1: 0.5, 2: 0.5 }, confidence: 0.4 },
        clock: { box: { x: 0.2, y: 0.1, w: 0.4, h: 0.4 }, confidence: 0.9 },
      });
      expect(result.summary).toMatchObject({
        bars: { yes_at: [{ from: 1, to: 2 }] },
        kind: { spans: [{ choice: 'bars', from: 1, to: 2 }] },
      });

      // What Jev received: the key only in its header, the preview header, the pinned model,
      // and baseline JPEGs inside its size limits, named as the questions name them.
      const asked = seen.filter((r) => r.headers.authorization === `Bearer ${KEY}`);
      expect(asked).toHaveLength(3); // one 429, retried
      for (const r of asked) {
        expect(r.headers['typesafe-danger-zone-images']).toBe('true');
        const body = r.body as {
          model: string;
          state: Record<string, unknown>;
          assets: Record<string, { format: string; data_base64: string }>;
        };
        expect(body.model).toBe('jev-1.14.0');
        expect(body.state.seconds_between).toBe(1);
        for (const name of ['frame', 'previous']) {
          const asset = body.assets[body.state[name] as string];
          expect(asset?.format).toBe('jpg');
          const size = jpegSize(Buffer.from(asset?.data_base64 ?? '', 'base64'));
          expect(size).toEqual({ width: 512, height: 288, baseline: true });
        }
      }

      const stored = await ok<{ analyses: Record<string, unknown>; look: { runs: unknown[] } }>(
        c,
        'media.get',
        { media_id: media.media_id, include: ['look'] },
      );
      expect(stored.analyses.look).toEqual({
        runs: 1,
        frames: 2,
        questions: ['bars', 'kind', 'busy', 'clock'],
      });
      expect(stored.look.runs).toHaveLength(1);

      // Two runs at once both stay with the media.
      const ask = { media_id: media.media_id, kind: 'look', at_seconds: [0.5] };
      const twice = await Promise.all(
        [0, 1].map(() =>
          ok<{ job_id: string }>(c, 'media.analyze', {
            ...ask,
            questions: { bars: { type: 'noul', instructions: 'Does `frame` show colour bars?' } },
          }),
        ),
      );
      for (const j of twice) await waitJob(j.job_id);
      const both = await ok<{ look: { runs: Array<{ id: string }> } }>(c, 'media.get', {
        media_id: media.media_id,
        include: ['look'],
      });
      expect(both.look.runs.map((r) => r.id)).toEqual(
        expect.arrayContaining(twice.map((j) => j.job_id)),
      );

      // A daily cap (hosted) refuses the call that would pass it, before any job; 4 used today.
      (env.runtime.config as { judgmentsPerDay?: number }).judgmentsPerDay = 5;
      const capped = await call(c, 'media.analyze', {
        ...ask,
        at_seconds: [0.5, 1.5],
        questions: { bars: { type: 'noul', instructions: 'Does `frame` show colour bars?' } },
      });
      expect(capped.structured).toMatchObject({
        code: 'quota_exceeded',
        detail: { limit: 5, used: 4 },
      });
      delete (env.runtime.config as { judgmentsPerDay?: number }).judgmentsPerDay;

      // A key TypeSafe refuses ends the job with credential_invalid; no key appears anywhere.
      const bad = await keyed('ts-wrong-key');
      const refused = await ok<{ job_id: string }>(bad, 'media.analyze', {
        media_id: media.media_id,
        kind: 'look',
        at_seconds: [0.5],
        questions: { bars: { type: 'noul', instructions: 'Does `frame` show colour bars?' } },
      });
      const failed = await waitJob(refused.job_id);
      expect(JSON.stringify(failed)).toContain('credential_invalid');
      const record = await readFile(
        env.runtime.ws.ownerDir('local', 'media', media.media_id, 'media.json'),
        'utf8',
      );
      for (const text of [
        JSON.stringify(done),
        JSON.stringify(failed),
        JSON.stringify(stored),
        record,
      ]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain('ts-wrong-key');
      }
    }, 300_000);

    it('look shows state entries beside every frame', async () => {
      const media = await importMedia({ path: join(env.mediaDir, 'look.mp4') });
      const c = await keyed(KEY);
      seen.length = 0;
      const reserved = await call(c, 'media.analyze', {
        media_id: media.media_id,
        kind: 'look',
        at_seconds: [0.5],
        state: { frame: 'mine' },
        questions: { bars: { type: 'noul', instructions: 'Does `frame` show colour bars?' } },
      });
      expect(reserved.structured).toMatchObject({ code: 'bad_request' });
      const started = await ok<{ job_id: string }>(c, 'media.analyze', {
        media_id: media.media_id,
        kind: 'look',
        at_seconds: [0.5, 1.5],
        state: {
          script: 'Here are the colour bars',
          terms: { bars: 'vertical stripes of colour' },
        },
        questions: {
          matches: { type: 'noul', instructions: 'Does `frame` show what `script` says?' },
        },
      });
      const done = (await waitJob(started.job_id)) as { result?: { frames: number } };
      expect(done.result?.frames).toBe(2);
      const asked = seen.filter((r) => r.headers.authorization === `Bearer ${KEY}`);
      expect(asked).toHaveLength(2);
      for (const r of asked) {
        const state = r.body.state as Record<string, unknown>;
        expect(state.script).toBe('Here are the colour bars');
        expect(state.terms).toEqual({ bars: 'vertical stripes of colour' });
        expect(typeof state.frame).toBe('string');
      }
      const stored = await ok<{ look: { runs: Array<{ id: string; state?: unknown }> } }>(
        c,
        'media.get',
        { media_id: media.media_id, include: ['look'] },
      );
      expect(stored.look.runs.find((run) => run.id === started.job_id)?.state).toMatchObject({
        script: 'Here are the colour bars',
      });
    }, 120_000);

    it('judge.ask takes an image, a video frame and text in one state', async () => {
      const video = await importMedia({ path: join(env.mediaDir, 'look.mp4') });
      const image = await importMedia({ path: join(env.mediaDir, 'card.png') });
      const c = await keyed(KEY);
      seen.length = 0;
      const got = await ok<{ model: string; answers: Record<string, unknown> }>(c, 'judge.ask', {
        state: {
          card: { media_id: image.media_id },
          shot: { media_id: video.media_id, at_seconds: 1.5 },
          line: 'Here are the colour bars',
        },
        questions: {
          same: { type: 'noul', instructions: 'Does `shot` show what `line` says?' },
          where: { type: 'box', instructions: 'the moving clock in `shot`' },
        },
      });
      expect(got).toEqual({
        model: 'jev-1.14.0',
        answers: {
          same: { noul: 0.81 },
          where: { box: { x: 0.2, y: 0.1, w: 0.4, h: 0.4 }, confidence: 0.9 },
        },
      });
      expect(seen).toHaveLength(1);
      const r = seen[0] as (typeof seen)[number];
      expect(r.headers['typesafe-danger-zone-images']).toBe('true');
      const body = r.body as {
        state: Record<string, string>;
        assets: Record<string, { format: string; data_base64: string }>;
      };
      expect(body.state.line).toBe('Here are the colour bars');
      expect(Object.keys(body.assets)).toHaveLength(2);
      // Pictures go the way look sends frames: baseline JPEG, 512 on the long edge, 280 at least.
      const shot = body.assets[body.state.shot as string];
      expect(jpegSize(Buffer.from(shot?.data_base64 ?? '', 'base64'))).toEqual({
        width: 512,
        height: 288,
        baseline: true,
      });
      const card = body.assets[body.state.card as string];
      expect(jpegSize(Buffer.from(card?.data_base64 ?? '', 'base64'))).toEqual({
        width: 512,
        height: 384,
        baseline: true,
      });

      // A video needs its time, and a time inside it.
      const noTime = await call(c, 'judge.ask', {
        state: { shot: { media_id: video.media_id } },
        questions: { same: { type: 'noul', instructions: 'Is `shot` dark?' } },
      });
      expect(noTime.structured).toMatchObject({ code: 'bad_request' });
      expect(String(noTime.structured.hint)).toContain('at_seconds');
      const late = await call(c, 'judge.ask', {
        state: { shot: { media_id: video.media_id, at_seconds: 30 } },
        questions: { same: { type: 'noul', instructions: 'Is `shot` dark?' } },
      });
      expect(late.structured).toMatchObject({ code: 'bad_request' });
    }, 120_000);

    it.skipIf(!chromium)(
      'judge.ask runs from code.run as cf.judge.ask',
      async () => {
        const c = await keyed(KEY);
        const started = await ok<{ job_id: string }>(c, 'code.run', {
          timeout_seconds: 120,
          script: `
import { cf } from 'cuttingfloor';
const lines = ['So basically the way this works is', 'You click the button'];
const out = [];
for (const line of lines) {
  const { answers } = await cf.judge.ask({
    state: { passage: line },
    questions: { filler: { type: 'noul', instructions: 'Does \`passage\` hold a filler word?' } },
  });
  out.push(answers.filler.noul);
}
console.log(JSON.stringify(out));
`,
        });
        const done = await waitJob(started.job_id, 120_000);
        if (done.error) throw new Error(`code.run failed: ${JSON.stringify(done.error)}`);
        const result = done.result as { stdout: string };
        expect(JSON.parse(result.stdout.trim().split('\n').pop() ?? '[]')).toEqual([0.81, 0.81]);
      },
      180_000,
    );
  });

  it('refuses crafted media', async () => {
    for (const file of ['evil.m3u8', 'fake.mp4']) {
      const started = await ok<{ job_id: string }>(client, 'media.import', {
        source: { path: join(env.mediaDir, file) },
      });
      const done = (await waitJob(started.job_id)) as { error?: { code: string } };
      expect(done.error?.code, file).toBe('bad_request');
    }
    const outside = await call(client, 'media.import', {
      source: { path: join(env.mediaDir, '..', 'data', 'secret.key') },
    });
    expect(outside.structured).toMatchObject({ code: 'path_not_allowed' });
  }, 60_000);

  it('exports H.264 and ProRes, with signed downloads', async () => {
    const started = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'web_1080p_h264',
      idempotency_key: 'web-1',
    });
    const repeat = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'web_1080p_h264',
      idempotency_key: 'web-1',
    });
    expect(repeat.job_id).toBe(started.job_id);
    const done = await waitJob(started.job_id);
    expect(done.status).toBe('completed');
    if (!done.result) throw new Error(`web export: ${JSON.stringify(done)}`);
    const result = done.result as { url: string; file: string; frames: number; bytes: number };
    expect(result.frames).toBe(175);
    const probe = await ffprobe(result.file);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    expect(v).toMatchObject({
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      nb_read_packets: '175',
    });
    expect(a?.codec_name).toBe('aac');
    expect(Math.abs(Number(a?.duration) - 7)).toBeLessThan(0.1);

    const download = await fetch(result.url);
    expect(download.status).toBe(200);
    expect((await download.arrayBuffer()).byteLength).toBe(result.bytes);
    const ranged = await fetch(result.url, { headers: { range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(result.url.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);

    // The default file name is taken now: a second export needs overwrite or a new name.
    const clash = await call(client, 'export.video', {
      timeline_id: timeline,
      preset: 'web_1080p_h264',
    });
    expect(clash.structured).toMatchObject({ code: 'output_exists' });

    const master = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'master_prores_422hq',
      range: { start: 25, end: 75 },
    });
    const masterDone = await waitJob(master.job_id);
    if (!masterDone.result) throw new Error(`master export: ${JSON.stringify(masterDone)}`);
    const mres = masterDone.result as { file: string; frames: number };
    // The output resource answers with the bytes (or the signed URL when large).
    const out = await client.readResource({ uri: `video://jobs/${master.job_id}/output` });
    const first = out.contents[0] as { blob?: string; text?: string; mimeType?: string };
    if (first.blob)
      expect(Buffer.from(first.blob, 'base64').length).toBe((await stat(mres.file)).size);
    else expect(first.text).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/outputs\//);
    const mprobe = await ffprobe(mres.file);
    expect(mprobe.streams.find((s) => s.codec_type === 'video')).toMatchObject({
      codec_name: 'prores',
      width: 1280,
      height: 720,
      nb_read_packets: '50',
    });
    expect(
      (await stat(join(env.exportsDir, mres.file.split('/').pop() ?? ''))).size,
    ).toBeGreaterThan(0);
  }, 300_000);

  it('keeps A/V in sync through a VFR conform', async () => {
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'vfr',
      sequence: { width: 640, height: 480, fps: { num: 30, den: 1 } },
    });
    const added = await ok<{ timeline_id: string }>(client, 'clip.add', {
      timeline_id,
      track_id: 't1',
      media_id: media.vfr,
      preview: 'none',
    });
    const job = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: added.timeline_id,
      preset: 'web_1080p_h264',
    });
    const done = await waitJob(job.job_id);
    const probe = await ffprobe((done.result as { file: string }).file);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    expect(Math.abs(Number(v?.duration) - Number(a?.duration))).toBeLessThan(1 / 30 + 0.03);
  }, 300_000);

  it('keeps a 5-minute VFR clip in sync to the last second', async () => {
    const sync = await importMedia({ path: join(env.mediaDir, 'sync.mov') });
    expect(sync.conform).toContain('vfr');
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'sync',
      sequence: { width: 320, height: 180, fps: { num: 30, den: 1 } },
    });
    const added = await ok<{ timeline_id: string }>(client, 'clip.add', {
      timeline_id,
      track_id: 't1',
      media_id: sync.media_id,
      preview: 'none',
    });
    const job = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: added.timeline_id,
      preset: 'master_prores_422hq',
      range: { start: 290 * 30, end: 300 * 30 - 1 },
    });
    const done = await waitJob(job.job_id, 600_000);
    const file = (done.result as { file: string }).file;
    const exported = await flashAndBeep(file);
    const source = await flashAndBeep(join(env.mediaDir, 'sync.mov'));
    // The flash starts 9 s into the 10 s range, and A/V keep the offset they had in the source.
    expect(Math.abs(exported.flash - 9)).toBeLessThan(0.1);
    const drift = exported.flash - exported.beep - (source.flash - source.beep);
    expect(Math.abs(drift)).toBeLessThanOrEqual(1 / 30 + 0.005);
  }, 600_000);

  it('renders deterministically', async () => {
    const hashes: string[] = [];
    for (const name of ['det-a', 'det-b']) {
      const job = await ok<{ job_id: string }>(client, 'export.video', {
        timeline_id: timeline,
        preset: 'master_prores_422hq',
        range: { start: 20, end: 40 },
        filename: name,
      });
      const file = ((await waitJob(job.job_id)).result as { file: string }).file;
      const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-']);
      hashes.push(
        stdout
          .split('\n')
          .filter((l) => !l.startsWith('#'))
          .join('\n'),
      );
    }
    expect(hashes[0]).toBe(hashes[1]);
  }, 120_000);

  it('ends jobs a dead process left running as interrupted, and retries fresh', async () => {
    const job = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'master_prores_422hq',
      filename: 'restart',
      idempotency_key: 'restart-1',
    });
    // A second process on the same data root starts up while the first still "runs" the job.
    const restarted = new Runtime({ ...env.runtime.config });
    await restarted.start({ sweep: false });
    const view = await ok<{ status: string; error?: { code: string } }>(client, 'job.get', {
      job_id: job.job_id,
    });
    expect(view.status).toBe('failed');
    expect(view.error?.code).toBe('interrupted');
    const retry = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: timeline,
      preset: 'master_prores_422hq',
      filename: 'restart',
      overwrite: true,
      idempotency_key: 'restart-1',
    });
    expect(retry.job_id).not.toBe(job.job_id);
    await env.runtime.jobs.cancel(job.job_id, 'local');
    await waitJob(retry.job_id);
  }, 120_000);

  it('meets the preview latency budget on the simple reference timeline', async () => {
    // Spec §15 "simple" class: 2 tracks, 20 clips, no filters. Budget: p95 still ≤ 1 s,
    // filmstrip ≤ 2 s, with warm caches (CUTTINGFLOOR_BENCH_SCALE relaxes it on slow CI).
    const scale = Number(process.env.CUTTINGFLOOR_BENCH_SCALE ?? 1);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'bench',
      sequence: { width: 1920, height: 1080, fps: { num: 25, den: 1 } },
    });
    const ops = Array.from({ length: 20 }, (_, i) => ({
      tool: 'clip.add',
      args: { track_id: 't1', media_id: media.av, source: { in: i * 5, out: i * 5 + 20 } },
    }));
    let t = (
      await ok<{ timeline_id: string }>(client, 'edit.batch', { timeline_id, ops, preview: 'none' })
    ).timeline_id;
    const stills: number[] = [];
    const strips: number[] = [];
    for (let i = 0; i < 12; i++) {
      const view = await ok<{
        tracks: Array<{ clips: Array<{ id: string; start: number; end: number }> }>;
      }>(client, 'timeline.get', { timeline_id: t });
      const clip = view.tracks[0]?.clips[i % 20];
      if (!clip) throw new Error('no clip');
      let started = Date.now();
      const moved = await call(client, 'clip.set_enabled', {
        timeline_id: t,
        clip_id: clip.id,
        enabled: i % 2 === 0,
        preview: 'inline',
      });
      stills.push(Date.now() - started);
      expect(moved.content.some((c) => c.type === 'image')).toBe(true);
      started = Date.now();
      const trimmed = await call(client, 'clip.trim', {
        timeline_id: moved.structured.timeline_id,
        clip_id: clip.id,
        edge: 'end',
        to_frame: clip.end - 2,
        preview: 'inline',
      });
      strips.push(Date.now() - started);
      t = trimmed.structured.timeline_id as string;
    }
    const p95 = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;
    console.log(`preview p95: still ${p95(stills)} ms, filmstrip ${p95(strips)} ms`);
    expect(p95(stills)).toBeLessThan(1000 * scale);
    expect(p95(strips)).toBeLessThan(2000 * scale);
  }, 180_000);

  it('measures preview latency on the heavy reference timeline', async () => {
    // Spec §21.7 heavy class: 6 video tracks of 20 clips each, every clip transformed with
    // keyframes, half masked, a third blended. Budget: p95 still ≤ 2 s, filmstrip ≤ 4 s.
    const scale = Number(process.env.CUTTINGFLOOR_BENCH_SCALE ?? 1);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'heavy',
      sequence: { width: 1920, height: 1080, fps: { num: 25, den: 1 } },
      tracks: { video: 6, audio: 0 },
    });
    // One batch per track keeps each under edit.batch's 200-op limit.
    let t = timeline_id;
    for (let track = 1; track <= 6; track++) {
      const ops: Array<{ tool: string; args: Record<string, unknown> }> = [];
      for (let i = 0; i < 20; i++) {
        const ref = { $ref: `ops[${ops.length}].clip_id` };
        ops.push({
          tool: 'clip.add',
          args: {
            track_id: `t${track}`,
            media_id: track % 2 ? media.av : media.card,
            av: 'video',
            at_frame: i * 15,
            ...(track % 2 ? { source: { in: i * 3, out: i * 3 + 15 } } : { duration_frames: 15 }),
          },
        });
        ops.push({
          tool: 'clip.set_transform',
          args: {
            clip_id: ref,
            scale: 1 - track * 0.1,
            x: {
              keyframes: [
                { frame: 0, value: 0.3 },
                { frame: 14, value: 0.7, ease: 'cubic_in_out' },
              ],
            },
            rotation: track * 3,
          },
        });
        if (i % 2)
          ops.push({
            tool: 'clip.set_mask',
            args: {
              clip_id: ref,
              mask: {
                shape: 'rectangle',
                width: 0.8,
                height: 0.8,
                corner_radius: 0.2,
                feather: 0.02,
              },
            },
          });
        if (i % 3 === 0)
          ops.push({ tool: 'clip.set_blend', args: { clip_id: ref, mode: 'screen' } });
      }
      t = (
        await ok<{ timeline_id: string }>(client, 'edit.batch', {
          timeline_id: t,
          ops,
          preview: 'none',
        })
      ).timeline_id;
    }
    const stills: number[] = [];
    const strips: number[] = [];
    for (let i = 0; i < 8; i++) {
      const clipId = `c${7 + i * 2}`;
      let started = Date.now();
      const moved = await call(client, 'clip.set_transform', {
        timeline_id: t,
        clip_id: clipId,
        y: 0.4 + i * 0.01,
        preview: 'inline',
      });
      stills.push(Date.now() - started);
      expect(
        moved.content.some((c) => c.type === 'image'),
        JSON.stringify(moved.structured),
      ).toBe(true);
      started = Date.now();
      const animated = await call(client, 'clip.set_animation', {
        timeline_id: moved.structured.timeline_id,
        clip_id: clipId,
        in: { name: 'pop', duration_frames: 6 },
        preview: 'inline',
      });
      strips.push(Date.now() - started);
      t = animated.structured.timeline_id as string;
    }
    const p95 = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;
    console.log(`heavy preview p95: still ${p95(stills)} ms, filmstrip ${p95(strips)} ms`);
    expect(p95(stills)).toBeLessThan(2000 * scale);
    expect(p95(strips)).toBeLessThan(4000 * scale);
  }, 300_000);

  it('cancels a running job', async () => {
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'long',
      sequence: { width: 1920, height: 1080, fps: { num: 25, den: 1 } },
    });
    let t = timeline_id;
    for (let i = 0; i < 6; i++) {
      t = (
        await ok<{ timeline_id: string }>(client, 'clip.add', {
          timeline_id: t,
          track_id: 't1',
          media_id: media.av,
          preview: 'none',
        })
      ).timeline_id;
    }
    const job = await ok<{ job_id: string }>(client, 'export.video', {
      timeline_id: t,
      preset: 'master_prores_422hq',
    });
    await new Promise((r) => setTimeout(r, 300));
    const cancelled = await ok<{ status: string }>(client, 'job.cancel', { job_id: job.job_id });
    expect(cancelled.status).toBe('cancelled');
  }, 120_000);

  it('returns tasks to 2026-07-28 clients that opt in, and job handles otherwise', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    };
    const args = {
      timeline_id: timeline,
      preset: 'web_1080p_h264',
      range: { start: 0, end: 25 },
      filename: 'task-export',
    };
    const task = (await rpc('tools/call', { name: 'export.video', arguments: args, _meta: meta }))
      .result as { resultType: string; taskId: string; status: string; pollIntervalMs: number };
    expect(task).toMatchObject({ resultType: 'task', status: 'working', pollIntervalMs: 1000 });
    let state: Record<string, unknown> = {};
    for (let i = 0; i < 600; i++) {
      state = (await rpc('tasks/get', { taskId: task.taskId, _meta: meta })).result as Record<
        string,
        unknown
      >;
      if (state.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(state).toMatchObject({ status: 'completed', resultType: 'complete' });
    expect(
      (state.result as { structuredContent: { frames: number } }).structuredContent.frames,
    ).toBe(25);
    // The same record answers job.get from another connection, and stays owner-scoped.
    expect((await ok<{ status: string }>(client, 'job.get', { job_id: task.taskId })).status).toBe(
      'completed',
    );
    // Without the opt-in, the same call answers with a job handle.
    const plain = (
      await rpc('tools/call', {
        name: 'export.video',
        arguments: { ...args, filename: 'job-export' },
        _meta: { ...meta, 'io.modelcontextprotocol/clientCapabilities': {} },
      })
    ).result as { structuredContent: { job_id: string } };
    expect(plain.structuredContent.job_id).toMatch(/^j_/);
    await waitJob(plain.structuredContent.job_id);
  }, 120_000);

  it('settles a task through the official ext-tasks client', async () => {
    const modern = new Client({ name: 'ext-tasks', version: '0' }, {
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    } as never);
    await modern.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const session = createTaskSessionFromClient(modern, {
      endpointId: 'cuttingfloor-e2e',
      rawDispatch: async (request) => {
        // ext-tasks hands over the request body; the transport frames it as JSON-RPC.
        const body = request as Record<string, unknown>;
        return (await rpcRaw({ jsonrpc: '2.0', id: ++rpcId, ...body })) as never;
      },
      v2RequestFraming: {
        protocolVersion: '2026-07-28',
        clientInfo: { name: 'ext-tasks', version: '0' },
        clientCapabilities: {},
      },
    });
    try {
      const execution = await session.callTool('export.video', {
        timeline_id: timeline,
        preset: 'master_prores_422hq',
        range: { start: 0, end: 10 },
        filename: 'ext-tasks-export',
      });
      const { outcome } = await execution.settle();
      const result = resultFromTaskOutcome(outcome) as { structuredContent?: { frames: number } };
      expect(result.structuredContent?.frames).toBe(10);
    } finally {
      await session.close();
      await modern.close();
    }
  }, 120_000);
});

let rpcId = 0;

/** One raw JSON-RPC request over Streamable HTTP (JSON or SSE response). */
async function rpcRaw(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': String(message.method),
      ...mcpName(message.params as Record<string, unknown> | undefined),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)) as Record<string, unknown>);
    const reply = events.find((e) => e.id === message.id);
    if (!reply) throw new Error(`no reply in stream: ${text}`);
    return reply;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** The Mcp-Name header mirrors params.name, params.uri or params.taskId. */
function mcpName(params: Record<string, unknown> | undefined): Record<string, string> {
  const value = params?.name ?? params?.uri ?? params?.taskId;
  return typeof value === 'string' ? { 'mcp-name': value } : {};
}

async function rpc(method: string, params: Record<string, unknown>) {
  const reply = await rpcRaw({ jsonrpc: '2.0', id: ++rpcId, method, params });
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply as { result: unknown };
}
