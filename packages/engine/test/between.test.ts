import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { betweenPicture } from '../src/sourcepass.ts';

// The copy of a clip's stretch of source with in-between frames: it covers the whole stretch,
// a frame for every moment at the rate asked, laid out at the sequence rate. FFmpeg only.

const exec = promisify(execFile);
const ffmpeg = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
if (!ffmpeg && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg is missing');
}

describe.skipIf(!ffmpeg)('in-between frames copy', () => {
  it('covers the whole stretch of source it was made for, from mid-file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-between-'));
    const source = join(dir, 'clock.mp4');
    await exec('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=10',
      '-t',
      '8',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      source,
    ]);
    for (const mode of ['blend', 'motion'] as const) {
      // A clip at 0.25x in a 30 fps sequence over source 3 to 6 s: 120 frames a source second.
      const made = await betweenPicture(
        source,
        join(dir, 'between'),
        { mode, fps: 120, sequence: 30, from: 3, to: 6 },
        { source: { num: 10, den: 1 }, purpose: 'preview', alpha: false },
      );
      expect(made.offset).toBeCloseTo(3, 6);
      expect(made.stretch).toBe(4);
      const { stdout } = await exec('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'stream=nb_read_frames,r_frame_rate',
        '-of',
        'json',
        made.path,
      ]);
      const stream = (
        JSON.parse(stdout) as { streams: Array<{ nb_read_frames: string; r_frame_rate: string }> }
      ).streams[0];
      expect(stream?.r_frame_rate).toBe('30/1');
      // Three source seconds at 120 a second, short only of the last source frame or two (the
      // span has a second to spare past the clip); before, it stopped after a quarter of them.
      expect(Number(stream?.nb_read_frames)).toBeGreaterThanOrEqual(2.75 * 120);
      expect(Number(stream?.nb_read_frames)).toBeLessThanOrEqual(3 * 120 + 1);
    }
  }, 300_000);
});
