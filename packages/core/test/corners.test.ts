import { describe, expect, it } from 'vitest';
import { StoredCorners, type StoredClip } from '@cuttingfloor/schema';
import { cornersAnimates, cornersAt } from '../src/animate.ts';

/** A clip whose transform carries nothing but the corners under test. */
const clipWith = (corners: unknown): StoredClip => ({ transform: { corners } }) as unknown as StoredClip;

const QUAD: Array<[number, number]> = [
  [0.1, 0.1],
  [0.9, 0.1],
  [0.9, 0.9],
  [0.1, 0.9],
];

describe('clip corners', () => {
  it('a quad is four points, not three', () => {
    expect(StoredCorners.safeParse(QUAD).success).toBe(true);
    expect(StoredCorners.safeParse(QUAD.slice(0, 3)).success).toBe(false);
    expect(StoredCorners.safeParse(QUAD.slice(0, 4).concat([[0.5, 0.5]])).success).toBe(false);
  });

  it('holds the first keyframe before it starts', () => {
    const clip = clipWith({ keyframes: [{ t: 10, corners: QUAD }] });
    expect(cornersAt(clip, 0)).toEqual(QUAD);
  });

  it('eases each corner toward its counterpart in the next keyframe', () => {
    const moved = QUAD.map(([x, y]) => [x + 0.1, y - 0.1] as [number, number]);
    const clip = clipWith({
      keyframes: [
        { t: 0, corners: QUAD },
        { t: 100, corners: moved },
      ],
    });
    const first = cornersAt(clip, 50)[0];
    expect(first?.[0]).toBeCloseTo(0.15);
    expect(first?.[1]).toBeCloseTo(0.05);
  });

  it('animates only when the quad has more than one keyframe', () => {
    expect(cornersAnimates(clipWith(QUAD))).toBe(false);
    expect(cornersAnimates(clipWith({ keyframes: [{ t: 0, corners: QUAD }] }))).toBe(false);
    expect(
      cornersAnimates(
        clipWith({
          keyframes: [
            { t: 0, corners: QUAD },
            { t: 100, corners: QUAD },
          ],
        }),
      ),
    ).toBe(true);
  });
});
