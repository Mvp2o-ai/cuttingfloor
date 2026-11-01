import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { createServer, Runtime } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Picture over time and sound, end to end through the MCP client: in-between frames on
// clip.set_speed, lens correction, directional blur, channel routing and per-channel levels.
// Sources are FFmpeg's own test patterns and tones, so what each frame should hold is known.

const exec = promisify(execFile);
const engines = await Promise.all([exec('melt', ['--version']), exec('ffmpeg', ['-version'])]).then(
  () => true,
  () => false,
);
if (!engines && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg/melt are missing');
}

// Present in the image's test stage: espeak-ng speaks the dereverb fixture, and the upscale
// models come from the Dockerfile's picture-models stage.
const espeak = await exec('espeak-ng', ['--version']).then(
  () => true,
  () => false,
);
const UPSCALE_MODELS =
  process.env.CUTTINGFLOOR_UPSCALE_MODELS ?? '/usr/share/cuttingfloor/models/upscale';
const upscaleModels = await access(join(UPSCALE_MODELS, 'realesr-general-x4v3-medium.onnx')).then(
  () => true,
  () => false,
);
if (engines && process.env.CUTTINGFLOOR_REQUIRE_ENGINES && (!espeak || !upscaleModels)) {
  throw new Error(
    'CUTTINGFLOOR_REQUIRE_ENGINES is set but espeak-ng or the upscale models are missing',
  );
}

const ff = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);

type Op = { tool: string; args: Record<string, unknown> };

