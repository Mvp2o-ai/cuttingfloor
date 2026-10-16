import {
  type Animatable,
  CfError,
  type Ease,
  MASK_DEFAULTS,
  MASK_NUMBERS,
  type MaskNumber,
  type StoredAnimatable,
  type StoredClip,
  TRANSFORM_DEFAULTS,
  TRANSFORM_NUMBERS,
  type TransformNumber,
} from '@cuttingfloor/schema';
import { frameSource } from './speed.ts';

// Animatable values: easing, sampling, conversion between the frame-based tool view and the
// stored form (source ticks), and the animation presets layered over a clip's transform.
// The MLT compiler bakes values per frame from here, so previews and exports agree exactly.

type EaseFn = (p: number) => number;

const power = (n: number): [EaseFn, EaseFn, EaseFn] => [
  (p) => p ** n,
  (p) => 1 - (1 - p) ** n,
  (p) => (p < 0.5 ? 2 ** (n - 1) * p ** n : 1 - (-2 * p + 2) ** n / 2),
];

function bounceOut(p: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) return n1 * (p - 1.5 / d1) ** 2 + 0.75;
  if (p < 2.5 / d1) return n1 * (p - 2.25 / d1) ** 2 + 0.9375;
  return n1 * (p - 2.625 / d1) ** 2 + 0.984375;
}

const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;
const C4 = (2 * Math.PI) / 3;
const C5 = (2 * Math.PI) / 4.5;

const FAMILY: Record<string, [EaseFn, EaseFn, EaseFn]> = {
  sine: [
    (p) => 1 - Math.cos((p * Math.PI) / 2),
    (p) => Math.sin((p * Math.PI) / 2),
    (p) => -(Math.cos(Math.PI * p) - 1) / 2,
  ],
  quad: power(2),
  cubic: power(3),
  quart: power(4),
  quint: power(5),
  expo: [
    (p) => (p === 0 ? 0 : 2 ** (10 * p - 10)),
    (p) => (p === 1 ? 1 : 1 - 2 ** (-10 * p)),
    (p) =>
      p === 0 ? 0 : p === 1 ? 1 : p < 0.5 ? 2 ** (20 * p - 10) / 2 : (2 - 2 ** (-20 * p + 10)) / 2,
  ],
  circ: [
    (p) => 1 - Math.sqrt(1 - p * p),
    (p) => Math.sqrt(1 - (p - 1) ** 2),
    (p) =>
      p < 0.5 ? (1 - Math.sqrt(1 - (2 * p) ** 2)) / 2 : (Math.sqrt(1 - (-2 * p + 2) ** 2) + 1) / 2,
  ],
  back: [
    (p) => C3 * p ** 3 - C1 * p * p,
    (p) => 1 + C3 * (p - 1) ** 3 + C1 * (p - 1) ** 2,
    (p) =>
      p < 0.5
        ? ((2 * p) ** 2 * ((C2 + 1) * 2 * p - C2)) / 2
        : ((2 * p - 2) ** 2 * ((C2 + 1) * (p * 2 - 2) + C2) + 2) / 2,
  ],
  elastic: [
    (p) => (p === 0 ? 0 : p === 1 ? 1 : -(2 ** (10 * p - 10)) * Math.sin((p * 10 - 10.75) * C4)),
    (p) => (p === 0 ? 0 : p === 1 ? 1 : 2 ** (-10 * p) * Math.sin((p * 10 - 0.75) * C4) + 1),
    (p) =>
      p === 0
        ? 0
        : p === 1
          ? 1
          : p < 0.5
            ? -(2 ** (20 * p - 10) * Math.sin((20 * p - 11.125) * C5)) / 2
            : (2 ** (-20 * p + 10) * Math.sin((20 * p - 11.125) * C5)) / 2 + 1,
  ],
  bounce: [
    (p) => 1 - bounceOut(1 - p),
    bounceOut,
    (p) => (p < 0.5 ? (1 - bounceOut(1 - 2 * p)) / 2 : (1 + bounceOut(2 * p - 1)) / 2),
  ],
};

/** The easing curve for a name: maps progress 0–1 to 0–1 (back and elastic overshoot). */
export function easeFn(ease: Ease | undefined): EaseFn {
  if (!ease || ease === 'linear') return (p) => p;
  if (ease === 'hold') return (p) => (p >= 1 ? 1 : 0);
  if (ease === 'smooth') return (p) => p * p * (3 - 2 * p);
  const m = /^([a-z]+)_(in|out|in_out)$/.exec(ease);
  const fns = m?.[1] ? FAMILY[m[1]] : undefined;
  if (!m || !fns) return (p) => p;
  return fns[m[2] === 'in' ? 0 : m[2] === 'out' ? 1 : 2];
}

/** Value of a stored animatable at source tick `t`. */
export function sample(value: StoredAnimatable | undefined, fallback: number, t: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const ks = value.keyframes;
  const first = ks[0];
  if (!first) return fallback;
  if (t <= first.t) return first.value;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i];
    const b = ks[i + 1];
    if (!a || !b) break;
    if (t < b.t) {
      const p = (t - a.t) / (b.t - a.t);
      return a.value + (b.value - a.value) * easeFn(a.ease)(p);
    }
  }
  return ks[ks.length - 1]?.value ?? fallback;
}

export const isAnimated = (v: StoredAnimatable | undefined): boolean =>
  v !== undefined && typeof v !== 'number' && v.keyframes.length > 1;

