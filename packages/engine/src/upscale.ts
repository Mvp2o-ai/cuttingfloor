import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';
import { run } from './exec.ts';

// Super-resolution: Real-ESRGAN's compact general model (realesr-general-x4v3, BSD-3-Clause)
// makes every frame four times the size with detail it draws in; FFmpeg then resizes to the
// size asked for. The model runs on ONNX Runtime in upscale-worker.ts.

const WORKER = fileURLToPath(new URL('./upscale-worker.ts', import.meta.url));

/** The exported models, one per denoise strength (Dockerfile picture-models stage). */
export const UPSCALE_MODELS =
  process.env.CUTTINGFLOOR_UPSCALE_MODELS ?? '/usr/share/cuttingfloor/models/upscale';
export const UPSCALE_MODEL = 'realesr-general-x4v3';
export type UpscaleDenoise = 'light' | 'medium' | 'strong';

export interface UpscaleOptions {
  /** Source picture size. */
  width: number;
  height: number;
  /** Size made. */
  outWidth: number;
  outHeight: number;
  denoise: UpscaleDenoise;
  image: boolean;
  audio: boolean;
  fps: { num: number; den: number } | null;
  /** Frames the source has, for progress. */
  frames: number | null;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Writes an upscaled copy of `input` to `dest`: ProRes 422 HQ with the sound, or a PNG. */
export async function upscale(input: string, dest: string, o: UpscaleOptions): Promise<void> {
  const model = join(UPSCALE_MODELS, `${UPSCALE_MODEL}-${o.denoise}.onnx`);
  const specFile = `${dest}.spec.json`;
  await writeFile(
    specFile,
    JSON.stringify({
      input,
      output: dest,
      width: o.width,
      height: o.height,
      out_width: o.outWidth,
      out_height: o.outHeight,
      frames: o.frames,
      image: o.image,
      audio: o.audio,
      fps: o.fps ? `${o.fps.num}/${o.fps.den}` : null,
    }),
  );
  try {
    await run(process.execPath, [WORKER, model, specFile], {
      heavy: true,
      timeoutMs: 6 * 3600_000,
      ...(o.signal ? { signal: o.signal } : {}),
      onLine: (line) => {
        const m = /^progress ([\d.]+)/.exec(line);
        if (m) o.onProgress?.(Number(m[1]));
      },
    });
  } catch (error) {
    if (error instanceof CfError) throw error;
    throw new CfError('engine_error', `Upscaling failed: ${(error as Error).message}`);
  } finally {
    await rm(specFile, { force: true });
  }
}