describe.skipIf(!engines)('picture and sound', () => {
  let runtime: Runtime;
  let client: Client;
  let dir: string;
  let mediaDir: string;

  async function call(name: string, args: Record<string, unknown>) {
    return (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text?: string; data?: string }>;
    };
  }

  async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
    const res = await call(name, args);
    if (res.isError) {
      throw new Error(`${name} failed: ${res.content.map((c) => c.text ?? '').join(' ')}`);
    }
    return res.structuredContent as T;
  }

  async function job<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
    const started = await ok<{ job_id?: string } & Record<string, unknown>>(name, args);
    if (!started.job_id || !('status_uri' in started)) return started as T;
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
    return (await job<{ media_id: string }>('media.import', { source: { path: file } })).media_id;
  }

  /** A 320x180 timeline at `fps` with the media's clip and `ops` after it. */
  async function timeline(
    media: string,
    fps: number,
    ops: Op[],
    add: Record<string, unknown> = {},
  ): Promise<{ timeline_id: string; warnings: string[] }> {
    const { timeline_id } = await ok<{ timeline_id: string }>('timeline.create', {
      name: 'test',
      sequence: { width: 320, height: 180, fps: { num: fps, den: 1 } },
      tracks: { video: 1, audio: 1 },
    });
    return ok('edit.batch', {
      timeline_id,
      preview: 'none',
      ops: [{ tool: 'clip.add', args: { track_id: 't1', media_id: media, ...add } }, ...ops],
    });
  }

  /** One rendered frame as 8-bit grey pixels, 320x180. */
  async function grey(timelineId: string, frame: number, size: 'preview' | 'full' = 'full') {
    const res = await call('render.frames', {
      timeline_id: timelineId,
      frames: [frame],
      layout: 'single',
      format: 'png',
      size,
      long_edge: 320,
    });
    if (res.isError) throw new Error(res.content.map((c) => c.text ?? '').join(' '));
    const png = join(dir, `f-${Math.random().toString(36).slice(2)}.png`);
    await writeFile(png, Buffer.from(res.content[0]?.data ?? '', 'base64'));
    if (process.env.CUTTINGFLOOR_KEEP_FRAMES) {
      await exec('cp', [
        png,
        join(process.env.CUTTINGFLOOR_KEEP_FRAMES, `${timelineId}-${frame}.png`),
      ]);
    }
    const { stdout } = await exec(
      'ffmpeg',
      ['-v', 'error', '-i', png, '-vf', 'scale=320:180,format=gray', '-f', 'rawvideo', '-'],
      { encoding: 'buffer' },
    );
    return new Uint8Array(stdout);
  }

  const at = (img: Uint8Array, x: number, y: number) => img[y * 320 + x] ?? -1;

  /** Brightest minus darkest along row 20 (crossing the upright lines) and column 20 (the level ones). */
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const rowContrast = (img: Uint8Array) =>
    spread(Array.from({ length: 300 }, (_, i) => at(img, i + 10, 20)));
  const columnContrast = (img: Uint8Array) =>
    spread(Array.from({ length: 160 }, (_, i) => at(img, 20, i + 10)));

  /** The bright box in a row band: its centre x, its brightest pixel and how many columns it lights. */
  function box(img: Uint8Array) {
    let sum = 0;
    let weight = 0;
    let peak = 0;
    let lit = 0;
    for (let x = 0; x < 320; x++) {
      let col = 0;
      for (let y = 80; y < 100; y++) col = Math.max(col, at(img, x, y));
      if (col > 40) {
        sum += x * col;
        weight += col;
        lit++;
      }
      peak = Math.max(peak, col);
    }
    return { x: weight ? sum / weight : -1, peak, lit };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cf-picture-sound-'));
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
    client = new Client({ name: 'picture-sound-test', version: '0.0.0' });
    await client.connect(b);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await runtime?.stop();
  });

  describe('in-between frames', () => {
    let moving: string;
    let pan: string;
    let clock: string;

    beforeAll(async () => {
      // A 10 fps clip: a white box 10 px wide moving right 20 px each frame over black.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=10',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:size=10x40:rate=10',
        '-filter_complex',
        "[0][1]overlay=x='t*200-400':y=70:shortest=1",
        '-t',
        '30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '10',
        join(mediaDir, 'moving.mp4'),
      ]);
      moving = await importFile(join(mediaDir, 'moving.mp4'));
      // A 10 fps pan across a still test card: the picture moves 8 px left each frame.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x180:rate=10',
        '-vf',
        "trim=end_frame=1,loop=loop=-1:size=1,crop=320:180:'mod(n*8,960)':0",
        '-t',
        '30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '10',
        join(mediaDir, 'pan.mp4'),
      ]);
      pan = await importFile(join(mediaDir, 'pan.mp4'));
      // A clock: a 10 fps box that moves 1 px right each frame, so where it sits says which
      // source frame (or moment between two) a frame shows.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=10',
        '-f',
        'lavfi',
        '-i',
        'color=c=white:size=10x40:rate=10',
        '-filter_complex',
        "[0][1]overlay=x='t*10':y=70:shortest=1",
        '-t',
        '30',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '10',
        join(mediaDir, 'clock.mp4'),
      ]);
      clock = await importFile(join(mediaDir, 'clock.mp4'));
    }, 120_000);

    /** How far `img` has moved left of `ref`, in whole pixels, and how well it then matches. */
    function shift(img: Uint8Array, ref: Uint8Array) {
      let best = { px: -1, error: Number.POSITIVE_INFINITY };
      for (let px = 0; px <= 24; px++) {
        let sum = 0;
        let n = 0;
        for (let y = 20; y < 160; y += 2)
          for (let x = 20; x < 280; x++) {
            sum += Math.abs(at(img, x, y) - at(ref, x + px, y));
            n++;
          }
        if (sum / n < best.error) best = { px, error: sum / n };
      }
      return best;
    }

    // From source frame 22 (2.2 s) the box sits at x = 40 + 20 k; at half speed in a 30 fps
    // sequence each source frame lasts 6 timeline frames.
    const slow = (interpolate?: string): Op => ({
      tool: 'clip.set_speed',
      args: {
        clip_id: { $ref: 'ops[0].clip_id' },
        rate: 0.5,
        ...(interpolate ? { interpolate } : {}),
      },
    });
    const source = { source: { in: 66, out: 114 }, av: 'video' };

    it('says a slowed clip repeats its frames, and repeats them', async () => {
      const t = await timeline(moving, 30, [slow()], source);
      expect(t.warnings.join(' ')).toMatch(/c\d+ plays its 10 fps source at 0.5x: 5 new frames/);
      expect(t.warnings.join(' ')).toMatch(/each frame shows about 6 times/);
      const first = box(await grey(t.timeline_id, 0));
      const third = box(await grey(t.timeline_id, 3));
      expect(Math.abs(first.x - 45)).toBeLessThan(2);
      expect(third.x).toBeCloseTo(first.x, 0);
    }, 180_000);

    it('blends neighbouring frames', async () => {
      const t = await timeline(moving, 30, [slow('blend')], source);
      expect(t.warnings.join(' ')).not.toMatch(/repeats|shows about/);
      const view = await ok<{ tracks: Array<{ clips: Array<{ speed?: unknown }> }> }>(
        'timeline.get',
        { timeline_id: t.timeline_id },
      );
      expect(view.tracks[0]?.clips[0]?.speed).toMatchObject({ rate: 0.5, interpolate: 'blend' });
      const first = box(await grey(t.timeline_id, 0));
      const half = box(await grey(t.timeline_id, 3));
      // The first frame is the source frame itself; halfway two half-bright boxes 20 px apart.
      expect(Math.abs(first.x - 45)).toBeLessThan(2);
      expect(first.peak).toBeGreaterThan(200);
      expect(half.x - first.x).toBeGreaterThan(7);
      expect(half.x - first.x).toBeLessThan(13);
      expect(half.peak).toBeLessThan(190);
      expect(half.lit).toBeGreaterThan(first.lit + 6);
    }, 180_000);

    it('makes new frames from the motion, at every rate and from a copy in step with the source', async () => {
      const t = await timeline(pan, 30, [slow('motion')], source);
      const blended = await timeline(pan, 30, [slow('blend')], source);
      for (const size of ['preview', 'full'] as const) {
        const ref = await grey(t.timeline_id, 0, size);
        const moved = await Promise.all(
          [2, 3, 4, 6].map(async (f) => shift(await grey(t.timeline_id, f, size), ref)),
        );
        // A source frame moves 8 px; each of the 6 timeline frames it lasts moves a sixth of it.
        const expected = [8 / 3, 4, 16 / 3, 8];
        for (const [i, m] of moved.entries()) {
          expect(Math.abs(m.px - (expected[i] ?? 0))).toBeLessThanOrEqual(1);
        }
        expect(moved[1]?.px).toBe(4);
        expect(moved[3]?.px).toBe(8);
        // A new frame, sharp where it sits, unlike a blend of two.
        const blend = shift(await grey(blended.timeline_id, 3, size), ref);
        expect(moved[1]?.error ?? 99).toBeLessThan(blend.error / 2);
      }
      // The first frame is the source frame the clip starts on.
      const plain = await timeline(pan, 30, [], source);
      expect(shift(await grey(t.timeline_id, 0), await grey(plain.timeline_id, 0)).px).toBe(0);
      // A low frame rate smooths at rate 1 too.
      const steady = await timeline(
        pan,
        30,
        [
          {
            tool: 'clip.set_speed',
            args: { clip_id: { $ref: 'ops[0].clip_id' }, interpolate: 'motion' },
          },
        ],
        source,
      );
      const first = await grey(steady.timeline_id, 0);
      // A third of the way to the next source frame: 8/3 px.
      const next = shift(await grey(steady.timeline_id, 1), first).px;
      expect(next).toBeGreaterThanOrEqual(2);
      expect(next).toBeLessThanOrEqual(3);
      // It is exported too.
      const exported = await job<{ frames: number }>('export.video', {
        timeline_id: t.timeline_id,
        preset: 'review_h264',
      });
      expect(exported.frames).toBe(96);
    }, 600_000);

    it('shows the right source moment to the last frame of a slowed clip from mid-file', async () => {
      // Source 20 to 21 s (frames 200 to 210 of the clock), so the copy starts well inside the
      // file; the plain clip (frames repeated) is the reference for where each moment sits.
      const mid = { source: { in: 600, out: 630 }, av: 'video' };
      const speeds: Array<Record<string, unknown>> = [
        { rate: 0.5 },
        { rate: 0.25 },
        {
          curve: [
            { at: 0, rate: 1 },
            { at: 0.5, rate: 0.25 },
            { at: 1, rate: 0.5 },
          ],
        },
      ];
      for (const speed of speeds) {
        const made = async (interpolate?: string) =>
          timeline(
            clock,
            30,
            [
              {
                tool: 'clip.set_speed',
                args: {
                  clip_id: { $ref: 'ops[0].clip_id' },
                  ...speed,
                  ...(interpolate ? { interpolate } : {}),
                },
              },
            ],
            mid,
          );
        const plain = await made();
        const view = await ok<{ tracks: Array<{ clips: Array<{ end: number }> }> }>(
          'timeline.get',
          { timeline_id: plain.timeline_id },
        );
        const length = view.tracks[0]?.clips[0]?.end ?? 0;
        expect(length).toBeGreaterThan(40);
        const frames = [0, Math.floor(length / 2), length - 3, length - 1];
        const reference = await Promise.all(
          frames.map(async (f) => box(await grey(plain.timeline_id, f))),
        );
        // The repeated frames are the source frames themselves: 200 + k px, plus half the box.
        expect(Math.abs((reference[0]?.x ?? 0) - 204.5)).toBeLessThan(1);
        expect(reference[3]?.x ?? 0).toBeGreaterThan(212);
        for (const mode of ['blend', 'motion']) {
          const smooth = await made(mode);
          for (const size of ['preview', 'full'] as const) {
            for (const [i, f] of frames.entries()) {
              const b = box(await grey(smooth.timeline_id, f, size));
              // Within a source frame (1 px) of the plain clip: the same moment, made smooth.
              expect(
                Math.abs(b.x - (reference[i]?.x ?? 0)),
                `${JSON.stringify(speed)} ${mode} ${size} frame ${f}`,
              ).toBeLessThan(1.6);
              expect(b.peak).toBeGreaterThan(100);
            }
          }
        }
      }
    }, 900_000);

    it('refuses more in-between frames than one clip may have', async () => {
      const t = await timeline(moving, 30, [], { av: 'video' });
      const view = await ok<{ tracks: Array<{ clips: Array<{ id: string }> }> }>('timeline.get', {
        timeline_id: t.timeline_id,
      });
      const res = await call('clip.set_speed', {
        timeline_id: t.timeline_id,
        clip_id: view.tracks[0]?.clips[0]?.id,
        rate: 0.1,
        interpolate: 'motion',
        preview: 'none',
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toMatch(/limit_exceeded|in-between frames/);
    }, 60_000);
  });

  describe('lens and motion', () => {
    let grid: string;

    beforeAll(async () => {
      // White lines every 40 px on black, and a white vertical bar in the middle.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-vf',
        'drawgrid=w=40:h=40:t=2:c=white,drawbox=x=158:y=0:w=4:h=180:color=white:t=fill',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '10',
        join(mediaDir, 'grid.mp4'),
      ]);
      grid = await importFile(join(mediaDir, 'grid.mp4'));
    }, 120_000);

    const effect = (name: string, params: Record<string, unknown>): Op => ({
      tool: 'filter.add',
      args: { clip_id: { $ref: 'ops[0].clip_id' }, name, params },
    });

    it('bends lines about the centre and leaves the centre where it is', async () => {
      const plain = await grey((await timeline(grid, 25, [])).timeline_id, 5);
      const pincushion = await grey(
        (await timeline(grid, 25, [effect('lens_correction', { k1: 0.4 })])).timeline_id,
        5,
      );
      const barrel = await grey(
        (await timeline(grid, 25, [effect('lens_correction', { k1: -0.4 })])).timeline_id,
        5,
      );
      // The centre line stays put.
      expect(at(plain, 160, 90)).toBeGreaterThan(200);
      expect(at(pincushion, 160, 90)).toBeGreaterThan(200);
      expect(at(barrel, 160, 90)).toBeGreaterThan(200);
      // Positive k1 draws the picture in from outside it: the corners are empty.
      expect(at(pincushion, 2, 2)).toBeLessThan(20);
      // Negative k1 pushes it out: the corners are picture (grid lines cross them).
      let lines = 0;
      for (let x = 0; x < 320; x++) if (at(barrel, x, 4) > 100) lines++;
      expect(lines).toBeGreaterThan(4);
    }, 180_000);

    it('streaks along the angle it is given, and animates', async () => {
      const across = await grey(
        (await timeline(grid, 25, [effect('directional_blur', { angle: 0, radius: 0.05 })]))
          .timeline_id,
        5,
      );
      const down = await grey(
        (await timeline(grid, 25, [effect('directional_blur', { angle: 90, radius: 0.05 })]))
          .timeline_id,
        5,
      );
      // Sideways streaks wipe out the upright lines along a row and keep the level ones down a
      // column; upright streaks the other way round.
      expect(rowContrast(across)).toBeLessThan(80);
      expect(columnContrast(across)).toBeGreaterThan(180);
      expect(rowContrast(down)).toBeGreaterThan(180);
      expect(columnContrast(down)).toBeLessThan(80);
      const ramp = await timeline(grid, 25, [
        effect('directional_blur', {
          angle: 0,
          radius: {
            keyframes: [
              { frame: 0, value: 0 },
              { frame: 20, value: 0.05 },
            ],
          },
        }),
      ]);
      expect(rowContrast(await grey(ramp.timeline_id, 0))).toBeGreaterThan(180);
      expect(rowContrast(await grey(ramp.timeline_id, 20))).toBeLessThan(80);
    }, 180_000);
  });

  describe('channels', () => {
    let leftOnly: string;

    beforeAll(async () => {
      // A tone on the left channel only, the right silent: a lav on one side.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-filter_complex',
        '[1:a]pan=stereo|c0=c0|c1=0*c0[a]',
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-t',
        '3',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        join(mediaDir, 'left.mov'),
      ]);
      leftOnly = await importFile(join(mediaDir, 'left.mov'));
    }, 120_000);

    it('reports each channel in media.get and media.analyze loudness', async () => {
      const info = await ok<{ analysis: { channels?: Array<Record<string, unknown>> } }>(
        'media.get',
        { media_id: leftOnly },
      );
      expect(info.analysis.channels?.[0]?.rms_dbfs).toBeGreaterThan(-30);
      expect(info.analysis.channels?.[1]).toMatchObject({ channel: 2, rms_dbfs: null });
      const loud = await job<{
        loudness: { channels: Array<{ channel: number; rms_dbfs: number | null }> };
      }>('media.analyze', { media_id: leftOnly, kind: 'loudness' });
      expect(loud.loudness.channels).toHaveLength(2);
      expect(loud.loudness.channels[0]?.rms_dbfs).toBeGreaterThan(-30);
      expect(loud.loudness.channels[1]?.rms_dbfs).toBeNull();
    }, 120_000);

    it('routes channels: one side to both, a swap and a mono mix', async () => {
      const levels = async (params: Record<string, unknown>) => {
        const t = await timeline(leftOnly, 25, [
          {
            tool: 'filter.add',
            args: { clip_id: { $ref: 'ops[0].clip_ids[1]' }, name: 'channels', params },
          },
        ]);
        const loud = await job<{
          loudness: { channels: Array<{ rms_dbfs: number | null }> };
        }>('media.analyze', { timeline_id: t.timeline_id, kind: 'loudness' });
        return loud.loudness.channels.map((c) => c.rms_dbfs ?? -120);
      };
      const [l1 = 0, r1 = 0] = await levels({ left: 'left', right: 'left' });
      expect(Math.abs(l1 - r1)).toBeLessThan(0.5);
      expect(r1).toBeGreaterThan(-30);
      const [l2 = 0, r2 = 0] = await levels({ left: 'right', right: 'left' });
      expect(l2).toBeLessThan(-80);
      expect(r2).toBeGreaterThan(-30);
      const [l3 = 0, r3 = 0] = await levels({ left: 'mix', right: 'mix' });
      expect(Math.abs(l3 - r3)).toBeLessThan(0.5);
      // Half the left plus half of nothing: 6 dB under the tone.
      expect(Math.abs(l1 - l3 - 6)).toBeLessThan(0.7);
    }, 300_000);
  });

  describe.skipIf(!espeak)('room echo', () => {
    /** Mono 48 kHz samples of a file. */
    async function samples(file: string): Promise<Float64Array> {
      const { stdout } = await exec(
        'ffmpeg',
        ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      );
      return Float64Array.from(
        new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length >> 2),
      );
    }

    /** How close `x` is to `ref` (dB of ref over what is left), at the best lag within 20 ms and gain. */
    function closeness(x: Float64Array, ref: Float64Array): number {
      let best = Number.NEGATIVE_INFINITY;
      for (let lag = -960; lag <= 960; lag += 8) {
        let xr = 0;
        let rr = 0;
        let xx = 0;
        for (let i = 2000; i < ref.length - 2000; i++) {
          const a = x[i + lag] ?? 0;
          const b = ref[i] ?? 0;
          xr += a * b;
          rr += b * b;
          xx += a * a;
        }
        const g = xr / rr;
        const rest = xx - 2 * g * xr + g * g * rr;
        best = Math.max(best, 10 * Math.log10((g * g * rr) / Math.max(rest, 1e-12)));
      }
      return best;
    }

    it('takes the echo tail out of speech, keeping it in step', async () => {
      await exec('espeak-ng', [
        '-s',
        '150',
        '-w',
        join(mediaDir, 'dry.wav'),
        'Hello there. This is a test of the echo removal. Short words, then a pause. And then some more words to finish.',
      ]);
      // A room: the direct sound, then a noise tail fading by 60 dB in half a second.
      await ff([
        '-f',
        'lavfi',
        '-i',
        'anoisesrc=color=white:sample_rate=48000:amplitude=0.03:seed=7',
        '-t',
        '0.8',
        '-af',
        'aeval=val(0)*exp(-t*13.8)*gt(t\\,0.003)+lt(t\\,0.00002)',
        join(mediaDir, 'room.wav'),
      ]);
      await ff([
        '-i',
        join(mediaDir, 'dry.wav'),
        '-filter_complex',
        '[0]aresample=48000,apad=pad_dur=1[d]',
        '-map',
        '[d]',
        join(mediaDir, 'dry48.wav'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:size=320x180:rate=25',
        '-i',
        join(mediaDir, 'dry48.wav'),
        '-i',
        join(mediaDir, 'room.wav'),
        '-filter_complex',
        '[1][2]afir=gtype=none:irnorm=-1[a]',
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'pcm_s16le',
        join(mediaDir, 'room.mov'),
      ]);
      const wet = await importFile(join(mediaDir, 'room.mov'));
      const exported = async (ops: Op[]) => {
        const t = await timeline(wet, 25, ops);
        const done = await job<{ file: string }>('export.video', {
          timeline_id: t.timeline_id,
          preset: 'web_1080p_h264',
        });
        return samples(done.file);
      };
      const dry = await samples(join(mediaDir, 'dry48.wav'));
      const plain = await exported([]);
      const cleaned = await exported([
        {
          tool: 'filter.add',
          args: { clip_id: { $ref: 'ops[0].clip_ids[1]' }, name: 'dereverb' },
        },
      ]);
      // Closer to the dry voice than the room recording is, by more than 1 dB.
      expect(closeness(cleaned, dry)).toBeGreaterThan(closeness(plain, dry) + 1);
      // A track refuses it: it works on a clip's own source.
      const t = await timeline(wet, 25, []);
      const refused = await call('filter.add', {
        timeline_id: t.timeline_id,
        track_id: 't2',
        name: 'dereverb',
      });
      expect(refused.isError).toBe(true);
    }, 600_000);
  });

  describe.skipIf(!upscaleModels)('add resolution', () => {
    it('makes video and pictures larger, with their sound, within the limits', async () => {
      await ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        join(mediaDir, 'small.mp4'),
      ]);
      await ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=120x80',
        '-frames:v',
        '1',
        join(mediaDir, 'small.png'),
      ]);
      const video = await importFile(join(mediaDir, 'small.mp4'));
      const still = await importFile(join(mediaDir, 'small.png'));
      const big = await job<{
        media_id: string;
        width: number;
        height: number;
        has_audio: boolean;
      }>('create.upscaled', { media_id: video, scale: 2 });
      expect([big.width, big.height]).toEqual([320, 180]);
      expect(big.has_audio).toBe(true);
      const t = await timeline(big.media_id, 10, []);
      const frame = await grey(t.timeline_id, 5);
      expect(frame.length).toBe(320 * 180);
      const picture = await job<{ width: number; height: number }>('create.upscaled', {
        media_id: still,
        scale: 4,
        denoise: 'light',
      });
      expect([picture.width, picture.height]).toEqual([480, 320]);
      // The same recipe is the same media.
      const again = await job<{ media_id: string }>('create.upscaled', {
        media_id: video,
        scale: 2,
      });
      expect(again.media_id).toBe(big.media_id);
      const tooBig = await call('create.upscaled', { media_id: still, scale: 4.5 });
      expect(tooBig.isError).toBe(true);
    }, 900_000);
  });
});
