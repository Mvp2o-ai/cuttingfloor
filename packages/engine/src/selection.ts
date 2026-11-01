import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, maskAtTick, span } from '@cuttingfloor/core';
import { CfError, type StoredClip, type StoredMask, TICKS_PER_SECOND } from '@cuttingfloor/schema';
import { maskSpline } from './composite.ts';
import { BIN, heavySlot } from './exec.ts';
import { probe } from './probe.ts';

// Selections MLT cannot apply frame by frame, made on a clip's source picture before the render
// (as voice_denoise is for sound): a matte mask (another media's alpha or brightness as the
// selection) and mode fill (the selection painted over from its surroundings by LaMa,
// select-worker.ts). The result sits with the media and is reused while the media lives; the
// clip then plays it in place of the media.

const MODELS = process.env.CUTTINGFLOOR_MATTE_MODELS ?? '/usr/share/cuttingfloor/models';
const WORKER = fileURLToPath(new URL('./select-worker.ts', import.meta.url));
/** The fill model, named in each pass id so a model change makes a new copy. */
const FILL_MODEL = 'lama-c3c0c9e4';

export interface SelectionPass {
  /** Stable name of what the pass does, for the cached file. */
  id: string;
  mask: StoredMask;
  /** Width over height of the frame mask coordinates are fractions of (the sequence's). */
  frameAspect: number;
  /** fill: the source span the clip plays, seconds; frames outside it are left as they are. */
  range?: { from: number; until: number };
}

/**
 * A video clip's selection pass, when its mask needs one. `frameAspect` is the sequence's width
 * over height: mask coordinates are fractions of the clip's fitted frame, sequence-shaped.
 */
export function selectionPass(c: StoredClip, frameAspect: number): SelectionPass | undefined {
  if (c.type !== 'media' || c.kind !== 'video' || !c.mask) return undefined;
  const mask = c.mask;
  if (mask.shape !== 'matte' && mask.mode !== 'fill') return undefined;
  const range =
    mask.mode === 'fill'
      ? { from: c.in / TICKS_PER_SECOND, until: (c.in + span(c)) / TICKS_PER_SECOND }
      : undefined;
  const id = createHash('sha256')
    .update(
      canonicalJson({
        mask,
        range,
        aspect: mask.shape === 'matte' ? undefined : Math.round(frameAspect * 10_000),
        model: mask.mode === 'fill' ? FILL_MODEL : undefined,
      }),
    )
    .digest('hex')
    .slice(0, 20);
  return { id: `sel-${id}`, mask, frameAspect, ...(range ? { range } : {}) };
}

/** What a selection is made from and onto. */
export interface SelectionSource {
  path: string;
  width: number;
  height: number;
  image: boolean;
  alpha: boolean;
  fps: { num: number; den: number };
  duration: number;
}

export interface MatteSource {
  path: string;
  image: boolean;
  alpha: boolean;
}

const INPUT = ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe'];

/**
 * The selection outline as a polygon in picture pixels: the spline the render's rotoscoping
 * gets (fractions of the clip's fitted frame), each bezier segment flattened to 12 steps, then
 * mapped from the fitted frame to the picture inside it.
 */
function outlinePixels(
  mask: StoredMask,
  t: number,
  w: number,
  h: number,
  frameAspect: number,
): Array<[number, number]> {
  const spline = maskSpline(mask, maskAtTick(mask, t), { width: w, height: h, alpha: false }, t);
  const k = w / h / frameAspect;
  const kx = Math.min(1, k);
  const ky = Math.min(1, 1 / k);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < spline.length; i++) {
    const a = spline[i];
    const b = spline[(i + 1) % spline.length];
    if (!a || !b) continue;
    const [p0, p1, p2, p3] = [a[1], a[2], b[0], b[1]];
    for (let s = 0; s < 12; s++) {
      const u = s / 12;
      const v = 1 - u;
      const x = v ** 3 * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u ** 3 * p3[0];
      const y = v ** 3 * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u ** 3 * p3[1];
      pts.push([(0.5 + (x - 0.5) / kx) * w, (0.5 + (y - 0.5) / ky) * h]);
    }
  }
  return pts;
}

/** Fills a polygon (even-odd, pixel centres) into an 8-bit frame. */
function rasterize(poly: Array<[number, number]>, w: number, h: number, out: Uint8Array): void {
  out.fill(0);
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as [number, number];
      const b = poly[(i + 1) % poly.length] as [number, number];
      if (a[1] <= cy !== b[1] <= cy) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] as number) - 0.5));
      const to = Math.min(w - 1, Math.floor((xs[k + 1] as number) - 0.5));
      if (to >= from) out.fill(255, y * w + from, y * w + to + 1);
    }
  }
}

