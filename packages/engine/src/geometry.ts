import {
  frameSource,
  maskAnimates,
  maskAt,
  transformAnimates,
  transformAt,
} from '@cuttingfloor/core';
import type { StoredClip } from '@cuttingfloor/schema';
import { maskSpline, rectFor, type SourceSize } from './composite.ts';

// Where a clip's picture lands in the frame, in sequence pixels, worked out the way the
// compositor places it (composite.ts): the fitted and transformed picture box, then what of it
// stays visible after crop and mask, inside the frame. Reported back after a transform edit.

export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClipPlacement {
  /** Frame from the clip start. */
  frame: number;
  /** The whole picture's box (before crop and mask), unrotated. */
  picture: PixelBox;
  rotation: number;
  opacity: number;
  /** The part of the frame the clip shows: crop and mask applied, rotated, inside the frame. */
  visible: PixelBox | null;
  /** The part of the source picture that shows there, in source pixels (before rotation). */
  source: PixelBox | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const box = (x0: number, y0: number, x1: number, y1: number): PixelBox => ({
  x: r2(x0),
  y: r2(y0),
  w: r2(x1 - x0),
  h: r2(y1 - y0),
});

function placementAt(
  clip: StoredClip,
  tpf: number,
  i: number,
  n: number,
  src: SourceSize,
  frame: { width: number; height: number },
): ClipPlacement {
  const s = transformAt(clip, tpf, i, n);
  const [rx = 0, ry = 0, rw = 0, rh = 0] = rectFor(clip, s, src, frame);
  // The window left by crop and mask, in fractions of the fitted frame (then of the picture).
  const crop = clip.transform?.crop;
  let fx0 = crop?.left ?? 0;
  let fy0 = crop?.top ?? 0;
  let fx1 = 1 - (crop?.right ?? 0);
  let fy1 = 1 - (crop?.bottom ?? 0);
  // Only a mask that shows its selection narrows what shows: hide (or invert) leaves its
  // outside, fill and a matte keep the whole picture box. Measured at frame i of the clip.
  const m = clip.mask;
  if (m && m.mode !== 'fill' && Boolean(m.invert) === (m.mode === 'hide')) {
    const pts = maskSpline(m, maskAt(clip, tpf, i), src, frameSource(clip, tpf, i)).flat();
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    if (xs.length) {
      fx0 = Math.max(fx0, Math.min(...xs));
      fy0 = Math.max(fy0, Math.min(...ys));
      fx1 = Math.min(fx1, Math.max(...xs));
      fy1 = Math.min(fy1, Math.max(...ys));
    }
  }
  // Crop and mask are fractions of the clip's fitted frame: a box the sequence's shape with the
  // picture fitted inside it (bars where the shapes differ), centred on the picture. Measured:
  // a 0.5 x 0.5 mask on a 9:16 picture in a 16:9 frame keeps the picture's whole width.
  const aspect = frame.width / frame.height;
  const fw = rw / rh < aspect ? rh * aspect : rw;
  const fh = rw / rh < aspect ? rh : rw / aspect;
  const toPicX = (f: number) => Math.min(1, Math.max(0, (rx + rw / 2 - fw / 2 + f * fw - rx) / rw));
  const toPicY = (f: number) => Math.min(1, Math.max(0, (ry + rh / 2 - fh / 2 + f * fh - ry) / rh));
  if (rw > 0 && rh > 0) {
    fx0 = toPicX(fx0);
    fx1 = toPicX(fx1);
    fy0 = toPicY(fy0);
    fy1 = toPicY(fy1);
  }
  const empty = fx1 <= fx0 || fy1 <= fy0;
  // Corners in sequence pixels, rotated about the picture's centre (qtblend rotate_center).
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const a = (s.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const corners = [
    [fx0, fy0],
    [fx1, fy0],
    [fx1, fy1],
    [fx0, fy1],
  ].map(([u, v]) => {
    const dx = rx + (u as number) * rw - cx;
    const dy = ry + (v as number) * rh - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as [number, number];
  });
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const vx0 = Math.max(0, Math.min(...xs));
  const vy0 = Math.max(0, Math.min(...ys));
  const vx1 = Math.min(frame.width, Math.max(...xs));
  const vy1 = Math.min(frame.height, Math.max(...ys));
  const shown = !empty && vx1 > vx0 && vy1 > vy0 && rw > 0 && rh > 0;
  // Back to the source: unrotated, the frame's edges cut the window too.
  let sx0 = fx0;
  let sy0 = fy0;
  let sx1 = fx1;
  let sy1 = fy1;
  if (!s.rotation && shown) {
    sx0 = Math.max(fx0, (vx0 - rx) / rw);
    sy0 = Math.max(fy0, (vy0 - ry) / rh);
    sx1 = Math.min(fx1, (vx1 - rx) / rw);
    sy1 = Math.min(fy1, (vy1 - ry) / rh);
  }
  const flip = clip.transform?.flip ?? 'none';
  if (flip === 'horizontal' || flip === 'both') [sx0, sx1] = [1 - sx1, 1 - sx0];
  if (flip === 'vertical' || flip === 'both') [sy0, sy1] = [1 - sy1, 1 - sy0];
  return {
    frame: i,
    picture: box(rx, ry, rx + rw, ry + rh),
    rotation: r2(s.rotation),
    opacity: Math.round(s.opacity * 1000) / 1000,
    visible: shown ? box(vx0, vy0, vx1, vy1) : null,
    source: shown
      ? box(sx0 * src.width, sy0 * src.height, sx1 * src.width, sy1 * src.height)
      : null,
  };
}

const numbers = (p: ClipPlacement) => [
  p.picture.x,
  p.picture.y,
  p.picture.w,
  p.picture.h,
  p.rotation,
  p.opacity,
  p.visible?.x ?? -1,
  p.visible?.y ?? -1,
  p.visible?.w ?? -1,
  p.visible?.h ?? -1,
];

/**
 * Where a clip shows over its length: its first and last frame and every frame where the motion
 * changes course (in between, every value moves in a straight line to within half a pixel), up
 * to `max` entries; past that, entries evenly spaced and `complete` false.
 */
export function clipPlacements(
  clip: StoredClip,
  tpf: number,
  n: number,
  src: SourceSize,
  frame: { width: number; height: number },
  max = 60,
): { frames: ClipPlacement[]; complete: boolean } {
  if (n <= 0) return { frames: [], complete: true };
  if (!transformAnimates(clip) && !maskAnimates(clip)) {
    return { frames: [placementAt(clip, tpf, 0, n, src, frame)], complete: true };
  }
  const all: ClipPlacement[] = [];
  for (let i = 0; i < n; i++) all.push(placementAt(clip, tpf, i, n, src, frame));
  const kept: ClipPlacement[] = [all[0] as ClipPlacement];
  for (let i = 1; i < all.length - 1; i++) {
    const a = numbers(kept[kept.length - 1] as ClipPlacement);
    const b = numbers(all[i] as ClipPlacement);
    const c = numbers(all[i + 1] as ClipPlacement);
    const ka = (kept[kept.length - 1] as ClipPlacement).frame;
    const f = (i - ka) / (i + 1 - ka);
    if (
      b.some(
        (v, j) =>
          Math.abs(v - ((a[j] as number) + ((c[j] as number) - (a[j] as number)) * f)) > 0.5,
      )
    )
      kept.push(all[i] as ClipPlacement);
  }
  if (all.length > 1) kept.push(all[all.length - 1] as ClipPlacement);
  if (kept.length <= max) return { frames: kept, complete: true };
  const step = (n - 1) / (max - 1);
  const even = Array.from({ length: max }, (_, k) => all[Math.round(k * step)] as ClipPlacement);
  return { frames: even, complete: false };
}
