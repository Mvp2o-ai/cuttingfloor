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

  it('previews a clip that is only sound as its waveform with loudness', async () => {
    const tone = join(env.mediaDir, 'tone.wav');
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '4', tone]);
    const { media_id } = await importMedia(tone);
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'music',
      sequence: { width: 640, height: 360, fps: { num: 24, den: 1 } },
    });
    const res = await call(client, 'clip.add', {
      timeline_id,
      track_id: 't2',
      media_id,
      source: { in: 0, out: 48 },
      preview: 'inline',
    });
    expect(res.isError).toBe(false);
    const preview = res.structured.preview as { uri: string; loudness?: { lufs: number | null } };
    expect(preview.uri).toMatch(/waveform/);
    expect(preview.loudness?.lufs).toBeTypeOf('number');
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
  }, 120_000);

  it('finds hard cuts at the scale the threshold describes, with each cut scored', async () => {
    // Three hard cuts between moving pictures, at 2, 4 and 6 s.
    const file = join(env.mediaDir, 'cuts.mp4');
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25:d=2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25:d=2,hue=h=120,hflip',
      '-f',
      'lavfi',
      '-i',
      'mandelbrot=size=640x360:rate=25,trim=duration=2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25:d=2,negate',
      '-filter_complex',
      '[0][1][2][3]concat=n=4:v=1,format=yuv420p',
      '-c:v',
      'libx264',
      file,
    ]);
    const { media_id } = await importMedia(file);
    const scenes = async (threshold: number) => {
      const started = await ok<{ job_id: string }>(client, 'media.analyze', {
        media_id,
        kind: 'scenes',
        threshold,
      });
      const done = await settled<{ result: { scenes: number[]; scene_scores: number[] } }>(
        client,
        started.job_id,
        60_000,
      );
      return done.result;
    };
    const at10 = await scenes(10);
    expect(at10.scenes.map(Math.round)).toEqual([2, 4, 6]);
    // Hard cuts between ordinary pictures score in the tens, which the description says.
    for (const score of at10.scene_scores) expect(score).toBeGreaterThan(10);
    for (const score of at10.scene_scores) expect(score).toBeLessThan(50);
    const { tools } = await client.listTools();
    const analyze = JSON.stringify(tools.find((t) => t.name === 'media.analyze'));
    expect(analyze).toMatch(/Hard cuts between ordinary shots score about 10 to 30/);
  }, 120_000);

  it('swaps a clip and its linked sound onto the new media together', async () => {
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'swap',
      sequence: { width: 640, height: 360, fps: { num: 24, den: 1 } },
    });
    const added = await ok<{ timeline_id: string; clip_ids: string[] }>(client, 'clip.add', {
      timeline_id,
      track_id: 't1',
      media_id: ids.game,
      source: { in: 24, out: 72 },
      preview: 'none',
    });
    const [video, audio] = added.clip_ids as [string, string];
    const lcut = added;
    const before = await ok<{ tracks: Array<{ clips: Array<Record<string, unknown>> }> }>(
      client,
      'timeline.get',
      { timeline_id: lcut.timeline_id },
    );
    const clipOf = (doc: typeof before, id: string) =>
      doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as {
        media_id: string;
        source: { in: number; out: number };
      };
    const offset = clipOf(before, audio).source.in - clipOf(before, video).source.in;
    const swapped = await ok<{ timeline_id: string; clip_ids: string[] }>(client, 'clip.replace', {
      timeline_id: lcut.timeline_id,
      clip_id: video,
      media_id: ids.face,
      source_in: 48,
      preview: 'none',
    });
    expect(swapped.clip_ids.sort()).toEqual([video, audio].sort());
    const after = await ok<typeof before>(client, 'timeline.get', {
      timeline_id: swapped.timeline_id,
    });
    expect(clipOf(after, video)).toMatchObject({ media_id: ids.face, source: { in: 48 } });
    expect(clipOf(after, audio)).toMatchObject({ media_id: ids.face, source: { in: 48 + offset } });

    const only = await ok<{ timeline_id: string }>(client, 'clip.replace', {
      timeline_id: lcut.timeline_id,
      clip_id: video,
      media_id: ids.face,
      linked: false,
      preview: 'none',
    });
    const alone = await ok<typeof before>(client, 'timeline.get', {
      timeline_id: only.timeline_id,
    });
    expect(clipOf(alone, audio).media_id).toBe(ids.game);

    // New media without sound: the picture swaps and the result says the sound did not.
    const silent = await ok<{ warnings: string[] }>(client, 'clip.replace', {
      timeline_id: lcut.timeline_id,
      clip_id: video,
      media_id: ids.blue,
      preview: 'none',
    });
    expect(silent.warnings.join(' ')).toMatch(new RegExp(`${audio} .*still plays the old audio`));
  }, 120_000);

  it('says media.listen hears music as a whole, not the drums in it', async () => {
    // A kick every half second with a snare between: to the model this is music, not drum hits.
    const file = join(env.mediaDir, 'kick.wav');
    await ff([
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='if(lt(mod(t,0.5),0.12),sin(2*PI*(50+120*exp(-30*mod(t,0.5)))*mod(t,0.5))*exp(-20*mod(t,0.5)),0)+if(lt(mod(t-0.25,0.5),0.08),0.4*(random(0)-0.5)*exp(-40*mod(t-0.25,0.5)),0)':s=48000:d=8",
      file,
    ]);
    const { media_id } = await importMedia(file);
    const started = await ok<{ job_id: string }>(client, 'media.listen', {
      media_id,
      sounds: { kick: 'a kick drum hit', drum: 'drum', music: 'music' },
    });
    const done = await settled<{ result: { peaks: Record<string, number>; note?: string } }>(
      client,
      started.job_id,
      240_000,
    );
    expect(done.result.peaks.music).toBeGreaterThan(0.8);
    expect(done.result.peaks.kick).toBeLessThan(0.05);
    expect(done.result.peaks.drum).toBeLessThan(0.05);
    expect(done.result.note).toMatch(/not instruments, drums or single hits/);
  }, 240_000);

  it('does not call a linked clip out of sync when an overlap transition leaves it in place', async () => {
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'dissolve',
      sequence: { width: 640, height: 360, fps: { num: 24, den: 1 } },
    });
    const built = await ok<{ timeline_id: string; results: Array<{ clip_ids?: string[] }> }>(
      client,
      'edit.batch',
      {
        timeline_id,
        preview: 'none',
        ops: [
          {
            tool: 'clip.add',
            args: { track_id: 't1', media_id: ids.game, source: { in: 0, out: 48 } },
          },
          {
            tool: 'clip.add',
            args: { track_id: 't1', media_id: ids.blue, av: 'video', source: { in: 0, out: 48 } },
          },
        ],
      },
    );
    const [video, audio] = (built.results[0]?.clip_ids ?? []) as [string, string];
    const res = await ok<{ warnings: string[] }>(client, 'transition.add', {
      timeline_id: built.timeline_id,
      clip_id: video,
      kind: 'dissolve',
      duration_frames: 12,
      preview: 'none',
    });
    const said = res.warnings.join(' ');
    expect(said).not.toMatch(new RegExp(`play .* later against it: [^.]*${audio}`));
    expect(said).toMatch(new RegExp(`${audio} \\(linked to ${video}\\) stay in sync`));
  }, 60_000);

  it('flags sound that stops before the picture, and counts the soundless end as silence', async () => {
    // 6 s of picture with 3 s of loud sound, like a film whose audio track ends early.
    const file = join(env.mediaDir, 'short-sound.mp4');
    await ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=24:d=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:d=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ]);
    const media = await importMedia(file);
    const info = await ok<{ stream_seconds: { video: number; audio: number } }>(
      client,
      'media.get',
      { media_id: media.media_id },
    );
    expect(info.stream_seconds.video).toBeCloseTo(6, 1);
    expect(info.stream_seconds.audio).toBeCloseTo(3, 1);
    const started = await ok<{ job_id: string }>(client, 'media.analyze', {
      media_id: media.media_id,
      kind: 'silence',
      threshold_db: -60,
      min_seconds: 0.5,
    });
    const done = await settled<{
      result: { silences: Array<{ start: number; end: number }>; sound_ends?: number };
    }>(client, started.job_id, 60_000);
    expect(done.result.sound_ends).toBeCloseTo(3, 1);
    expect(done.result.silences).toHaveLength(1);
    expect(done.result.silences[0]?.start).toBeCloseTo(3, 1);
    expect(done.result.silences[0]?.end).toBeCloseTo(6, 1);
  }, 120_000);
});

