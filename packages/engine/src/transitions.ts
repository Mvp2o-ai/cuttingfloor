import { easeFn, type TransformState, transitionHalves } from '@cuttingfloor/core';
import type { StoredTrack, TransitionKind } from '@cuttingfloor/schema';

// Transitions in the compiler. A transition is centred on a cut: for its length both clips
// play, the one before running past its end and the one after starting early. So each clip
// gets a render span (its frames plus `head` before and `tail` after), clips that overlap sit
// on separate MLT sub-tracks (the clip after the cut always above), and the transition itself
// is a set of per-frame changes to the clips' opacity, position, scale, rotation, masks and
// gain: the same compositing every clip already uses.

export interface Effect {
  kind: TransitionKind;
  /** Whether this clip is before ('a') or after ('b') the cut. */
  role: 'a' | 'b';
  /** Frames relative to the clip's first frame, end exclusive. */
  start: number;
  end: number;
}

export interface ClipPlan {
  head: number;
  tail: number;
  level: number;
  effects: Effect[];
}

export interface Dip {
  id: string;
  color: 'black' | 'white';
  /** Timeline frames, end exclusive. */
  start: number;
  end: number;
}

export interface TrackPlan {
  clips: Map<string, ClipPlan>;
  /** Sub-tracks this track needs (1 without transitions). */
  levels: number;
  dips: Dip[];
}

const NONE: ClipPlan = { head: 0, tail: 0, level: 0, effects: [] };

export function planTrack(track: StoredTrack, tpf: number): TrackPlan {
  const clips = new Map<string, ClipPlan>();
  const dips: Dip[] = [];
  const frame = (ticks: number) => Math.round(ticks / tpf);
  const plan = (id: string) => {
    const existing = clips.get(id);
    if (existing) return existing;
    const fresh: ClipPlan = { head: 0, tail: 0, level: 0, effects: [] };
    clips.set(id, fresh);
    return fresh;
  };
  for (const tr of track.transitions ?? []) {
    const a = track.clips.find((c) => c.id === tr.a);
    const b = track.clips.find((c) => c.id === tr.b);
    if (!a || !b) continue;
    const { before, after } = transitionHalves(tr.duration, tpf);
    const pa = plan(a.id);
    const pb = plan(b.id);
    const lenA = frame(a.duration);
    pa.tail = frame(after);
    pb.head = frame(before);
    pa.effects.push({
      kind: tr.kind,
      role: 'a',
      start: lenA - frame(before),
      end: lenA + frame(after),
    });
    pb.effects.push({ kind: tr.kind, role: 'b', start: -frame(before), end: frame(after) });
    if (tr.kind === 'dip_to_black' || tr.kind === 'dip_to_white') {
      const cut = frame(a.start + a.duration);
      dips.push({
        id: tr.id,
        color: tr.kind === 'dip_to_black' ? 'black' : 'white',
        start: cut - frame(before),
        end: cut + frame(after),
      });
    }
  }
  // The clip after a cut sits one level above the clip before it.
  let levels = 1;
  for (const c of [...track.clips].sort((x, y) => x.start - y.start)) {
    const into = track.transitions?.find((t) => t.b === c.id);
    const below = into ? clips.get(into.a) : undefined;
    if (below) {
      plan(c.id).level = below.level + 1;
      levels = Math.max(levels, below.level + 2);
    }
  }
  return { clips, levels: levels + (dips.length ? 1 : 0), dips };
}

export function clipPlan(plan: TrackPlan, clipId: string): ClipPlan {
  return plan.clips.get(clipId) ?? NONE;
}

/** Progress through an effect at frame `i`: 0 at its start, 1 at its end. */
function progress(e: Effect, i: number): number | undefined {
  if (i < e.start || i >= e.end) return undefined;
  return (i - e.start + 0.5) / (e.end - e.start);
}

const smooth = easeFn('cubic_in_out');

