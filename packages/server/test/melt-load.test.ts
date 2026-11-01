// melt under load. MLT 7.30's avformat consumer started its thread before marking itself
// running; when a busy machine ran the new thread first, it ended at once and melt rendered no
// frames ("melt rendered 0 of 1 frames and gave no reason") or never ended. The image builds
// the module with that fixed (tools/mlt/consumer-start-race.patch). Here the race is made to
// happen every time with a test-only shim that holds melt's main thread back after it starts a
// thread, and concurrent renders are checked to all come back. Engines only (Docker test target).
import { execFile } from 'node:child_process';
import { access, chmod, writeFile } from 'node:fs/promises';
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
const SHIM = join(process.env.CUTTINGFLOOR_MODELS ?? '/opt/models', 'thread-delay.so');
const shim = await access(SHIM).then(
  () => true,
  () => false,
);
if (process.env.CUTTINGFLOOR_REQUIRE_ENGINES && (!engines || !shim)) {
  throw new Error(`CUTTINGFLOOR_REQUIRE_ENGINES is set but melt, ffmpeg or ${SHIM} is missing`);
}

let env: TestEnv;
let client: Client;
const timelines: string[] = [];

/** A 320x180 timeline of a moving test picture, cut and composited as edits usually are. */
async function timeline(media: string, i: number): Promise<string> {
  const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
    name: `load ${i}`,
    sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
    tracks: { video: 2, audio: 1 },
  });
  const made = await ok<{ timeline_id: string; clip_ids: string[] }>(client, 'edit.batch', {
    timeline_id,
    preview: 'none',
    ops: [
      {
        tool: 'clip.add',
        args: { track_id: 't1', media_id: media, source: { in: i, out: i + 50 } },
      },
      {
        tool: 'clip.add',
        args: {
          track_id: 't2',
          media_id: media,
          av: 'video',
          at_frame: 0,
          source: { in: 0, out: 50 },
        },
      },
      {
        tool: 'clip.set_transform',
        args: { clip_id: { $ref: 'ops[1].clip_id' }, scale: 0.4, x: 0.75, y: 0.3 },
      },
    ],
  });
  return made.timeline_id;
}

async function frame(timelineId: string, f: number) {
  return call(client, 'render.frames', {
    timeline_id: timelineId,
    frames: [f],
    layout: 'single',
    format: 'png',
    long_edge: 320,
  });
}

describe.skipIf(!engines)('melt under load', () => {
  beforeAll(async () => {
    env = await testRuntime();
    client = await connect(env.runtime);
    const file = join(env.mediaDir, 'moving.mp4');
    await exec('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=25:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:d=4',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ]);
    const started = await ok<{ job_id: string; media_id: string }>(client, 'media.import', {
      source: { path: file },
    });
    await settled(client, started.job_id, 120_000);
    for (let i = 0; i < 4; i++) timelines.push(await timeline(started.media_id, i * 10));
  }, 180_000);

  it.skipIf(!shim)(
    'renders a frame when melt starts its encoder thread on a busy machine',
    async () => {
      // melt as a loaded machine runs it: the main thread loses the CPU right after it starts
      // each thread, so the encoder thread always looks at its state first.
      const real = BIN.melt;
      const slow = join(env.dir, 'melt-busy');
      await writeFile(
        slow,
        `#!/bin/sh\nLD_PRELOAD=${SHIM} CF_THREAD_DELAY_US=50000 exec ${real} "$@"\n`,
      );
      await chmod(slow, 0o755);
      BIN.melt = slow;
      try {
        for (const [i, t] of timelines.entries()) {
          const res = await frame(t, 5 + i);
          expect(res.isError, JSON.stringify(res.structured)).toBe(false);
          expect(res.content.some((c) => c.type === 'image')).toBe(true);
        }
      } finally {
        BIN.melt = real;
      }
    },
    120_000,
  );

  it.skipIf(!shim)(
    'reads the loudness of a mix when melt starts its encoder thread on a busy machine',
    async () => {
      // The mix a loudness read renders goes through the same avformat consumer (to a WAV, no
      // picture). Before the fix this hung at "loudness: rendering the mix" until the job stalled.
      const real = BIN.melt;
      const slow = join(env.dir, 'melt-busy-mix');
      await writeFile(
        slow,
        `#!/bin/sh\nLD_PRELOAD=${SHIM} CF_THREAD_DELAY_US=50000 exec ${real} "$@"\n`,
      );
      await chmod(slow, 0o755);
      BIN.melt = slow;
      try {
        for (const t of timelines.slice(0, 2)) {
          const started = await ok<{ job_id: string }>(client, 'media.analyze', {
            timeline_id: t,
            kind: 'loudness',
          });
          const done = await settled<{
            result?: { loudness?: { integrated_lufs?: number | null } };
            error?: unknown;
          }>(client, started.job_id, 60_000);
          expect(done.status, JSON.stringify(done.error)).toBe('completed');
          expect(done.result?.loudness?.integrated_lufs).toBeLessThan(0);
        }
      } finally {
        BIN.melt = real;
      }
    },
    150_000,
  );

  it('answers every one of many frame renders asked for at once', async () => {
    for (let round = 0; round < 3; round++) {
      const asks = timelines.flatMap((t, i) =>
        [0, 7, 23, 41].map((f) => ({ t, f: (f + i + round) % 50 })),
      );
      const results = await Promise.all(asks.map(({ t, f }) => frame(t, f)));
      const failed = results.filter((r) => r.isError).map((r) => JSON.stringify(r.structured));
      expect(failed).toEqual([]);
      for (const r of results) expect(r.content.some((c) => c.type === 'image')).toBe(true);
    }
  }, 300_000);
});
