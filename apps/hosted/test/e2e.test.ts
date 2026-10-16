import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createTaskSessionFromClient,
  resultFromTaskOutcome,
} from '@modelcontextprotocol/ext-tasks/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';

interface TestEnv {
  runtime: Runtime;
  dir: string;
  mediaDir: string;
  exportsDir: string;
}

async function testRuntime(): Promise<TestEnv> {
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
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.structured)}`);
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
  const started = await ok<{ job_id: string; media_id: string }>(client, 'media.import', {
    source,
  });
  expect(started.media_id).toMatch(/^m_/);
  const done = await waitJob(started.job_id);
  if (done.status !== 'completed' || done.error)
    throw new Error(`import failed: ${JSON.stringify(done.error)}`);
  return done.result as Record<string, unknown> & { media_id: string };
}

const media: Record<string, string> = {};

describe.skipIf(!engines)('end to end with FFmpeg and MLT', () => {
  beforeAll(async () => {
    env = await testRuntime();
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

  it('runs the exact QA checks', async () => {
    const report = await ok<{
      passed: boolean;
      checks: Array<{
        check: string;
        status: string;
        findings: Array<{ start: number; end: number }>;
      }>;
      measured: { frames: number };
    }>(client, 'qa.check', { timeline_id: timeline });
    expect(report.passed).toBe(false);
    const gaps = report.checks.find((c) => c.check === 'gaps');
    expect(gaps?.findings).toEqual([{ start: 100, end: 125, detail: 'no picture' }]);
    expect(report.checks.find((c) => c.check === 'frame_count')?.status).toBe('pass');
    expect(report.measured.frames).toBe(175);

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
      checks: Array<{
        check: string;
        status: string;
        findings: Array<{ start: number; end: number }>;
      }>;
    }>(client, 'qa.check', { timeline_id: planted.timeline_id, loudness_target_lufs: -14 });
    const by = (name: string) => qa.checks.find((c) => c.check === name);
    expect(by('gaps')?.findings).toEqual([{ start: 100, end: 125, detail: 'no picture' }]);
    const blackSpan = by('black_frames')?.findings[0];
    expect(blackSpan?.start).toBeGreaterThanOrEqual(49);
    expect(blackSpan?.end).toBeLessThanOrEqual(101);
    const quiet = by('silence')?.findings[0];
    expect(quiet?.start).toBeLessThanOrEqual(51);
    expect(quiet?.end).toBeGreaterThanOrEqual(124);
    expect(by('loudness')?.status).toBe('warn');
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
    expect(view.status).toBe('completed');
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
