import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';
import { BIN, KILL_SETTLE_MS, killTree, spawnEngine } from './exec.ts';

// create.cutout: a subject cut out of its background. FFmpeg decodes frames at the matting size,
// a matting model writes an 8-bit matte per frame, and a second FFmpeg scales the mattes back up
// and merges them as alpha over the original frames: ProRes 4444 for video (sound kept), PNG for
// a picture. Two models: MODNet (Apache-2.0; people only, fast enough for video) in cf-vision,
// and BiRefNet lite (MIT; any subject, about a second a frame on a CPU) in cf-segment. With a
// region (a box and/or points at a moment), EdgeTAM (Apache-2.0) finds that one item and follows
// it through the video (select-worker.ts); its mattes go to a file first, then merge the same way.

const MODELS = process.env.CUTTINGFLOOR_MATTE_MODELS ?? '/usr/share/cuttingfloor/models';

export type CutoutModel = 'modnet' | 'birefnet' | 'edgetam';

/** The model names kept in recipes, so a model change makes new media. */
export const CUTOUT_MODELS: Record<CutoutModel, string> = {
  modnet: 'modnet-fa2fa546',
  birefnet: 'birefnet-lite-de15b22b',
  edgetam: 'edgetam-8ca3d3e4',
};

const WORKER = fileURLToPath(new URL('./select-worker.ts', import.meta.url));

/** What to cut out with model edgetam: a box and/or points on the frame at `frame`. */
export interface CutoutRegion {
  frame: number;
  box?: { x: number; y: number; w: number; h: number };
  points?: Array<{ x: number; y: number; keep: boolean }>;
}

