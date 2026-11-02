import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type InBetween, inBetween } from '@cuttingfloor/core';
import type { FrameRate, StoredClip, StoredEffect } from '@cuttingfloor/schema';
import { tapsFor } from './dereverb.ts';
import { BIN, run } from './exec.ts';
import { selectionPass } from './selection.ts';

const DEREVERB_WORKER = fileURLToPath(new URL('./dereverb-worker.ts', import.meta.url));

// Effects MLT cannot run frame by frame (FFmpeg's arnndn hands back sound in its own 10 ms
// blocks, which MLT's avfilter bridge refuses), applied to a clip's whole source sound before
// the render. The cleaned copy sits with the media and is reused while the media lives.

/** The RNNoise models (GregorR/rnnoise-models, pinned by SHA-256 in the image). */
export const DENOISE_MODELS =
  process.env.CUTTINGFLOOR_DENOISE_MODELS ?? '/usr/share/cuttingfloor/models/rnnoise';
const RNNOISE = { voice: 'bd.rnnn', speech: 'sh.rnnn' } as const;
/** RNNoise answers one 480-sample block late; the copy is moved back by that. */
const RNNOISE_DELAY = 480;

export type SourcePass =
  | {
      /** Stable name of what the pass does, for the cached file. */
      id: string;
      /** FFmpeg audio filters. */
      filter: string;
    }
  | {
      id: string;
      /** Room echo removal (dereverb-worker.ts) at 48 kHz stereo. */
      dereverb: { taps: number; mix: number };
    };

function passOf(e: StoredEffect): SourcePass | undefined {
  if (e.enabled === false) return undefined;
  if (e.name === 'dereverb') {
    const reach = typeof e.params.reach_ms === 'number' ? e.params.reach_ms : 250;
    const mix = typeof e.params.mix === 'number' ? e.params.mix : 1;
    const taps = tapsFor(reach, 48_000);
    return { id: `dereverb-${taps}-${mix}`, dereverb: { taps, mix } };
  }
  if (e.name !== 'voice_denoise') return undefined;
  const keep = e.params.keep === 'speech' ? 'speech' : 'voice';
  const mix = typeof e.params.mix === 'number' ? e.params.mix : 1;
  return {
    id: `denoise-${keep}-${mix}`,
    filter: [
      'aresample=48000',
      `arnndn=m=${join(DENOISE_MODELS, RNNOISE[keep])}:mix=${mix}`,
      `atrim=start_sample=${RNNOISE_DELAY}`,
      'asetpts=PTS-STARTPTS',
      `apad=pad_len=${RNNOISE_DELAY}`,
    ].join(','),
  };
}

/** A clip's source passes, in order; empty for most clips. */
export function clipPasses(c: StoredClip): SourcePass[] {
  if (c.type !== 'media' || c.kind !== 'audio') return [];
  return (c.effects ?? []).flatMap((e) => passOf(e) ?? []);
}

/**
 * The key a clip's source is found under in a render's sources: its media, a cleaned copy of its
 * sound, its picture with in-between frames made at the sequence rate, and/or that picture
 * through a selection pass (selection.ts; mask coordinates follow the sequence's shape).
 */
export function sourceKey(
  c: StoredClip,
  sequence?: { fps: FrameRate; width: number; height: number },
): string {
  if (c.type !== 'media') return '';
  const between = sequence ? inBetween(c, sequence.fps) : undefined;
  const selection = sequence ? selectionPass(c, sequence.width / sequence.height) : undefined;
  if (between || selection) {
    // The selection is made on the source first; in-between frames are made from that.
    const parts = [...(selection ? [selection.id] : []), ...(between ? [betweenId(between)] : [])];
    return [c.media_id, ...parts].join('#');
  }
  const passes = clipPasses(c);
  return passes.length ? `${c.media_id}#${passes.map((p) => p.id).join('+')}` : c.media_id;
}

