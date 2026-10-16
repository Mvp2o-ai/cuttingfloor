import * as z from 'zod/v4';
import type { ToolError } from './errors.ts';

// What the main server sends the motion worker (cuttingfloor motion-worker), and the limits both
// sides enforce. The worker is the only place agent-written HTML runs.

export const MOTION_LIMITS = {
  minSize: 16,
  maxSize: 3840,
  maxFps: 60,
  maxSeconds: 60,
  /** Pixels × frames: 30 s of 1080p30. */
  maxPixelFrames: 1920 * 1080 * 30 * 30,
  maxHtmlBytes: 1024 * 1024,
  maxAssets: 32,
  maxAssetBytes: 32 * 1024 * 1024,
} as const;

export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const MotionRequest = z
  .object({
    kind: z.enum(['motion', 'still']),
    html: z.string().min(1).max(MOTION_LIMITS.maxHtmlBytes),
    width: z.int().min(MOTION_LIMITS.minSize).max(MOTION_LIMITS.maxSize),
    height: z.int().min(MOTION_LIMITS.minSize).max(MOTION_LIMITS.maxSize),
    fps: z.number().positive().max(MOTION_LIMITS.maxFps),
    /** Seconds; motion only. */
    duration: z.number().positive().max(MOTION_LIMITS.maxSeconds),
    transparent: z.boolean(),
    assets: z
      .array(z.object({ name: z.string().regex(ASSET_NAME), data: z.base64() }))
      .max(MOTION_LIMITS.maxAssets),
  })
  .refine(
    (r) =>
      r.kind === 'still' || r.width * r.height * r.fps * r.duration <= MOTION_LIMITS.maxPixelFrames,
    {
      message: 'Too many pixels: keep width × height × fps × seconds within 30 s of 1080p30',
    },
  );
export type MotionRequest = z.infer<typeof MotionRequest>;

/** One NDJSON line of the worker's answer to POST /render. */
export type MotionEvent =
  | { progress: number; message: string }
  | { done: { id: string; type: string; bytes: number } }
  | { error: ToolError };