/** Tool form → stored form. Keyframe frames are relative to the clip start; stored as source ticks. */
export function toStoredAnim(
  value: Animatable,
  clip: Pick<StoredClip, 'in'>,
  tpf: number,
): StoredAnimatable {
  if (typeof value === 'number') return value;
  const sorted = [...value.keyframes].sort((a, b) => a.frame - b.frame);
  return {
    keyframes: sorted.map((k) => ({
      t: clip.in + k.frame * tpf,
      value: k.value,
      ...(k.ease && k.ease !== 'linear' ? { ease: k.ease } : {}),
    })),
  };
}

/** Stored form → tool form. */
export function toViewAnim(
  value: StoredAnimatable,
  clip: Pick<StoredClip, 'in'>,
  tpf: number,
): Animatable {
  if (typeof value === 'number') return value;
  return {
    keyframes: value.keyframes.map((k) => ({
      frame: Math.round((k.t - clip.in) / tpf),
      value: k.value,
      ...(k.ease ? { ease: k.ease } : {}),
    })),
  };
}

export type TransformState = Record<TransformNumber, number>;
export type MaskState = Record<MaskNumber, number>;

/** Deterministic noise in [-1, 1] for shake and flicker. */
function noise(i: number, seed: number): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));

/**
 * Applies an in or out preset at progress `p` (0 = fully hidden, 1 = at rest).
 * Exits run the same curves towards the clip end; slides leave in their named direction.
 */
function applyInOut(name: string, raw: number, phase: 'in' | 'out', s: TransformState): void {
  const p = easeFn('cubic_out')(raw);
  const away = 1 - p;
  const dir = phase === 'in' ? 1 : -1;
  switch (name) {
    case 'fade':
      s.opacity *= p;
      break;
    case 'zoom_in':
      s.scale *= phase === 'in' ? 0.5 + 0.5 * p : 1 + 0.5 * away;
      s.opacity *= p;
      break;
    case 'zoom_out':
      s.scale *= phase === 'in' ? 1.5 - 0.5 * p : 0.5 + 0.5 * p;
      s.opacity *= p;
      break;
    case 'slide_left':
      s.x += dir * away;
      break;
    case 'slide_right':
      s.x -= dir * away;
      break;
    case 'slide_up':
      s.y += dir * away;
      break;
    case 'slide_down':
      s.y -= dir * away;
      break;
    case 'pop':
      s.scale *= Math.max(0, easeFn('back_out')(raw));
      s.opacity *= clamp01(raw * 4);
      break;
    case 'spin':
      s.rotation -= dir * 360 * away;
      s.scale *= p;
      break;
    case 'drop':
      s.y -= dir * 0.4 * (1 - easeFn('bounce_out')(raw));
      s.opacity *= clamp01(raw * 4);
      break;
  }
}

function applyLoop(name: string, i: number, period: number, k: number, s: TransformState): void {
  const phase = i / period;
  const wave = Math.sin(2 * Math.PI * phase);
  const step = Math.floor(i / Math.max(1, Math.round(period / 10)));
  switch (name) {
    case 'pulse':
      s.scale *= 1 + 0.06 * k * wave;
      break;
    case 'sway':
      s.rotation += 6 * k * wave;
      break;
    case 'shake':
      s.x += 0.012 * k * noise(step, 1);
      s.y += 0.012 * k * noise(step, 2);
      break;
    case 'float':
      s.y += 0.02 * k * wave;
      break;
    case 'spin':
      s.rotation += 360 * phase * k;
      break;
    case 'flicker':
      if (noise(step, 3) > 0.4) s.opacity *= 1 - 0.35 * Math.min(1, k);
      break;
  }
}

/**
 * Transform values at frame `i` of a clip that is `n` frames long: keyframes sampled at the
 * frame's source time, then any in/out/loop animation applied on top.
 */
export function transformAt(clip: StoredClip, tpf: number, i: number, n: number): TransformState {
  // Keyframes live on the source, so a sped-up or reversed clip carries them along.
  const t = frameSource(clip, tpf, i);
  const s = {} as TransformState;
  for (const key of TRANSFORM_NUMBERS) {
    s[key] = sample(clip.transform?.[key], TRANSFORM_DEFAULTS[key], t);
  }
  const a = clip.animation;
  if (a?.in) applyInOut(a.in.name, clamp01(i / Math.max(1, a.in.duration / tpf)), 'in', s);
  if (a?.out)
    applyInOut(a.out.name, clamp01((n - 1 - i) / Math.max(1, a.out.duration / tpf)), 'out', s);
  if (a?.loop) applyLoop(a.loop.name, i, Math.max(1, a.loop.period / tpf), a.loop.strength, s);
  s.opacity = clamp01(s.opacity);
  return s;
}

/** Whether a clip's transform changes over its length. */
export function transformAnimates(clip: StoredClip): boolean {
  return Boolean(clip.animation) || TRANSFORM_NUMBERS.some((k) => isAnimated(clip.transform?.[k]));
}

export function maskAt(clip: StoredClip, tpf: number, i: number): MaskState {
  const t = frameSource(clip, tpf, i);
  const s = {} as MaskState;
  for (const key of MASK_NUMBERS) s[key] = sample(clip.mask?.[key], MASK_DEFAULTS[key], t);
  return s;
}

export function maskAnimates(clip: StoredClip): boolean {
  return MASK_NUMBERS.some((k) => isAnimated(clip.mask?.[k]));
}

/** Rejects keyframe sets an engine can't use. */
export function checkKeyframes(name: string, value: Animatable | null | undefined): void {
  if (value && typeof value !== 'number') {
    const frames = value.keyframes.map((k) => k.frame);
    if (new Set(frames).size !== frames.length) {
      throw new CfError('bad_request', `${name}: two keyframes share a frame`, {
        hint: 'Give each keyframe its own frame',
      });
    }
  }
}
