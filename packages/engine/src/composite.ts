import {
  type MaskState,
  maskAnimates,
  maskAt,
  type TransformState,
  transformAnimates,
  transformAt,
} from '@cuttingfloor/core';
import type { BlendMode, StoredClip, StoredMask } from '@cuttingfloor/schema';

// Per-clip compositing for MLT: the qtblend rect/rotation for a clip's transform, and the
// rotoscoping splines for its crop and mask. Values are baked per frame from @cuttingfloor/core
// so previews and exports agree.
//
// Facts about MLT 7.30 this relies on (pinned by the end-to-end pixel tests):
// - With an explicit rect and distort=1, qtblend takes the clip at its own aspect, and its
//   filters (rotoscoping included) see that unpadded picture. Without a rect, qtblend fits the
//   picture itself and filters may see a letterboxed frame, so the rect is always given.
// - rotoscoping keyframes are positions in the source (the producer's frame numbers), and
//   alpha_operation=min treats a frame without an alpha channel as fully transparent, so the
//   first spline uses `clear` unless the source carries alpha.

/** QPainter composition modes used by qtblend. */
const COMPOSITING: Record<BlendMode, number> = {
  normal: 0,
  add: 12,
  multiply: 13,
  screen: 14,
  overlay: 15,
  darken: 16,
  lighten: 17,
  color_dodge: 18,
  color_burn: 19,
  hard_light: 20,
  soft_light: 21,
  difference: 22,
  exclusion: 23,
};

export interface Frame {
  width: number;
  height: number;
}

