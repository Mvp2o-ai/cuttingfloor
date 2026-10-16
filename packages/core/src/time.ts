import { CfError, type FrameRate, TICKS_PER_SECOND } from '@cuttingfloor/schema';

/** Ticks in one frame at `fps`. Rates are validated to divide the tick rate exactly. */
export function ticksPerFrame(fps: FrameRate): number {
  const t = (TICKS_PER_SECOND * fps.den) / fps.num;
  if (!Number.isInteger(t)) {
    throw new CfError('bad_request', `Unsupported frame rate ${fps.num}/${fps.den}`);
  }
  return t;
}

export function framesToTicks(frames: number, fps: FrameRate): number {
  return frames * ticksPerFrame(fps);
}

/** Nearest frame. Positions are frame-aligned unless the sequence rate changed since. */
export function ticksToFrames(ticks: number, fps: FrameRate): number {
  return Math.round(ticks / ticksPerFrame(fps));
}

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}