// v2: copies made before it stopped a fraction of the way through their source.
const betweenId = (b: InBetween) =>
  `v2-${b.mode}-${b.fps}-at${Math.round(b.sequence * 1000) / 1000}-${b.from}-${b.to}`;

const making = new Map<string, Promise<string>>();
const LONG = { heavy: true, timeoutMs: 60 * 60_000 } as const;

/**
 * Runs the passes over `input`'s first sound into `${tmp}.wav` (24-bit PCM): runs of FFmpeg
 * filters in one FFmpeg each, room echo removal through its worker, each step's sound feeding
 * the next.
 */
async function runPasses(
  input: string,
  tmp: string,
  passes: SourcePass[],
  signal?: AbortSignal,
): Promise<void> {
  const sig = signal ? { signal } : {};
  let current = input;
  let step = 0;
  for (let i = 0; i < passes.length; ) {
    const last = (j: number) => j >= passes.length;
    const pass = passes[i] as SourcePass;
    // Alternate two scratch files; the last step writes the result.
    const next = (done: boolean) => (done ? `${tmp}.wav` : `${tmp}.${step++ % 2 ? 'b' : 'a'}.wav`);
    if ('filter' in pass) {
      const filters: string[] = [];
      while (i < passes.length && 'filter' in (passes[i] as SourcePass)) {
        filters.push((passes[i] as { filter: string }).filter);
        i++;
      }
      const out = next(last(i));
      await run(
        BIN.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-i',
          current,
          '-vn',
          '-map',
          '0:a:0',
          '-af',
          filters.join(','),
          '-c:a',
          'pcm_s24le',
          '-y',
          out,
        ],
        { ...LONG, ...sig },
      );
      current = out;
      continue;
    }
    i++;
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        current,
        '-vn',
        '-map',
        '0:a:0',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-f',
        'f32le',
        '-y',
        `${tmp}.in.f32`,
      ],
      { ...LONG, ...sig },
    );
    await run(
      process.execPath,
      [
        DEREVERB_WORKER,
        `${tmp}.in.f32`,
        `${tmp}.out.f32`,
        '2',
        '48000',
        String(pass.dereverb.taps),
        String(pass.dereverb.mix),
      ],
      { ...LONG, ...sig },
    );
    const out = next(last(i));
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-f',
        'f32le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-i',
        `${tmp}.out.f32`,
        '-c:a',
        'pcm_s24le',
        '-y',
        out,
      ],
      { ...LONG, ...sig },
    );
    current = out;
  }
}

/**
 * The sound of `input` through the passes, as a WAV in `dir`: made once, then reused, and two
 * renders asking at once share one run.
 */
export function passedAudio(
  input: string,
  dir: string,
  passes: SourcePass[],
  signal?: AbortSignal,
): Promise<string> {
  const dest = join(dir, `${passes.map((p) => p.id).join('+')}.wav`);
  const going = making.get(dest);
  if (going) return going;
  const job = (async () => {
    const made = await stat(dest).then(
      (s) => s.size > 0,
      () => false,
    );
    if (made) return dest;
    await mkdir(dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      await runPasses(input, tmp, passes, signal);
      await rename(`${tmp}.wav`, dest);
    } finally {
      for (const ext of ['.wav', '.a.wav', '.b.wav', '.in.f32', '.out.f32'])
        await rm(`${tmp}${ext}`, { force: true });
    }
    return dest;
  })().finally(() => making.delete(dest));
  making.set(dest, job);
  return job;
}

// In-between frames: a clip that shows fewer new frames a second than the sequence plays (slow
// motion, or a low frame rate) can play a copy of its stretch of source made at a higher rate,
// by blending neighbouring frames (FFmpeg framerate) or from the motion between them (FFmpeg
// minterpolate). Both need the frames either side, which MLT does not give a filter.

