import { describe, expect, it } from 'vitest';
import { SED_FRAME, SED_WINDOW, SED_WINDOW_FRAMES, windowPlan } from '../src/sound-windows.ts';

// MVP-321: the sound detectors score 10 s windows, and a window's first and last frames have
// little sound around them, so a steady sound dipped at every 10 s join and its run split
// there. A detector that loses its edges must still give one run across a join.

/** Scores a steady sound as a detector does: present, except near the window's own edges. */
function detect(total: number, edge: number): number[] {
  const out: number[] = [];
  for (const part of windowPlan(total)) {
    const first = part.at / SED_FRAME;
    for (let f = part.from; f < part.to; f++) {
      const local = f - first;
      out.push(local < edge || local >= SED_WINDOW_FRAMES - edge ? 0 : 1);
    }
  }
  return out;
}

describe('sound detector windows', () => {
  it('give one run for a steady sound across a 10 s join', () => {
    const total = 25 * 16_000;
    const scores = detect(total, 5);
    expect(scores).toHaveLength(Math.ceil(total / SED_FRAME));
    // Frames inside the sound, away from its own start and end, are all present.
    const inside = scores.slice(10, scores.length - 10);
    expect(inside.indexOf(0)).toBe(-1);
  });

  it('tile every frame once, in order, for any length', () => {
    for (const total of [1, 639, 640, SED_WINDOW, SED_WINDOW + 1, 7 * SED_WINDOW + 12_345]) {
      const plan = windowPlan(total);
      expect(plan[0]?.from).toBe(0);
      expect(plan.at(-1)?.to).toBe(Math.max(1, Math.ceil(total / SED_FRAME)));
      for (let i = 1; i < plan.length; i++) {
        expect(plan[i]?.from).toBe(plan[i - 1]?.to);
        expect(plan[i]?.from).toBeGreaterThan(plan[i - 1]?.from ?? 0);
      }
      for (const p of plan) {
        // A window only gives frames it scored.
        expect(p.from).toBeGreaterThanOrEqual(p.at / SED_FRAME);
        expect(p.to).toBeLessThanOrEqual(p.at / SED_FRAME + SED_WINDOW_FRAMES);
      }
    }
  });
});