/** Selection filters that follow the raw selection: invert (or hide), softness, the span gate. */
function shapeFilters(pass: SelectionPass, src: SelectionSource): string[] {
  const m = pass.mask;
  const f: string[] = [];
  if (Boolean(m.invert) !== (m.mode === 'hide')) f.push('negate');
  // Feather is a fraction of the short side; rotoscoping blurs that far, a gaussian about half.
  const sigma = (m.feather ?? 0) * Math.min(src.width, src.height) * 0.5;
  if (sigma >= 0.5) f.push(`gblur=sigma=${sigma.toFixed(2)}`);
  if (pass.range) {
    const { from, until } = pass.range;
    f.push(
      `drawbox=c=black:t=fill:enable='lt(t\\,${from.toFixed(4)})+gte(t\\,${until.toFixed(4)})'`,
    );
  }
  return f;
}

const making = new Map<string, Promise<string>>();

/**
 * The source picture through the selection pass, in `dir`: made once, then reused, and two
 * renders asking at once share one run. Show and hide give ProRes 4444 with the selection as
 * alpha; fill gives ProRes 422 HQ with the selection painted in. A still gives a PNG.
 */
export function selectedPicture(
  src: SelectionSource,
  dir: string,
  pass: SelectionPass,
  matte: MatteSource | undefined,
  purpose: 'preview' | 'export',
  signal?: AbortSignal,
): Promise<string> {
  const dest = join(dir, `${purpose}-${pass.id}.${src.image ? 'png' : 'mov'}`);
  const going = making.get(dest);
  if (going) return going;
  const job = (async () => {
    const made = await stat(dest).then(
      (s) => s.size > 0,
      () => false,
    );
    if (made) return dest;
    await mkdir(dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp.${src.image ? 'png' : 'mov'}`;
    const release = await heavySlot(signal);
    try {
      // The file's own picture size: a preview proxy is smaller than the media.
      const v = (await probe(src.path, signal)).video;
      const upright = !v || v.rotation % 180 === 0;
      const sized = v
        ? { ...src, width: upright ? v.width : v.height, height: upright ? v.height : v.width }
        : src;
      await makeSelected(sized, pass, matte, tmp, signal);
      await rename(tmp, dest);
    } finally {
      release();
      await rm(tmp, { force: true });
    }
    return dest;
  })().finally(() => making.delete(dest));
  making.set(dest, job);
  return job;
}

async function makeSelected(
  src: SelectionSource,
  pass: SelectionPass,
  matte: MatteSource | undefined,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  const { width: w, height: h } = src;
  const rate = `${src.fps.num}/${src.fps.den}`;
  const fill = pass.mask.mode === 'fill';
  const isMatte = pass.mask.shape === 'matte';
  if (isMatte && !matte) throw new CfError('media_offline', 'The matte media is not available');
  // Input 1 is the selection: the matte media, or the shape drawn here frame by frame.
  const selection = isMatte
    ? [
        ...((matte as MatteSource).image ? ['-loop', '1'] : []),
        '-i',
        `file:${(matte as MatteSource).path}`,
      ]
    : ['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-framerate', rate, '-i', 'pipe:0'];
  const raw = isMatte
    ? [
        ...((matte as MatteSource).image ? [] : [`fps=${rate}`]),
        `scale=${w}:${h}:flags=bicubic`,
        ...((matte as MatteSource).alpha ? ['format=rgba', 'alphaextract'] : ['format=gray']),
        // A matte shorter than the clip's media holds its last frame.
        ...((matte as MatteSource).image ? [] : ['tpad=stop=-1:stop_mode=clone']),
      ]
    : ['format=gray'];
  const sel = [...raw, ...shapeFilters(pass, src)].join(',');
  // A source with its own transparency keeps it: the selection multiplies it.
  const merge = src.alpha
    ? `[1:v]${sel}[s];[0:v]format=rgba,split[c][a];[a]alphaextract[sa];[sa][s]blend=all_mode=multiply:shortest=1[m];[c][m]alphamerge=shortest=1,format=rgba[v]`
    : `[1:v]${sel}[s];[0:v]format=rgb24[c];[c][s]alphamerge=shortest=1,format=rgba[v]`;
  const first = [
    ...INPUT,
    ...(src.image ? ['-loop', '1'] : []),
    '-i',
    `file:${src.path}`,
    ...selection,
    '-filter_complex',
    merge,
    '-map',
    '[v]',
    ...(src.image ? ['-frames:v', '1'] : ['-fps_mode', 'passthrough']),
  ];
  const encode = (alpha: boolean) =>
    src.image
      ? ['-frames:v', '1', '-c:v', 'png', '-f', 'image2']
      : [
          '-c:v',
          'prores_ks',
          '-profile:v',
          alpha ? '4444' : '3',
          '-pix_fmt',
          alpha ? 'yuva444p10le' : 'yuv422p10le',
          '-an',
          '-f',
          'mov',
        ];
  const steps: Array<{ bin: string; args: string[] }> = fill
    ? [
        { bin: BIN.ffmpeg, args: [...first, '-f', 'rawvideo', '-'] },
        {
          bin: process.execPath,
          args: [WORKER, 'fill', join(MODELS, 'lama-512.onnx'), String(w), String(h)],
        },
        {
          bin: BIN.ffmpeg,
          args: [
            ...INPUT,
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgb24',
            '-s',
            `${w}x${h}`,
            '-framerate',
            rate,
            '-i',
            'pipe:0',
            ...encode(false),
            '-y',
            `file:${dest}`,
          ],
        },
      ]
    : [{ bin: BIN.ffmpeg, args: [...first, ...encode(true), '-y', `file:${dest}`] }];
  const frames = src.image ? 1 : Math.ceil(src.duration * (src.fps.num / src.fps.den)) + 2;
  await runPiped(
    steps,
    isMatte ? undefined : (write) => drawShape(pass, src, frames, write),
    signal,
  );
}

/** Writes the shape's selection for every source frame (fill: only inside its span). */
async function drawShape(
  pass: SelectionPass,
  src: SelectionSource,
  frames: number,
  write: (frame: Uint8Array) => Promise<boolean>,
): Promise<void> {
  const { width: w, height: h } = src;
  const frame = new Uint8Array(w * h);
  const animated = isAnimatedMask(pass.mask);
  let drawn = false;
  for (let i = 0; i < frames; i++) {
    const t = Math.round((i * TICKS_PER_SECOND * src.fps.den) / src.fps.num);
    if (animated || !drawn) {
      rasterize(outlinePixels(pass.mask, t, w, h, pass.frameAspect), w, h, frame);
      drawn = true;
    }
    if (!(await write(frame))) return;
  }
}

function isAnimatedMask(m: StoredMask): boolean {
  const keyed = (v: unknown) =>
    typeof v === 'object' &&
    v !== null &&
    'keyframes' in v &&
    (v as { keyframes: unknown[] }).keyframes.length > 1;
  return (
    keyed(m.x) ||
    keyed(m.y) ||
    keyed(m.width) ||
    keyed(m.height) ||
    keyed(m.rotation) ||
    keyed(m.points)
  );
}

/** Runs processes piped one into the next, `feed` writing into the first one's stdin. */
function runPiped(
  steps: Array<{ bin: string; args: string[] }>,
  feed: ((write: (frame: Uint8Array) => Promise<boolean>) => Promise<void>) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const procs = steps.map((s) =>
      spawn(s.bin, s.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, OMP_NUM_THREADS: String(Math.max(1, availableParallelism() >> 1)) },
      }),
    );
    for (let i = 0; i + 1 < procs.length; i++) {
      const from = procs[i];
      const to = procs[i + 1];
      if (from && to) from.stdout.pipe(to.stdin);
    }
    for (const p of procs) p.stdin.on('error', () => undefined);
    let errors = '';
    for (const p of procs)
      p.stderr.on('data', (d: Buffer) => {
        const text = d.toString();
        if (/^frames \d+\s*$/m.test(text)) return;
        errors = (errors + text).slice(-3000);
      });
    const head = procs[0];
    if (head) {
      if (feed) {
        let open = true;
        head.stdin.on('close', () => {
          open = false;
        });
        const write = (frame: Uint8Array) =>
          new Promise<boolean>((ok) => {
            if (!open || head.stdin.destroyed) return ok(false);
            if (head.stdin.write(frame)) ok(true);
            else head.stdin.once('drain', () => ok(open));
          });
        feed(write)
          .catch(() => undefined)
          .finally(() => head.stdin.end());
      } else head.stdin.end();
    }
    const kill = () => {
      for (const p of procs) p.kill('SIGKILL');
    };
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, 6 * 60 * 60_000);
    let closed = 0;
    let failed = false;
    const codes: Array<number | null> = [];
    for (const p of procs) {
      p.on('error', (e) => {
        if (failed) return;
        failed = true;
        kill();
        reject(new CfError('engine_error', `Could not start the selection pass: ${e.message}`));
      });
      p.on('close', (code) => {
        codes.push(code);
        closed += 1;
        if (closed < procs.length || failed) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', kill);
        if (signal?.aborted) return reject(new CfError('cancelled', 'Cancelled'));
        if (codes.every((c) => c === 0)) return resolve();
        reject(
          new CfError('engine_error', 'The selection pass failed', {
            detail: { stderr: errors.trim().split('\n').slice(-5).join('\n') },
          }),
        );
      });
    }
  });
}