const BETWEEN_FILTER: Record<InBetween['mode'], (fps: number) => string> = {
  blend: (fps) => `framerate=fps=${fps}:interp_start=0:interp_end=255`,
  motion: (fps) => `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
};

/** Seconds of source at the start of a copy over `from`: the first source frame from there. */
export function betweenStart(between: InBetween, source: FrameRate): number {
  const k = Math.ceil((between.from * source.num) / source.den - 1e-6);
  return (k * source.den) / source.num;
}

/** Where a clip's in-between copy is kept in `dir`. */
export function betweenFile(
  dir: string,
  between: InBetween,
  purpose: 'preview' | 'export',
): string {
  return join(dir, `${betweenId(between)}.${purpose}.mov`);
}

/** Frames an in-between copy holds. */
export function betweenFrames(between: InBetween, source: FrameRate): number {
  return Math.max(1, Math.ceil((between.to - betweenStart(between, source)) * between.fps));
}

/**
 * The clip's stretch of `input` with in-between frames, as a video in `dir`: made once, then
 * reused, and two renders asking at once share one run. `offset` is the source second its first
 * frame shows.
 */
export function betweenPicture(
  input: string,
  dir: string,
  between: InBetween,
  options: {
    /** The source's own frame rate, which places the first frame. */
    source: FrameRate;
    /** previews read a proxy, exports the full picture; each has its own copy. */
    purpose: 'preview' | 'export';
    alpha: boolean;
    signal?: AbortSignal;
    /** Called with the share of its frames made (0–1). */
    onProgress?: (fraction: number) => void;
  },
): Promise<{ path: string; offset: number; stretch: number }> {
  const offset = betweenStart(between, options.source);
  // MLT reads a file a frame per sequence frame, so the copy's frames are laid out at the
  // sequence rate: a second of source lasts `stretch` seconds in it.
  const stretch = between.fps / between.sequence;
  const dest = betweenFile(dir, between, options.purpose);
  const total = betweenFrames(between, options.source);
  const going = making.get(dest);
  if (going) return going.then((path) => ({ path, offset, stretch }));
  const job = (async () => {
    const made = await stat(dest).then(
      (s) => s.size > 0,
      () => false,
    );
    if (made) return dest;
    await mkdir(dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp.mov`;
    // The copy's first frame is the source frame at `offset`: seeking a hair before it keeps
    // that frame, and its timestamps start at 0 there.
    const codec = options.alpha
      ? ['-c:v', 'png', '-pix_fmt', 'rgba']
      : options.purpose === 'preview'
        ? ['-c:v', 'mjpeg', '-q:v', '4', '-pix_fmt', 'yuvj422p']
        : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '12', '-g', '24', '-pix_fmt', 'yuv420p'];
    try {
      await run(
        BIN.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-ss',
          String(Math.max(0, offset - 0.001)),
          // Read this much source; as an output limit it would cut the slowed copy short.
          '-t',
          String(between.to - offset),
          '-i',
          input,
          '-map',
          '0:v:0',
          '-an',
          '-vf',
          `setpts=PTS-STARTPTS,${BETWEEN_FILTER[between.mode](between.fps)},setpts=N/(${between.sequence}*TB)`,
          '-r',
          String(between.sequence),
          '-progress',
          'pipe:2',
          '-stats_period',
          '1',
          ...codec,
          '-f',
          'mov',
          '-y',
          tmp,
        ],
        {
          heavy: true,
          timeoutMs: 60 * 60_000,
          ...(options.signal ? { signal: options.signal } : {}),
          onLine: (line) => {
            const f = /^frame=(\d+)/.exec(line);
            if (f) options.onProgress?.(Math.min(1, Number(f[1]) / total));
          },
        },
      );
      await rename(tmp, dest);
    } finally {
      await rm(tmp, { force: true });
    }
    return dest;
  })().finally(() => making.delete(dest));
  making.set(dest, job);
  return job.then((path) => ({ path, offset, stretch }));
}
