import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoredClip, StoredEffect } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';

// Effects MLT cannot run frame by frame (FFmpeg's arnndn hands back sound in its own 10 ms
// blocks, which MLT's avfilter bridge refuses), applied to a clip's whole source sound before
// the render. The cleaned copy sits with the media and is reused while the media lives.

/** The RNNoise models (GregorR/rnnoise-models, pinned by SHA-256 in the image). */
export const DENOISE_MODELS =
  process.env.CUTTINGFLOOR_DENOISE_MODELS ?? '/usr/share/cuttingfloor/models/rnnoise';
const RNNOISE = { voice: 'bd.rnnn', speech: 'sh.rnnn' } as const;
/** RNNoise answers one 480-sample block late; the copy is moved back by that. */
const RNNOISE_DELAY = 480;

export interface SourcePass {
  /** Stable name of what the pass does, for the cached file. */
  id: string;
  /** FFmpeg audio filters. */
  filter: string;
}

function passOf(e: StoredEffect): SourcePass | undefined {
  if (e.enabled === false || e.name !== 'voice_denoise') return undefined;
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

/** The key a clip's source is found under in a render's sources: its media, or a cleaned copy. */
export function sourceKey(c: StoredClip): string {
  if (c.type !== 'media') return '';
  const passes = clipPasses(c);
  return passes.length ? `${c.media_id}#${passes.map((p) => p.id).join('+')}` : c.media_id;
}

const making = new Map<string, Promise<string>>();

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
    const tmp = `${dest}.${process.pid}.tmp.wav`;
    try {
      await run(
        BIN.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-i',
          input,
          '-vn',
          '-map',
          '0:a:0',
          '-af',
          passes.map((p) => p.filter).join(','),
          '-c:a',
          'pcm_s24le',
          '-y',
          tmp,
        ],
        { heavy: true, timeoutMs: 30 * 60_000, ...(signal ? { signal } : {}) },
      );
      await rename(tmp, dest);
    } finally {
      await rm(tmp, { force: true });
    }
    return dest;
  })().finally(() => making.delete(dest));
  making.set(dest, job);
  return job;
}