export interface SourceSize {
  width: number;
  height: number;
  alpha: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** qtblend rect "x y w h opacity" for one frame's transform: exactly the picture's box. */
function rectFor(clip: StoredClip, s: TransformState, src: SourceSize, out: Frame): number[] {
  const W = out.width;
  const H = out.height;
  // Size of the picture fitted with `contain`, then the fit mode, then scale.
  const k0 = Math.min(W / src.width, H / src.height);
  const bw = src.width * k0;
  const bh = src.height * k0;
  let fw = bw;
  let fh = bh;
  const fit = clip.transform?.fit ?? 'contain';
  if (fit === 'cover') {
    const k = Math.max(W / bw, H / bh);
    fw = bw * k;
    fh = bh * k;
  } else if (fit === 'fill') {
    fw = W;
    fh = H;
  }
  const dw = fw * s.scale * s.scale_x;
  const dh = fh * s.scale * s.scale_y;
  const cx = s.x * W;
  const cy = s.y * H;
  return [r2(cx - dw / 2), r2(cy - dh / 2), r2(dw), r2(dh), r4(s.opacity)];
}

/**
 * Drops interior points that lie on the straight line between their neighbours, so a linear
 * ramp baked per frame keeps only its ends. `pts` are [frame, ...values].
 */
function prune(pts: number[][], eps: number): number[][] {
  if (pts.length <= 2) return pts;
  const kept: number[][] = [pts[0] as number[]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = kept[kept.length - 1] as number[];
    const b = pts[i] as number[];
    const c = pts[i + 1] as number[];
    const span = (c[0] as number) - (a[0] as number);
    const f = ((b[0] as number) - (a[0] as number)) / span;
    const straight = b.every(
      (v, j) =>
        j === 0 ||
        Math.abs(v - ((a[j] as number) + ((c[j] as number) - (a[j] as number)) * f)) <= eps,
    );
    if (!straight) kept.push(b);
  }
  kept.push(pts[pts.length - 1] as number[]);
  return kept;
}

export interface ClipComposite {
  rect: string;
  rotation: string | null;
  compositing: number;
}

/** qtblend properties for a clip `n` frames long, with keyframes relative to the clip start. */
export function compositeFor(
  clip: StoredClip,
  tpf: number,
  n: number,
  src: SourceSize,
  out: Frame,
): ClipComposite {
  const compositing = COMPOSITING[clip.blend ?? 'normal'];
  if (!transformAnimates(clip)) {
    const s = transformAt(clip, tpf, 0, n);
    return {
      rect: rectFor(clip, s, src, out).join(' '),
      rotation: s.rotation ? String(r2(s.rotation)) : null,
      compositing,
    };
  }
  const rects: number[][] = [];
  const rots: number[][] = [];
  for (let i = 0; i < n; i++) {
    const s = transformAt(clip, tpf, i, n);
    rects.push([i, ...rectFor(clip, s, src, out)]);
    rots.push([i, r2(s.rotation)]);
  }
  const first = rots[0]?.[1] ?? 0;
  const steady = rots.every((p) => p[1] === first);
  return {
    rect: prune(rects, 0.01)
      .map(([i, ...v]) => `${i}=${v.join(' ')}`)
      .join(';'),
    rotation: steady
      ? first
        ? String(first)
        : null
      : prune(rots, 0.01)
          .map(([i, v]) => `${i}=${v}`)
          .join(';'),
    compositing,
  };
}

// ---------------------------------------------------------------------------------- masks

type Pt = [number, number];
/** A bezier point: [handle in, point, handle out]. */
type BPoint = [Pt, Pt, Pt];

const KAPPA = 0.5522847498;

const corner = (p: Pt): BPoint => [p, p, p];

/** Rounded rectangle (or plain, r = 0) centred on 0,0, in source pixels. */
function roundedRect(w: number, h: number, r: number): BPoint[] {
  const x = w / 2;
  const y = h / 2;
  if (r <= 0) return [corner([-x, -y]), corner([x, -y]), corner([x, y]), corner([-x, y])];
  const k = r * KAPPA;
  return [
    [
      [-x + r - k, -y],
      [-x + r, -y],
      [-x + r, -y],
    ],
    [
      [x - r, -y],
      [x - r, -y],
      [x - r + k, -y],
    ],
    [
      [x, -y + r - k],
      [x, -y + r],
      [x, -y + r],
    ],
    [
      [x, y - r],
      [x, y - r],
      [x, y - r + k],
    ],
    [
      [x - r + k, y],
      [x - r, y],
      [x - r, y],
    ],
    [
      [-x + r, y],
      [-x + r, y],
      [-x + r - k, y],
    ],
    [
      [-x, y - r + k],
      [-x, y - r],
      [-x, y - r],
    ],
    [
      [-x, -y + r],
      [-x, -y + r],
      [-x, -y + r - k],
    ],
  ];
}

function ellipse(w: number, h: number): BPoint[] {
  const a = w / 2;
  const b = h / 2;
  const ka = a * KAPPA;
  const kb = b * KAPPA;
  return [
    [
      [-ka, -b],
      [0, -b],
      [ka, -b],
    ],
    [
      [a, -kb],
      [a, 0],
      [a, kb],
    ],
    [
      [ka, b],
      [0, b],
      [-ka, b],
    ],
    [
      [-a, kb],
      [-a, 0],
      [-a, -kb],
    ],
  ];
}

function star(w: number, h: number): BPoint[] {
  const pts: BPoint[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.19 : 0.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(corner([Math.cos(a) * r * w, Math.sin(a) * r * h]));
  }
  return pts;
}

function heart(w: number, h: number): BPoint[] {
  const pts: BPoint[] = [];
  for (let i = 0; i < 48; i++) {
    const t = (i / 48) * 2 * Math.PI;
    const x = 16 * Math.sin(t) ** 3;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    // The curve spans x ±16 and y −17..12; centre it in the box.
    pts.push(corner([(x / 32) * w, ((y + 2.5) / 29) * h]));
  }
  return pts;
}

/** Shape outline in source pixels, before rotation and placement. */
function outline(mask: StoredMask, m: MaskState, sw: number, sh: number): BPoint[] {
  const w = m.width * sw;
  const h = m.height * sh;
  const far = 10 * Math.max(sw, sh);
  switch (mask.shape) {
    case 'rectangle':
      return roundedRect(w, h, (mask.corner_radius ?? 0) * Math.min(w, h));
    case 'ellipse':
      return ellipse(w, h);
    case 'star':
      return star(w, h);
    case 'heart':
      return heart(w, h);
    case 'linear':
      // Everything below the line through the centre (before rotation).
      return [corner([-far, 0]), corner([far, 0]), corner([far, far]), corner([-far, far])];
    case 'mirror':
      return [
        corner([-far, -h / 2]),
        corner([far, -h / 2]),
        corner([far, h / 2]),
        corner([-far, h / 2]),
      ];
    case 'polygon':
      return [];
  }
}

/** Maps source pixels to 0–1 units of the picture, which is what rotoscoping reads. */
function placer(src: SourceSize) {
  return (p: Pt): Pt => [r4(p[0] / src.width), r4(p[1] / src.height)];
}

function maskSpline(mask: StoredMask, m: MaskState, src: SourceSize): BPoint[] {
  const place = placer(src);
  if (mask.shape === 'polygon') {
    return (mask.points ?? []).map(([x, y]) => corner(place([x * src.width, y * src.height])));
  }
  const cx = m.x * src.width;
  const cy = m.y * src.height;
  const a = (m.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const move = (p: Pt): Pt => place([cx + p[0] * cos - p[1] * sin, cy + p[0] * sin + p[1] * cos]);
  return outline(mask, m, src.width, src.height).map((b) => [move(b[0]), move(b[1]), move(b[2])]);
}

export interface RotoFilter {
  spline: string;
  invert: boolean;
  feather: number;
  operation: 'clear' | 'min';
}

/** rotoscoping filters for a clip's crop and mask, in the order they apply. */
export function rotoFilters(
  clip: StoredClip,
  tpf: number,
  n: number,
  src: SourceSize,
  out: Frame,
): RotoFilter[] {
  const filters: RotoFilter[] = [];
  const op = () => (filters.length || src.alpha ? 'min' : 'clear');
  const crop = clip.transform?.crop;
  if (crop) {
    const place = placer(src);
    const [l, t, r, b] = [crop.left, crop.top, 1 - crop.right, 1 - crop.bottom];
    const pts: BPoint[] = [
      [l, t],
      [r, t],
      [r, b],
      [l, b],
    ].map(([x, y]) => corner(place([(x as number) * src.width, (y as number) * src.height])));
    filters.push({ spline: JSON.stringify(pts), invert: false, feather: 0, operation: op() });
  }
  const mask = clip.mask;
  if (mask) {
    // Feather is a fraction of the picture's short side as it appears in the frame.
    const short =
      Math.min(out.width / src.width, out.height / src.height) * Math.min(src.width, src.height);
    let spline: string;
    if (maskAnimates(clip)) {
      // Keyed by source frame, which is how rotoscoping positions keyframes.
      const start = Math.round(clip.in / tpf);
      const keys: Record<string, BPoint[]> = {};
      for (let i = 0; i < n; i++)
        keys[String(start + i)] = maskSpline(mask, maskAt(clip, tpf, i), src);
      spline = JSON.stringify(keys);
    } else {
      spline = JSON.stringify(maskSpline(mask, maskAt(clip, tpf, 0), src));
    }
    filters.push({
      spline,
      invert: Boolean(mask.invert),
      feather: Math.round((mask.feather ?? 0) * short),
      operation: op(),
    });
  }
  return filters;
}