describe('media not ready yet', () => {
  it('names the job making the media, and says render.frames waits for an import', async () => {
    const plain = await testRuntime();
    const c = await connect(plain.runtime, 'waiter');
    const media = plain.runtime.media;
    // A page create.motion is still making, and a file media.import is still probing.
    const made = await media.create(
      'waiter',
      { created: 'create.motion', recipe: 'r', job_id: 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
      'page',
    );
    const imported = await media.create('waiter', { path: join(plain.mediaDir, 'x.mp4') }, 'x');
    imported.job_id = 'j_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    await media.save('waiter', imported);
    const { timeline_id } = await ok<{ timeline_id: string }>(c, 'timeline.create', {
      name: 'wait',
      sequence: { width: 640, height: 360, fps: { num: 24, den: 1 } },
    });
    const edit = await call(c, 'clip.add', {
      timeline_id,
      track_id: 't1',
      media_id: made.media_id,
      preview: 'none',
    });
    expect(edit.structured).toMatchObject({
      code: 'media_not_ready',
      detail: { tool: 'create.motion', job_id: 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(String(edit.structured.message)).toMatch(/still being made \(create\.motion job j_a+\)/);
    expect(String(edit.structured.hint)).toMatch(/job\.get \{job_id: "j_a+"\}/);
    expect(String(edit.structured.hint)).not.toMatch(/media\.import/);

    const frames = await call(c, 'render.frames', { media_id: imported.media_id, frames: [0] });
    expect(frames.structured).toMatchObject({
      code: 'media_not_ready',
      detail: { tool: 'media.import', job_id: 'j_bbbbbbbbbbbbbbbbbbbbbbbbbb' },
    });
    expect(String(frames.structured.message)).toMatch(/still importing/);
    expect(String(frames.structured.message)).not.toMatch(/no picture/);

    const analyze = await call(c, 'media.analyze', {
      media_id: made.media_id,
      kind: 'scenes',
      threshold: 10,
    });
    expect(analyze.structured).toMatchObject({
      code: 'media_not_ready',
      detail: { job_id: 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
  });

  it('records the import job on the media it imports', async () => {
    const plain = await testRuntime();
    const c = await connect(plain.runtime, 'importer');
    await writeFile(join(plain.mediaDir, 'y.wav'), Buffer.alloc(64));
    const started = await ok<{ job_id: string; media_id: string }>(c, 'media.import', {
      source: { path: join(plain.mediaDir, 'y.wav') },
    });
    const record = await plain.runtime.media.get('importer', started.media_id);
    expect(record.job_id).toBe(started.job_id);
  });
});
