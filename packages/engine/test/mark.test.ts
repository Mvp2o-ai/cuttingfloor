import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { burnMark } from '@cuttingfloor/engine';
import { describe, expect, it } from 'vitest';

// The cuttingfloor mark burnt into a finished file: it is there to see, and the file is
// otherwise what it was (size, frame rate, length, sound, codec family, alpha).

const exec = promisify(execFile);
const ffmpeg = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
if (!ffmpeg && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg is missing');
}

const dir = ffmpeg ? await mkdtemp(join(tmpdir(), 'cf-mark-')) : '';

async function make(name: string, args: string[]): Promise<string> {
  const path = join(dir, name);
  await exec('ffmpeg', ['-v', 'error', '-y', ...args, path]);
  return path;
}

interface Facts {
  format: string;
  codec: string;
  profile?: string;
  width: number;
  height: number;
  pix_fmt: string;
  rate: string;
  frames: number;
  duration: number;
  audio: string | null;
}

async function facts(path: string): Promise<Facts> {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    path,
  ]);
  const json = JSON.parse(stdout) as {
    format: { format_name: string; duration?: string };
    streams: Array<Record<string, string | number>>;
  };
  const v = json.streams.find((s) => s.codec_type === 'video') ?? {};
  const a = json.streams.find((s) => s.codec_type === 'audio');
  return {
    format: json.format.format_name,
    codec: String(v.codec_name),
    ...(v.profile ? { profile: String(v.profile) } : {}),
    width: Number(v.width),
    height: Number(v.height),
    pix_fmt: String(v.pix_fmt),
    rate: String(v.r_frame_rate),
    frames: Number(v.nb_read_frames),
    duration: Number(json.format.duration ?? 0),
    audio: a ? String(a.codec_name) : null,
  };
}

/** The frame at `t` seconds, as RGBA bytes (alpha kept, for decoders that keep it). */
async function frame(path: string, t: number, codec?: string): Promise<Buffer> {
  const { stdout } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      ...(codec ? ['-c:v', codec] : []),
      '-i',
      path,
      '-ss',
      String(t),
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/** Share of pixels that differ by more than a little in any channel. */
function changed(a: Buffer, b: Buffer): number {
  expect(a.length).toBe(b.length);
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)),
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)),
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)),
      Math.abs((a[i + 3] ?? 0) - (b[i + 3] ?? 0)),
    );
    if (d > 12) n += 1;
  }
  return n / (a.length / 4);
}

