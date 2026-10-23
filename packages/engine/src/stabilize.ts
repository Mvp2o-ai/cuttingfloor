import { rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { BIN, run } from './exec.ts';

// Video stabilisation with vid.stab, in two passes over the whole file: vidstabdetect measures
// the camera motion between frames, vidstabtransform moves each frame against the smoothed
// path. Neither pass can run per frame inside MLT (its vidstab filter only writes its analysis
// after playing the clip through), so a steadied copy is made as new media.

export interface StabilizeOptions {
  shakiness: number;
  smoothing: number;
  tripod: boolean;
  edges: 'zoom' | 'adaptive_zoom' | 'black' | 'keep';
  /** Seconds, for progress. */
  duration: number | null;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

const EDGES: Record<StabilizeOptions['edges'], string> = {
  zoom: 'optzoom=1',
  adaptive_zoom: 'optzoom=2',
  black: 'optzoom=0:crop=black',
  keep: 'optzoom=0:crop=keep',
};

const STAGE_TIMEOUT_MS = 60 * 60_000;

/** Writes a steadied ProRes 422 HQ copy of `input` (with its sound) to `dest`, a .mov. */
export async function stabilize(input: string, dest: string, o: StabilizeOptions): Promise<void> {
  const dir = dirname(dest);
  // A name relative to the working folder, so no path has to be escaped inside a filter.
  const trf = `${basename(dest)}.trf`;
  const tripod = o.tripod ? ':tripod=1' : '';
  const progress = (from: number, message: string) => (line: string) => {
    const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
    if (!m || !o.duration) return;
    const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    o.onProgress?.(from + 0.5 * Math.min(1, t / o.duration), message);
  };
  const common = {
    cwd: dir,
    heavy: true,
    timeoutMs: STAGE_TIMEOUT_MS,
    ...(o.signal ? { signal: o.signal } : {}),
  };
  try {
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-vf',
        `vidstabdetect=shakiness=${o.shakiness}:accuracy=15:result=${trf}${tripod}`,
        '-f',
        'null',
        '-',
      ],
      { ...common, onLine: progress(0, 'measuring shake') },
    );
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-vf',
        `vidstabtransform=input=${trf}:smoothing=${o.smoothing}:${EDGES[o.edges]}:interpol=bicubic${tripod}`,
        '-c:v',
        'prores_ks',
        '-profile:v',
        '3',
        '-pix_fmt',
        'yuv422p10le',
        '-c:a',
        'pcm_s16le',
        '-y',
        dest,
      ],
      { ...common, onLine: progress(0.5, 'steadying') },
    );
  } finally {
    await rm(`${dest}.trf`, { force: true });
  }
}