/** Changes a clip's transform for frame `i` (relative to its first frame) for its transitions. */
export function applyEffects(effects: Effect[], i: number, s: TransformState): void {
  for (const e of effects) {
    const p = progress(e, i);
    if (p === undefined) continue;
    const q = smooth(p);
    const inB = e.role === 'b';
    const [dx, dy] = direction(e.kind);
    switch (e.kind) {
      case 'dissolve':
        if (inB) s.opacity *= p;
        break;
      case 'dip_to_black':
      case 'dip_to_white':
        // The colour layer above covers the switch at the midpoint.
        s.opacity *= inB ? (p >= 0.5 ? 1 : 0) : p < 0.5 ? 1 : 0;
        break;
      case 'slide_left':
      case 'slide_right':
      case 'slide_up':
      case 'slide_down':
        if (inB) {
          s.x -= dx * (1 - q);
          s.y -= dy * (1 - q);
        }
        break;
      case 'push_left':
      case 'push_right':
      case 'push_up':
      case 'push_down':
        if (inB) {
          s.x -= dx * (1 - q);
          s.y -= dy * (1 - q);
        } else {
          s.x += dx * q;
          s.y += dy * q;
        }
        break;
      case 'zoom_in':
        if (inB) {
          s.scale *= 0.5 + 0.5 * q;
          s.opacity *= p;
        }
        break;
      case 'zoom_out':
        if (inB) s.opacity *= p;
        else s.scale *= 1 + q;
        break;
      case 'spin':
        if (inB) {
          s.rotation -= 180 * (1 - q);
          s.scale *= Math.max(0.001, q);
          s.opacity *= Math.min(1, 2 * p);
        }
        break;
      // Wipes and the iris reveal through a mask; crossfades change gain.
      default:
        break;
    }
  }
}

/** Unit vector a slide or push moves in: slide_left moves left, so the clip enters from the right. */
function direction(kind: TransitionKind): [number, number] {
  if (kind.endsWith('_left')) return [-1, 0];
  if (kind.endsWith('_right')) return [1, 0];
  if (kind.endsWith('_up')) return [0, -1];
  if (kind.endsWith('_down')) return [0, 1];
  return [0, 0];
}

type Pt = [number, number];
type BPoint = [Pt, Pt, Pt];
const corner = (p: Pt): BPoint => [p, p, p];
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** The revealed area of the incoming clip at progress `p`, in its picture's 0–1 space. */
function revealAt(kind: TransitionKind, p: number): BPoint[] | undefined {
  const q = smooth(p);
  const rect = (x0: number, y0: number, x1: number, y1: number): BPoint[] =>
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => corner([r4(x as number), r4(y as number)]));
  switch (kind) {
    case 'wipe_left':
      return rect(1 - q, 0, 1, 1);
    case 'wipe_right':
      return rect(0, 0, q, 1);
    case 'wipe_up':
      return rect(0, 1 - q, 1, 1);
    case 'wipe_down':
      return rect(0, 0, 1, q);
    case 'iris': {
      // An ellipse from nothing to past the corners.
      const r = 0.75 * q;
      const k = r * 0.5522847498;
      const c = (x: number, y: number): Pt => [r4(0.5 + x), r4(0.5 + y)];
      return [
        [c(-k, -r), c(0, -r), c(k, -r)],
        [c(r, -k), c(r, 0), c(r, k)],
        [c(k, r), c(0, r), c(-k, r)],
        [c(-r, k), c(-r, 0), c(-r, -k)],
      ];
    }
    default:
      return undefined;
  }
}

/**
 * Keyframed rotoscoping spline that reveals the incoming clip of a wipe or iris, keyed by
 * producer position (`keyBase` is the position of the clip's first frame). Undefined when the
 * clip has no such transition.
 */
export function revealSpline(effects: Effect[], keyBase: number): string | undefined {
  const e = effects.find((x) => x.role === 'b' && revealAt(x.kind, 0.5));
  if (!e) return undefined;
  const keys: Record<string, BPoint[]> = {};
  for (let i = e.start; i < e.end; i++) {
    keys[String(keyBase + i)] = revealAt(e.kind, progress(e, i) ?? 1) as BPoint[];
  }
  keys[String(keyBase + e.end)] = revealAt(e.kind, 1) as BPoint[];
  return JSON.stringify(keys);
}

/**
 * Linear gain (0–1) of an audio clip's crossfades at frame `i`: an equal-power fade out over
 * the cut for the clip before it, in for the clip after; 1 elsewhere.
 */
export function crossfadeGain(effects: Effect[], i: number): number {
  let g = 1;
  for (const e of effects) {
    if (e.kind !== 'crossfade' || i < e.start || i >= e.end) continue;
    const p = (i - e.start) / (e.end - e.start);
    g *= e.role === 'b' ? Math.sin((p * Math.PI) / 2) : Math.cos((p * Math.PI) / 2);
  }
  return g;
}