const flat = (size: string, rate: number, seconds: number) => [
  '-f',
  'lavfi',
  '-i',
  `color=c=0x3a6ea5:size=${size}:rate=${rate}:duration=${seconds}`,
];
const tone = (seconds: number) => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`];

describe.skipIf(!ffmpeg)('the cuttingfloor mark', { timeout: 120_000 }, () => {
  it('marks a 16:9 H.264 MP4 and keeps its size, rate, length and sound', async () => {
    const input = await make('wide.mp4', [
      ...flat('640x360', 25, 12),
      ...tone(12),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
    ]);
    const output = join(dir, 'wide-marked.mp4');
    await burnMark(input, output, { seed: 'media_wide' });
    const before = await facts(input);
    const after = await facts(output);
    expect(after).toMatchObject({
      codec: 'h264',
      width: 640,
      height: 360,
      pix_fmt: 'yuv420p',
      rate: '25/1',
      frames: before.frames,
      audio: 'aac',
    });
    expect(Math.abs(after.duration - before.duration)).toBeLessThan(0.1);
    // The first frame starts on a piece fully in.
    expect(changed(await frame(input, 0), await frame(output, 0))).toBeGreaterThan(0.005);
    // The same seed marks the same way; another seed starts elsewhere in the loop.
    const again = join(dir, 'wide-again.mp4');
    await burnMark(input, again, { seed: 'media_wide' });
    expect(changed(await frame(output, 1), await frame(again, 1))).toBeLessThan(0.001);
  });

  it('marks a 9:16 clip with no sound, pieces scaled to its short side', async () => {
    const input = await make('tall.mp4', [
      ...flat('360x640', 30, 10),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
    ]);
    const output = join(dir, 'tall-marked.mp4');
    await burnMark(input, output, { seed: 'media_tall' });
    expect(await facts(output)).toMatchObject({
      codec: 'h264',
      width: 360,
      height: 640,
      rate: '30/1',
      frames: 300,
      audio: null,
    });
    const share = changed(await frame(input, 0.5), await frame(output, 0.5));
    // A piece is ~15–35% of the short side: a visible patch, not the whole frame.
    expect(share).toBeGreaterThan(0.005);
    expect(share).toBeLessThan(0.4);
  });

  it('repeats the loop over a clip longer than a minute', async () => {
    const input = await make('long.mp4', [
      ...flat('320x180', 10, 70),
      ...tone(70),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
    ]);
    const output = join(dir, 'long-marked.mp4');
    await burnMark(input, output, { seed: 'media_long' });
    const after = await facts(output);
    expect(after.frames).toBe(700);
    expect(after.audio).toBe('aac');
    // Pieces come every 4–6 s, so past the first minute some second carries one.
    const plain = await frame(input, 65);
    const late = await Promise.all([61, 63, 65, 67, 69].map((t) => frame(output, t)));
    expect(Math.max(...late.map((f) => changed(plain, f)))).toBeGreaterThan(0.005);
  });

  it('marks an animated GIF as a GIF, every frame kept', async () => {
    const input = await make('anim.gif', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=240x180:rate=10:duration=2',
    ]);
    const output = join(dir, 'anim-marked.gif');
    await burnMark(input, output, { seed: 'media_gif' });
    const before = await facts(input);
    const after = await facts(output);
    expect(after).toMatchObject({ codec: 'gif', width: 240, height: 180, frames: before.frames });
    expect(changed(await frame(input, 1), await frame(output, 1))).toBeGreaterThan(0.005);
  });

  it('marks a PNG and keeps its transparency', async () => {
    // Half see-through: the left half clear, the right half solid.
    const input = await make('cut.png', [
      '-f',
      'lavfi',
      '-i',
      'color=c=0x3a6ea5:size=800x600,format=rgba,geq=r=58:g=110:b=165:a=if(lt(X\\,400)\\,0\\,255)',
      '-frames:v',
      '1',
    ]);
    const output = join(dir, 'cut-marked.png');
    await burnMark(input, output, { seed: 'media_png' });
    expect(await facts(output)).toMatchObject({
      codec: 'png',
      width: 800,
      height: 600,
      pix_fmt: 'rgba',
    });
    const a = await frame(input, 0);
    const b = await frame(output, 0);
    expect(changed(a, b)).toBeGreaterThan(0.005);
    // What was clear and isn't under the mark stays clear.
    expect(b[3]).toBe(0);
  });

  it('keeps the codec family: ProRes stays ProRes HQ, VP9 stays VP9, JPEG stays JPEG', async () => {
    const prores = await make('hq.mov', [
      ...flat('640x360', 24, 2),
      '-c:v',
      'prores_ks',
      '-profile:v',
      '3',
    ]);
    const vp9 = await make('web.webm', [
      ...flat('480x480', 24, 2),
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
    ]);
    const jpeg = await make('still.jpg', [...flat('1024x768', 1, 1), '-frames:v', '1']);
    const cases: Array<[string, string, Partial<Facts>]> = [
      [prores, 'hq-marked.mov', { codec: 'prores', profile: 'HQ', pix_fmt: 'yuv422p10le' }],
      [vp9, 'web-marked.webm', { codec: 'vp9', width: 480, height: 480 }],
      [jpeg, 'still-marked.jpg', { codec: 'mjpeg', width: 1024, height: 768 }],
    ];
    for (const [input, name, expected] of cases) {
      const output = join(dir, name);
      await burnMark(input, output, { seed: `media_${name}` });
      expect(await facts(output)).toMatchObject(expected);
      expect(changed(await frame(input, 0), await frame(output, 0))).toBeGreaterThan(0.005);
    }
  });

  it('stops when cancelled', async () => {
    const input = await make('cancel.mp4', [
      ...flat('1280x720', 30, 20),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
    ]);
    const abort = new AbortController();
    const marking = burnMark(input, join(dir, 'cancel-marked.mp4'), {
      seed: 'media_cancel',
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 200);
    await expect(marking).rejects.toMatchObject({ code: 'cancelled' });
  });
});
