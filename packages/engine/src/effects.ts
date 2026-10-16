import { isAnimated } from '@cuttingfloor/core';
import {
  EFFECTS,
  type EffectSpec,
  type StoredAnimatable,
  type StoredEffect,
} from '@cuttingfloor/schema';

// Registry effects as MLT filters. Animated params are baked per frame over the frames the
// filter covers and keyed by position (producer position on a clip, filter-relative on a
// tractor); sizes given as fractions of the frame become pixels at the render size.

export interface EffectContext {
  width: number;
  height: number;
  /** Frames the filter covers, relative to its clip (or zone) start: [from, to). */
  from: number;
  to: number;
  /** The keyframe position for relative frame i. */
  key: (i: number) => number;
  /** A stored animatable's value at relative frame i. */
  at: (v: StoredAnimatable, i: number) => number;
  /** The file of an imported LUT. */
  path: (mediaId: string) => string | undefined;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const prop = (name: string, value: string | number) =>
  `<property name="${name}">${esc(String(value))}</property>`;
const r = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** Deterministic noise in [-1, 1]. */
function noise(i: number, seed: number): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** A value as a property: constant, or keyframes baked per frame keeping straight runs' ends. */
function animated(ctx: EffectContext, fn: (i: number) => number): string {
  const points: Array<[number, number]> = [];
  for (let i = ctx.from; i < ctx.to; i++) points.push([ctx.key(i), fn(i)]);
  const first = points[0]?.[1] ?? 0;
  if (points.every((p) => p[1] === first)) return String(first);
  return points
    .filter((p, j) => {
      const a = points[j - 1];
      const b = points[j + 1];
      return !a || !b || Math.abs(p[1] - (a[1] + b[1]) / 2) > 1e-4;
    })
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
}

/** The MLT filters for one effect; empty when it is turned off. */
export function effectFilters(e: StoredEffect, ctx: EffectContext): string {
  if (e.enabled === false) return '';
  const spec = (EFFECTS as Record<string, EffectSpec>)[e.name];
  if (!spec) return '';
  const raw = (name: string): unknown =>
    e.params[name] ?? (spec.params[name] as { default?: unknown })?.default;
  // A number param, possibly keyframed, through `scale`.
  const num = (name: string, scale: (v: number) => number = (v) => v): string => {
    const v = raw(name) as StoredAnimatable;
    if (typeof v === 'number') return String(r(scale(v)));
    if (!isAnimated(v)) return String(r(scale(ctx.at(v, ctx.from))));
    return animated(ctx, (i) => r(scale(ctx.at(v, i))));
  };
  const f = (service: string, props: Record<string, string | number>) =>
    `<filter>${prop('mlt_service', service)}${Object.entries(props)
      .map(([k, v]) => prop(k, v))
      .join('')}</filter>`;
  const av = (name: string, props: Record<string, string | number>) =>
    f(
      `avfilter.${name}`,
      Object.fromEntries(Object.entries(props).map(([k, v]) => [`av.${k}`, v])),
    );
  const db = (v: number) => 10 ** (v / 20);
  switch (e.name) {
    case 'brightness_contrast':
      return av('eq', { brightness: num('brightness'), contrast: num('contrast') });
    case 'saturation':
      return av('eq', { saturation: num('amount') });
    case 'exposure':
      return av('exposure', { exposure: num('stops') });
    case 'temperature':
      return av('colortemperature', { temperature: num('kelvin') });
    case 'hue':
      return av('hue', { h: num('degrees') });
    case 'vibrance':
      return av('vibrance', { intensity: num('amount') });
    case 'curves':
      return av('curves', { preset: String(raw('preset')) });
    case 'lut': {
      const file = ctx.path(String(raw('media_id')));
      return file ? av('lut3d', { file, interp: 'tetrahedral' }) : '';
    }
    case 'grayscale':
      return av('hue', { s: 0 });
    case 'sepia':
      return f('sepia', {});
    case 'invert':
      return av('negate', {});
    case 'blur':
      return av('gblur', { sigma: num('radius', (v) => Math.max(0, (v * ctx.height) / 2)) });
    case 'sharpen':
      return av('cas', { strength: num('amount') });
    case 'vignette':
      return av('vignette', { angle: num('amount', (v) => (v * Math.PI) / 2) });
    case 'grain':
      return av('noise', { alls: num('amount', Math.round), allf: 't+u' });
    case 'chromatic_aberration': {
      const px = num('offset', (v) => Math.round(v * ctx.width));
      const neg = num('offset', (v) => -Math.round(v * ctx.width));
      return av('rgbashift', { rh: px, bh: neg });
    }
    case 'pixelate': {
      const px = num('size', (v) => Math.max(1, Math.round(v * ctx.width)));
      return av('pixelize', { width: px, height: px });
    }
    case 'glitch': {
      const amount = Number(raw('amount'));
      const shift = (seed: number) =>
        animated(ctx, (i) =>
          Math.round(noise(Math.floor(i / 3), seed) * amount * 0.03 * ctx.width),
        );
      return (
        av('rgbashift', { rh: shift(1), bh: shift(2), gv: shift(3) }) +
        av('noise', { alls: Math.round(amount * 30), allf: 't+u' })
      );
    }
    case 'denoise':
      return av('hqdn3d', { luma_spatial: num('strength') });
    case 'chroma_key':
      return f('chroma', {
        key: `0x${String(raw('color')).replace('#', '')}ff`,
        variance: num('tolerance'),
      });
    case 'equalizer': {
      const parts: string[] = [];
      const low = Number(raw('low_db'));
      const mid = Number(raw('mid_db'));
      const high = Number(raw('high_db'));
      if (low) parts.push(av('bass', { g: low, f: 100 }));
      if (mid) parts.push(av('equalizer', { f: 1000, t: 'o', w: 1, g: mid }));
      if (high) parts.push(av('treble', { g: high, f: 8000 }));
      return parts.join('');
    }
    case 'compressor':
      return av('acompressor', {
        threshold: r(db(Number(raw('threshold_db'))), 6),
        ratio: Number(raw('ratio')),
        makeup: r(db(Number(raw('makeup_db'))), 4),
      });
    case 'noise_reduction':
      return av('afftdn', { nr: Number(raw('amount_db')) });
    case 'de_esser':
      return av('deesser', { i: Number(raw('amount')) });
    case 'dialogue_enhance':
      return av('dialoguenhance', { enhance: Number(raw('amount')) });
    case 'reverb': {
      const a = Number(raw('amount'));
      return av('aecho', {
        in_gain: 0.8,
        out_gain: 0.9,
        delays: '60|90|120',
        decays: `${r(a * 0.5, 3)}|${r(a * 0.35, 3)}|${r(a * 0.25, 3)}`,
      });
    }
    case 'echo':
      return av('aecho', {
        in_gain: 0.8,
        out_gain: 0.9,
        delays: String(raw('delay_ms')),
        decays: String(raw('decay')),
      });
    case 'pitch':
      // MLT's own Rubber Band filter; FFmpeg's rubberband ignores its pitch inside MLT.
      return f('rbpitch', { octaveshift: r(Number(raw('semitones')) / 12, 6) });
    case 'highpass':
      return av('highpass', { f: Number(raw('frequency')) });
    case 'lowpass':
      return av('lowpass', { f: Number(raw('frequency')) });
    case 'telephone':
      return av('highpass', { f: 300 }) + av('lowpass', { f: 3400 });
    default:
      return '';
  }
}

/** Whether a set of effects makes a clip's picture partly transparent (masks must keep it). */
export function keysOutColour(effects: StoredEffect[]): boolean {
  return effects.some((e) => e.name === 'chroma_key' && e.enabled !== false);
}
