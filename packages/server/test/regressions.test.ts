// Bugs blind tests found (MVP-254), each pinned through the SDK client with real engines. Skips
// on hosts without FFmpeg and MLT; the Docker test target runs it.
import { execFile } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BIN } from '@cuttingfloor/engine';
import type { Client } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

const exec = promisify(execFile);

const engines = await Promise.all([exec('melt', ['--version']), exec('ffmpeg', ['-version'])]).then(
  () => true,
  () => false,
);
if (!engines && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg/melt are missing');
}

const ff = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);

let env: TestEnv;
let client: Client;

async function importMedia(path: string): Promise<Record<string, unknown> & { media_id: string }> {
  const started = await ok<{ job_id?: string; media_id: string }>(client, 'media.import', {
    source: { path },
  });
  if (!started.job_id) return ok(client, 'media.get', { media_id: started.media_id });
  const done = await settled<{ result?: Record<string, unknown>; error?: unknown }>(
    client,
    started.job_id,
    240_000,
  );
  if (done.error) throw new Error(`import failed: ${JSON.stringify(done.error)}`);
  return done.result as Record<string, unknown> & { media_id: string };
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

function colour([r, g, b]: [number, number, number]): string {
  const hi = (v: number) => v > 170;
  const lo = (v: number) => v < 70;
  if (hi(r) && hi(g) && hi(b)) return 'white';
  if (lo(r) && lo(g) && lo(b)) return 'black';
  if (hi(r) && lo(g) && lo(b)) return 'red';
  if (lo(r) && hi(g) && lo(b)) return 'green';
  if (lo(r) && lo(g) && hi(b)) return 'blue';
  return `rgb(${r},${g},${b})`;
}

async function frameImage(timelineId: string, frame: number, longEdge: number): Promise<Buffer> {
  const res = await call(client, 'render.frames', {
    timeline_id: timelineId,
    frames: [frame],
    layout: 'single',
    format: 'png',
    long_edge: longEdge,
  });
  if (res.isError) throw new Error(JSON.stringify(res.structured));
  const image = res.content.find((c) => c.type === 'image');
  return Buffer.from((image?.data as string) ?? '', 'base64');
}

async function look(
  timelineId: string,
  frame: number,
  longEdge: number,
  points: Array<[number, number]>,
): Promise<string[]> {
  const image = await frameImage(timelineId, frame, longEdge);
  return Promise.all(points.map(async ([x, y]) => colour(await pixel(image, x, y))));
}

const ids: Record<string, string> = {};

describe.skipIf(!engines)('blind-test regressions', () => {
  beforeAll(async () => {
    env = await testRuntime(
      process.env.CUTTINGFLOOR_MODELS ? { modelsDir: process.env.CUTTINGFLOOR_MODELS } : {},
    );
    client = await connect(env.runtime);
    const m = env.mediaDir;
    // A landscape green picture (like game footage), a portrait red one (a face cam) and a
    // narrow white divider still.
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x00ff00:size=1152x720:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '9',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(m, 'game.mp4'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=1080x1920:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=660:sample_rate=48000',
      '-t',
      '9',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(m, 'face.mp4'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=white:size=16x1080',
      '-frames:v',
      '1',
      join(m, 'divider.png'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:size=1920x1080:rate=24',
      '-t',
      '9',
      '-pix_fmt',
      'yuv420p',
      join(m, 'blue.mp4'),
    ]);
    for (const name of ['game', 'face', 'divider', 'blue']) {
      const ext = name === 'divider' ? 'png' : 'mp4';
      ids[name] = (await importMedia(join(m, `${name}.${ext}`))).media_id;
    }
  }, 240_000);

  it('renders a nested timeline inside another exactly as it renders alone', async () => {
    const seq = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
    const { timeline_id: blank } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'split',
      sequence: seq,
      tracks: { video: 3, audio: 2 },
    });
    // Game on the left half, the portrait face scaled up and cropped on the right, a divider.
    const split = await ok<{ timeline_id: string }>(client, 'edit.batch', {
      timeline_id: blank,
      preview: 'none',
      ops: [
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: ids.game, source: { in: 0, out: 192 } },
        },
        {
          tool: 'clip.set_transform',
          args: {
            clip_id: { $ref: 'ops[0].clip_id' },
            x: 0.25,
            crop: { left: 0.2222, right: 0.2222 },
          },
        },
        {
          tool: 'clip.add',
          args: {
            track_id: 't2',
            media_id: ids.face,
            av: 'video',
            at_frame: 0,
            source: { in: 0, out: 192 },
          },
        },
        {
          tool: 'clip.set_transform',
          args: {
            clip_id: { $ref: 'ops[2].clip_id' },
            x: 0.75,
            y: 0.6635,
            scale: 1.5802,
            crop: { top: 0.08, bottom: 0.287 },
          },
        },
        {
          tool: 'clip.add',
          args: { track_id: 't3', media_id: ids.divider, at_frame: 0, duration_frames: 192 },
        },
        {
          tool: 'clip.set_transform',
          args: { clip_id: { $ref: 'ops[4].clip_id' }, fit: 'none', scale_x: 0.375 },
        },
      ],
    });
    const points: Array<[number, number]> = [
      [240, 540], // game
      [1440, 540], // face, scaled to fill the right half
      [1000, 540], // face's left edge region
      [1900, 540],
      [960, 540], // divider
    ];
    const alone = await look(split.timeline_id, 60, 1920, points);
    expect(alone).toEqual(['green', 'red', 'red', 'red', 'white']);

    const { timeline_id: main } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'main',
      sequence: seq,
    });
    const outer = await ok<{ timeline_id: string }>(client, 'edit.batch', {
      timeline_id: main,
      preview: 'none',
      ops: [
        {
          tool: 'clip.add',
          args: {
            track_id: 't1',
            nested_timeline_id: split.timeline_id,
            source: { in: 0, out: 144 },
          },
        },
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: ids.blue, source: { in: 0, out: 96 } },
        },
        {
          tool: 'clip.add',
          args: {
            track_id: 't1',
            nested_timeline_id: split.timeline_id,
            source: { in: 144, out: 192 },
          },
        },
        {
          tool: 'transition.add',
          args: { clip_id: { $ref: 'ops[0].clip_id' }, kind: 'push_left', duration_frames: 6 },
        },
      ],
    });
    for (const size of [1920, 960]) {
      const scale = size / 1920;
      const scaled = points.map(([x, y]) => [
        Math.round(x * scale),
        Math.round(y * scale),
      ]) as Array<[number, number]>;
      expect(await look(outer.timeline_id, 60, size, scaled), `long_edge ${size}`).toEqual(
        await look(split.timeline_id, 60, size, scaled),
      );
    }
    expect(await look(outer.timeline_id, 60, 1920, points)).toEqual(alone);
  }, 240_000);

  it('conforms a file whose rates drift apart to a constant rate, so every frame number is true', async () => {
    // Like a game recorder's file: nominally 20 fps, but a few frames come early, so the average
    // rate (about 20.13) and the frame times drift from the nominal grid.
    const file = join(env.mediaDir, 'drift.mp4');
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x200:rate=20',
      '-frames:v',
      '300',
      '-vf',
      "setpts='(N/20-floor(N/100)*0.025)/TB'",
      '-fps_mode',
      'passthrough',
      '-video_track_timescale',
      '60000',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      file,
    ]);
    const drift = await importMedia(file);
    expect(drift.conform).toContain('vfr');
    expect(drift.fps).toEqual({ num: 20, den: 1 });
    const seconds = drift.duration_seconds as number;
    const last = Math.round(seconds * 20) - 1;
    const res = await call(client, 'render.frames', {
      media_id: drift.media_id,
      frames: [0, last],
      layout: 'single',
      format: 'png',
      long_edge: 320,
    });
    expect(res.isError, JSON.stringify(res.structured)).toBe(false);
    const past = await call(client, 'render.frames', {
      media_id: drift.media_id,
      frames: [last + 1],
    });
    expect(past.isError).toBe(true);
  }, 120_000);

  it('renders an inline preview again when melt ends without its frame, and says why when it never comes', async () => {
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'preview',
      sequence: { width: 640, height: 360, fps: { num: 24, den: 1 } },
    });
    // A melt that ends cleanly having written nothing, as it did on a loaded server: once, then
    // always.
    const real = BIN.melt;
    const count = join(env.dir, 'melt-runs');
    const fake = join(env.dir, 'melt-drop');
    await writeFile(
      fake,
      `#!/bin/sh\nn=$(cat ${count} 2>/dev/null || echo 0)\necho $((n + 1)) > ${count}\nif [ "$n" -lt "$DROPS" ]; then echo "[producer avformat] Failed to open decoder" >&2; exit 0; fi\nexec ${real} "$@"\n`,
    );
    await chmod(fake, 0o755);
    BIN.melt = fake;
    try {
      process.env.DROPS = '1';
      const once = await ok<{ preview: { status: string }; warnings: string[] }>(
        client,
        'clip.add',
        {
          timeline_id,
          track_id: 't1',
          media_id: ids.blue,
          av: 'video',
          source: { in: 0, out: 24 },
          preview: 'inline',
        },
      );
      expect(once.warnings).toEqual([]);
      expect(once.preview.status).toBe('ready');
      await writeFile(count, '0');
      process.env.DROPS = '99';
      const never = await ok<{ preview: { status: string }; warnings: string[] }>(
        client,
        'clip.add',
        {
          timeline_id,
          track_id: 't1',
          media_id: ids.game,
          av: 'video',
          source: { in: 0, out: 24 },
          preview: 'inline',
        },
      );
      expect(never.preview.status).toBe('pending');
      expect(never.warnings.join(' ')).toMatch(
        /melt rendered 0 of 1 frames: .*Failed to open decoder/,
      );
    } finally {
      BIN.melt = real;
      delete process.env.DROPS;
    }
  }, 120_000);
});
