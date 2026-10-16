import { spawn } from 'node:child_process';
import { CfError } from '@cuttingfloor/schema';
import { BIN } from './exec.ts';

// create.cutout: people cut out of their background. FFmpeg decodes frames at the matting size,
// cf-vision runs MODNet (Apache-2.0) on each and writes an 8-bit matte, and a second FFmpeg
// scales the mattes back up and merges them as alpha over the original frames: ProRes 4444 for
// video (sound kept), PNG for a picture.

const MODELS = process.env.CUTTINGFLOOR_MATTE_MODELS ?? '/usr/share/cuttingfloor/models';

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
  options: { smooth?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<void> {
  const size = matteSize(src.width, src.height);
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
    const cv = spawn(
      BIN.vision,
      [
        'matte',
        `${MODELS}/modnet-${size.name}.onnx`,
        String(size.w),
        String(size.h),
        String(src.image ? 0 : (options.smooth ?? 0.3)),
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
    let closed = 0;
    for (const p of [ff, cv, out]) {
      p.on('error', (e) => {
        kill();
        reject(new CfError('engine_error', `Could not start the cut-out: ${e.message}`));
      });
      p.on('close', (code) => {
        codes.push(code);
        closed += 1;
        if (closed < 3) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', kill);
        if (options.signal?.aborted) return reject(new CfError('cancelled', 'Cancelled'));
        if (codes.every((c) => c === 0)) return resolve();
        reject(
          new CfError('engine_error', 'The cut-out failed', {
            detail: { stderr: errors.trim().split('\n').slice(-5).join('\n') },
          }),
        );
      });
    }
  });
}
