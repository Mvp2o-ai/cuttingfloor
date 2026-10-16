import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { CfError } from '@cuttingfloor/schema';
import { BIN } from './exec.ts';

// create.cutout: a subject cut out of its background. FFmpeg decodes frames at the matting size,
// a matting model writes an 8-bit matte per frame, and a second FFmpeg scales the mattes back up
// and merges them as alpha over the original frames: ProRes 4444 for video (sound kept), PNG for
// a picture. Two models: MODNet (Apache-2.0; people only, fast enough for video) in cf-vision,
// and BiRefNet lite (MIT; any subject, about a second a frame on a CPU) in cf-segment.

const MODELS = process.env.CUTTINGFLOOR_MATTE_MODELS ?? '/usr/share/cuttingfloor/models';

export type CutoutModel = 'modnet' | 'birefnet';

/** The model names kept in recipes, so a model change makes new media. */
export const CUTOUT_MODELS: Record<CutoutModel, string> = {
  modnet: 'modnet-fa2fa546',
  birefnet: 'birefnet-lite-de15b22b',
};

/** BiRefNet's input: the picture fitted within 1024 (it resizes to 1024 × 1024 itself). */
export function segmentSize(width: number, height: number) {
  const k = Math.min(1, 1024 / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(width), h: even(height) };
}

/** The fixed MODNet size nearest the picture's shape. */
export function matteSize(width: number, height: number) {
  const r = width / height;
  if (r > 1.3) return { name: 'landscape', w: 512, h: 288 };
  if (r < 0.77) return { name: 'portrait', w: 288, h: 512 };
  return { name: 'square', w: 512, h: 512 };
}

export interface CutoutSource {
  file: string;
  width: number;
  height: number;
  image: boolean;
  /** Frame rate as num/den (video). */
  fps?: { num: number; den: number };
  audio: boolean;
  /** Seconds, for progress. */
  duration?: number | null;
}

export function cutout(
  src: CutoutSource,
  dest: string,
  options: {
    model?: CutoutModel;
    smooth?: number;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  } = {},
): Promise<void> {
  const model = options.model ?? 'modnet';
  const size =
    model === 'birefnet' ? segmentSize(src.width, src.height) : matteSize(src.width, src.height);
  const smooth = String(src.image ? 0 : (options.smooth ?? 0.3));
  const rate = src.fps ? `${src.fps.num}/${src.fps.den}` : '25';
  const input = ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe'];
  const decode = [
    ...input,
    '-i',
    `file:${src.file}`,
    '-map',
    '0:v:0',
    '-vf',
    `scale=${size.w}:${size.h}:flags=area,format=bgr24`,
    '-f',
    'rawvideo',
    '-',
  ];
  const merge = [
    ...input,
    '-stats_period',
    '0.5',
    '-progress',
    'pipe:2',
    '-y',
    '-i',
    `file:${src.file}`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-s',
    `${size.w}x${size.h}`,
    '-framerate',
    rate,
    '-i',
    'pipe:0',
    '-filter_complex',
    `[1:v]scale=${src.width}:${src.height}:flags=bicubic,format=gray[a];[0:v:0][a]alphamerge[v]`,
    '-map',
    '[v]',
    ...(src.image
      ? ['-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'image2', '-c:v', 'png']
      : [
          ...(src.audio ? ['-map', '0:a:0?', '-c:a', 'pcm_s16le'] : []),
          '-c:v',
          'prores_ks',
          '-profile:v',
          '4444',
          '-pix_fmt',
          'yuva444p10le',
          '-shortest',
        ]),
    dest,
  ];
  return new Promise((resolve, reject) => {
    const ff = spawn(BIN.ffmpeg, decode, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cv =
      model === 'birefnet'
        ? spawn(
            BIN.segment,
            [
              `${MODELS}/birefnet-lite.onnx`,
              String(size.w),
              String(size.h),
              smooth,
              String(Math.max(1, Math.floor(availableParallelism() / 2))),
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          )
        : spawn(
            BIN.vision,
            [
              'matte',
              `${MODELS}/modnet-${(size as ReturnType<typeof matteSize>).name}.onnx`,
              String(size.w),
              String(size.h),
              smooth,
            ],
            { stdio: ['pipe', 'pipe', 'pipe'] },
          );
    const out = spawn(BIN.ffmpeg, merge, { stdio: ['pipe', 'ignore', 'pipe'] });
    ff.stdout.pipe(cv.stdin);
    cv.stdout.pipe(out.stdin);
    for (const s of [cv.stdin, out.stdin]) s.on('error', () => undefined);
    let errors = '';
    const keep = (d: Buffer) => {
      errors = (errors + d.toString()).slice(-3000);
    };
    ff.stderr.on('data', keep);
    cv.stderr.on('data', keep);
    out.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      const t = /out_time_us=(\d+)/.exec(text);
      if (t && src.duration) options.onProgress?.(Math.min(1, Number(t[1]) / 1e6 / src.duration));
      if (!/^\w+=/m.test(text)) keep(d);
    });
    const kill = () => {
      for (const p of [ff, cv, out]) p.kill('SIGKILL');
    };
    const timer = setTimeout(kill, 4 * 60 * 60_000);
    options.signal?.addEventListener('abort', kill, { once: true });
    const codes: Array<number | null> = [];
    let killed = false;
    let closed = 0;
    for (const p of [ff, cv, out]) {
      p.on('error', (e) => {
        kill();
        reject(new CfError('engine_error', `Could not start the cut-out: ${e.message}`));
      });
      p.on('close', (code, sig) => {
        codes.push(code);
        if (p === cv && (sig === 'SIGKILL' || code === 137)) killed = true;
        closed += 1;
        if (closed < 3) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', kill);
        if (options.signal?.aborted) return reject(new CfError('cancelled', 'Cancelled'));
        if (codes.every((c) => c === 0)) return resolve();
        if (killed) {
          return reject(
            new CfError('limit_exceeded', 'The matting model ran out of memory', {
              hint:
                model === 'birefnet'
                  ? 'subject any (BiRefNet) needs about 3 GB free: give Docker more memory (Docker Desktop: Settings, Resources), or use subject people'
                  : 'Give Docker more memory, or cut out a shorter or smaller clip',
            }),
          );
        }
        reject(
          new CfError('engine_error', 'The cut-out failed', {
            detail: { stderr: errors.trim().split('\n').slice(-5).join('\n') },
          }),
        );
      });
    }
  });
}