/** BiRefNet's input: the picture fitted within 1024 (it resizes to 1024 × 1024 itself). */
export function segmentSize(width: number, height: number) {
  const k = Math.min(1, 1024 / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { w: even(width), h: even(height) };
}

const INPUT = ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe'];

/** FFmpeg arguments that merge `size` mattes (8-bit, from `mattes`) as alpha over the source. */
function mergeArgs(
  src: CutoutSource,
  size: { w: number; h: number },
  mattes: string,
  dest: string,
): string[] {
  const rate = src.fps ? `${src.fps.num}/${src.fps.den}` : '25';
  return [
    ...INPUT,
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
    mattes,
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
    region?: CutoutRegion;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  } = {},
): Promise<void> {
  const model = options.model ?? 'modnet';
  if (model === 'edgetam') {
    if (!options.region) throw new CfError('bad_request', 'A region is needed to follow an item');
    return followCutout(src, dest, options.region, options);
  }
  const size =
    model === 'birefnet' ? segmentSize(src.width, src.height) : matteSize(src.width, src.height);
  const smooth = String(src.image ? 0 : (options.smooth ?? 0.3));
  const decode = [
    ...INPUT,
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
  const merge = mergeArgs(src, size, 'pipe:0', dest);
  return new Promise((resolve, reject) => {
    const ff = spawnEngine(BIN.ffmpeg, decode, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cv =
      model === 'birefnet'
        ? spawnEngine(
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
        : spawnEngine(
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
    const out = spawnEngine(BIN.ffmpeg, merge, { stdio: ['pipe', 'ignore', 'pipe'] });
    // Minutes of model work: anything quicker on this server goes first. The model's threads
    // start after it loads, so they take this priority too.
    for (const p of [ff, cv, out]) {
      try {
        if (p.pid) setPriority(p.pid, 10);
      } catch {
        // Already gone, or not allowed here: it runs at the normal priority.
      }
    }
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
      for (const p of [ff, cv, out]) killTree(p);
    };
    const timer = setTimeout(kill, 4 * 60 * 60_000);
    // A cancel answers even if a pipe stays open after the kill.
    const abort = () => {
      kill();
      setTimeout(() => reject(new CfError('cancelled', 'Cancelled')), KILL_SETTLE_MS).unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
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
        options.signal?.removeEventListener('abort', abort);
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

/** Runs processes piped one into the next; rejects with the last lines any of them wrote. */
function pipeline(
  steps: Array<{ bin: string; args: string[] }>,
  options: {
    signal?: AbortSignal | undefined;
    onLine?: (line: string) => void;
    timeoutMs: number;
    what: string;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const procs = steps.map((s, i) =>
      spawnEngine(s.bin, s.args, {
        stdio: [i === 0 ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      }),
    );
    for (const p of procs) {
      try {
        if (p.pid) setPriority(p.pid, 10);
      } catch {
        // Already gone, or not allowed here: it runs at the normal priority.
      }
    }
    for (let i = 0; i + 1 < procs.length; i++) {
      const from = procs[i];
      const to = procs[i + 1];
      if (from?.stdout && to?.stdin) {
        from.stdout.pipe(to.stdin);
        to.stdin.on('error', () => undefined);
      }
    }
    let out = '';
    procs[procs.length - 1]?.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    let errors = '';
    for (const p of procs) {
      let pending = '';
      p.stderr?.on('data', (d: Buffer) => {
        pending += d.toString();
        const lines = pending.split(/\r|\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          if (/^progress [\d.]+$/.test(line) || /^\w+=/.test(line)) options.onLine?.(line);
          else errors = `${errors}\n${line}`.slice(-3000);
        }
      });
    }
    const kill = () => {
      for (const p of procs) killTree(p);
    };
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    const codes: Array<number | null> = [];
    let oom = false;
    let failed = false;
    for (const p of procs) {
      p.on('error', (e) => {
        if (failed) return;
        failed = true;
        kill();
        reject(new CfError('engine_error', `Could not start the ${options.what}: ${e.message}`));
      });
      p.on('close', (code, sig) => {
        codes.push(code);
        if (sig === 'SIGKILL' || code === 137) oom = true;
        if (codes.length < procs.length || failed) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', kill);
        if (options.signal?.aborted) return reject(new CfError('cancelled', 'Cancelled'));
        if (codes.every((c) => c === 0)) return resolve(out);
        if (oom) {
          return reject(
            new CfError('limit_exceeded', `The ${options.what} ran out of memory or time`, {
              hint: 'Give Docker more memory (Docker Desktop: Settings, Resources), or use a shorter clip',
            }),
          );
        }
        reject(
          new CfError('engine_error', `The ${options.what} failed`, {
            detail: { stderr: errors.trim().split('\n').slice(-5).join('\n') },
          }),
        );
      });
    }
  });
}

/**
 * The item a region marks, followed through the video: EdgeTAM writes a matte per frame to a
 * file (frames before the region's moment are tracked backwards from it), then FFmpeg merges
 * them as alpha over the original frames.
 */
async function followCutout(
  src: CutoutSource,
  dest: string,
  region: CutoutRegion,
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
): Promise<void> {
  const size = segmentSize(src.width, src.height);
  const tmp = await mkdtemp(join(dirname(dest), 'follow-'));
  try {
    const prompt = join(tmp, 'prompt.json');
    const mattes = join(tmp, 'mattes.gray');
    await writeFile(
      prompt,
      JSON.stringify({
        ...(region.box ? { box: region.box } : {}),
        ...(region.points ? { points: region.points } : {}),
      }),
    );
    const decode = [
      ...INPUT,
      '-i',
      `file:${src.file}`,
      '-map',
      '0:v:0',
      '-vf',
      'scale=1024:1024:flags=area,format=rgb24',
      '-f',
      'rawvideo',
      '-',
    ];
    const frame = src.image ? 0 : region.frame;
    await pipeline(
      [
        { bin: BIN.ffmpeg, args: decode },
        {
          bin: process.execPath,
          args: [
            WORKER,
            'track',
            join(MODELS, 'edgetam'),
            String(frame),
            prompt,
            mattes,
            tmp,
            String(size.w),
            String(size.h),
          ],
        },
      ],
      {
        signal: options.signal,
        timeoutMs: 4 * 60 * 60_000,
        what: 'item tracking',
        onLine: (line) => {
          const m = /^progress ([\d.]+)$/.exec(line);
          if (m) options.onProgress?.(0.9 * Number(m[1]));
        },
      },
    );
    await rm(join(tmp, 'before.rgb'), { force: true });
    await pipeline([{ bin: BIN.ffmpeg, args: mergeArgs(src, size, `file:${mattes}`, dest) }], {
      signal: options.signal,
      timeoutMs: 60 * 60_000,
      what: 'cut-out',
      onLine: (line) => {
        const t = /out_time_us=(\d+)/.exec(line);
        if (t && src.duration)
          options.onProgress?.(0.9 + 0.1 * Math.min(1, Number(t[1]) / 1e6 / src.duration));
      },
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
