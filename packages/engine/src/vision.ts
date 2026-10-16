import { spawn } from 'node:child_process';
import { CfError } from '@cuttingfloor/schema';
import { BIN } from './exec.ts';

// Faces and tracking for media.analyze: FFmpeg decodes frames at a working size and pipes them
// into cf-vision (OpenCV's YuNet detector and CSRT tracker, tools/vision), which answers with
// one JSON line per frame. Results come back in 0–1 frame units and media seconds.

export const FACE_MODEL =
  process.env.CUTTINGFLOOR_FACE_MODEL ??
  '/usr/share/cuttingfloor/models/face_detection_yunet_2023mar.onnx';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceFrame {
  /** Seconds in the media. */
  time: number;
  faces: Array<Box & { score: number }>;
}

export interface Faces {
  /** Frames sampled per second. */
  rate: number;
  frames: FaceFrame[];
  /** The centre of the most prominent face over time, smoothed: where to keep the picture. */
  focus: Array<{ time: number; x: number; y: number }>;
}

export interface TrackPoint extends Box {
  time: number;
  found: boolean;
}

const LIMIT_MS = 60 * 60_000;

/** Even working size with the media's aspect and the given long edge. */
function workingSize(width: number, height: number, longEdge: number): { w: number; h: number } {
  const k = longEdge / Math.max(width, height);
  return {
    w: Math.max(2, Math.round((width * k) / 2) * 2),
    h: Math.max(2, Math.round((height * k) / 2) * 2),
  };
}

/** Runs FFmpeg into cf-vision and hands back each JSON line. */
function pipeline(
  ffmpegArgs: string[],
  visionArgs: string[],
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(BIN.ffmpeg, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cv = spawn(BIN.vision, visionArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    ff.stdout.pipe(cv.stdin);
    cv.stdin.on('error', () => undefined);
    let errors = '';
    ff.stderr.on('data', (d: Buffer) => {
      errors = (errors + d.toString()).slice(-2000);
    });
    cv.stderr.on('data', (d: Buffer) => {
      errors = (errors + d.toString()).slice(-2000);
    });
    let pending = '';
    cv.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) onLine(l);
    });
    const kill = () => {
      ff.kill('SIGKILL');
      cv.kill('SIGKILL');
    };
    const timer = setTimeout(kill, LIMIT_MS);
    signal?.addEventListener('abort', kill, { once: true });
    let ffCode: number | null = null;
    ff.on('close', (code) => {
      ffCode = code;
    });
    cv.on('error', (e) =>
      reject(new CfError('engine_error', `Could not start cf-vision: ${e.message}`)),
    );
    cv.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) reject(new CfError('cancelled', 'Cancelled'));
      else if (code === 0 && (ffCode === 0 || ffCode === null)) resolve();
      else
        reject(
          new CfError('engine_error', `Frame analysis failed (${code ?? 'killed'})`, {
            detail: { stderr: errors.trim().split('\n').slice(-4).join('\n') },
          }),
        );
    });
  });
}

const decode = (file: string, start: number, fps: number, w: number, h: number, until?: number) => [
  '-hide_banner',
  '-nostdin',
  '-v',
  'error',
  '-protocol_whitelist',
  'file',
  ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
  '-i',
  `file:${file}`,
  ...(until !== undefined ? ['-t', Math.max(0.04, until - start).toFixed(3)] : []),
  '-an',
  '-vf',
  `fps=${fps},scale=${w}:${h}:flags=area,format=bgr24`,
  '-f',
  'rawvideo',
  '-',
];

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Faces in a video, sampled `rate` times a second. */
export async function detectFaces(
  file: string,
  size: { width: number; height: number },
  options: { rate?: number; signal?: AbortSignal } = {},
): Promise<Faces> {
  const rate = options.rate ?? 5;
  const { w, h } = workingSize(size.width, size.height, 640);
  const frames: FaceFrame[] = [];
  await pipeline(
    decode(file, 0, rate, w, h),
    ['faces', FACE_MODEL, String(w), String(h)],
    (line) => {
      const found = JSON.parse(line) as number[][];
      frames.push({
        time: r4(frames.length / rate),
        faces: found.map(([x = 0, y = 0, bw = 0, bh = 0, score = 0]) => ({
          x: r4(x / w),
          y: r4(y / h),
          w: r4(bw / w),
          h: r4(bh / h),
          score,
        })),
      });
    },
    options.signal,
  );
  // Focus: the largest face's centre, smoothed so a reframe doesn't jitter; held through gaps.
  const focus: Faces['focus'] = [];
  let x = 0.5;
  let y = 0.5;
  let seen = false;
  for (const f of frames) {
    const big = [...f.faces].sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (big) {
      const cx = big.x + big.w / 2;
      const cy = big.y + big.h / 2;
      x = seen ? x + 0.35 * (cx - x) : cx;
      y = seen ? y + 0.35 * (cy - y) : cy;
      seen = true;
    }
    focus.push({ time: f.time, x: r4(x), y: r4(y) });
  }
  return { rate, frames, focus };
}

/** Follows a region from `start` seconds, frame by frame, until `until` (default: the end). */
export async function trackRegion(
  file: string,
  size: { width: number; height: number },
  options: { start: number; box: Box; until?: number; rate: number; signal?: AbortSignal },
): Promise<TrackPoint[]> {
  const { w, h } = workingSize(size.width, size.height, 640);
  const px = (v: number, of: number) => Math.round(v * of);
  const points: TrackPoint[] = [];
  await pipeline(
    decode(file, options.start, options.rate, w, h, options.until),
    [
      'track',
      String(w),
      String(h),
      String(px(options.box.x, w)),
      String(px(options.box.y, h)),
      String(Math.max(2, px(options.box.w, w))),
      String(Math.max(2, px(options.box.h, h))),
    ],
    (line) => {
      const [x = 0, y = 0, bw = 0, bh = 0, ok = 0] = JSON.parse(line) as number[];
      points.push({
        time: r4(options.start + points.length / options.rate),
        x: r4(x / w),
        y: r4(y / h),
        w: r4(bw / w),
        h: r4(bh / h),
        found: ok === 1,
      });
    },
    options.signal,
  );
  return points;
}
