// Where the sound detectors' 10 s windows sit over a long sound, and which frames of each
// window go into the result. Pure arithmetic, so sounds-worker.ts and tests share it.

/** One window: 10 s at 16 kHz. */
export const SED_WINDOW = 160_000;
/** One frame: 40 ms at 16 kHz. */
export const SED_FRAME = 640;
/** Frames a window scores. */
export const SED_WINDOW_FRAMES = SED_WINDOW / SED_FRAME;

export interface WindowPart {
  /** Where the window starts, in samples. */
  at: number;
  /** The frames of the result it gives, [from, to), counted from the sound's start. */
  from: number;
  to: number;
}

/** Windows start every 5 s: each overlaps the next by half. */
export const SED_HOP = SED_WINDOW / 2;
const HOP_FRAMES = SED_HOP / SED_FRAME;
/** A window gives its middle half: from a quarter in to three quarters in. */
const KEEP_FROM = Math.floor((SED_WINDOW_FRAMES - HOP_FRAMES) / 2);

/**
 * The windows over `total` samples, in order, overlapping by half; each gives the middle half
 * of its frames (the first from the sound's start, the last to its end), so no frame of the
 * result sits at the edge of the window that scored it unless it is at the sound's own edge.
 * Their parts tile every frame once.
 */
export function windowPlan(total: number): WindowPart[] {
  const frames = Math.max(1, Math.ceil(total / SED_FRAME));
  const plan: WindowPart[] = [];
  for (let k = 0, from = 0; from < frames; k++) {
    const first = k * HOP_FRAMES;
    const last = first + SED_WINDOW_FRAMES >= frames;
    const to = last ? frames : first + KEEP_FROM + HOP_FRAMES;
    plan.push({ at: k * SED_HOP, from, to });
    from = to;
  }
  return plan;
}
