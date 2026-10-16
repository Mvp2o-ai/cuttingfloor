import { pathToFileURL } from 'node:url';
import {
  type FrameRate,
  type MediaRef,
  type StoredAnimatable,
  type StoredClip,
  type StoredTrack,
  type StoredTransition,
  TICKS_PER_SECOND,
  type TimelineDoc,
} from '@cuttingfloor/schema';
import { frameSource, span, subclip } from '../speed.ts';
import { ticksPerFrame } from '../time.ts';

// Shared ground for the interchange writers (OTIO, FCPXML, EDL, SRT/VTT): the media resolver,
// warnings, nested-timeline flattening and clip timing. Every writer is best effort; the
// timeline JSON is the lossless format (spec §21.6).

/** What an exported file needs to know about a media item. */
export interface InterchangeMedia {
  name: string;
  /** What the file reference points to: an absolute path, a relative path or a URL. */
  path: string;
  /** Ticks; absent or null when unknown or a still. */
  duration?: number | null | undefined;
  width?: number | undefined;
  height?: number | undefined;
  fps?: FrameRate | undefined;
  /** Audio channels; 0 or absent means no sound (or unknown). */
  channels?: number | undefined;
  sample_rate?: number | undefined;
}

/** Looks up a media item for export. Undefined means it is unknown (the clip is left out). */
export type InterchangeMediaResolver = (mediaId: string) => InterchangeMedia | undefined;

/** A written interchange file and what didn't carry over into it. */
export interface InterchangeResult {
  text: string;
  warnings: string[];
}

/** Clips that can appear in an exported file once nested timelines are flattened. */
export type FlatClip = Exclude<StoredClip, { type: 'timeline' }>;
export type MediaClip = Extract<StoredClip, { type: 'media' }>;
export type TextClip = Extract<StoredClip, { type: 'title' | 'caption' }>;

export interface FlatTrack extends Omit<StoredTrack, 'clips'> {
  clips: FlatClip[];
}

/** Collects warnings, grouping the clips or tracks each one concerns. */
export class Warnings {
  private readonly items = new Map<string, string[]>();

  add(message: string, subject?: string): void {
    let subjects = this.items.get(message);
    if (!subjects) {
      subjects = [];
      this.items.set(message, subjects);
    }
    if (subject !== undefined && !subjects.includes(subject)) subjects.push(subject);
  }

  list(): string[] {
    return [...this.items].map(([message, subjects]) => {
      if (!subjects.length) return message;
      const shown = subjects.slice(0, 8).join(', ');
      const more = subjects.length > 8 ? ` and ${subjects.length - 8} more` : '';
      return `${message} (${shown}${more})`;
    });
  }
}

/** What a writer can carry over beyond cuts, so the rest is reported as dropped. */
export interface Carries {
  /** Constant position, scale, rotation and opacity. */
  staticTransform?: boolean;
  /** Constant audio gain. */
  staticGain?: boolean;
}

const isAnimated = (v: StoredAnimatable | undefined) => v !== undefined && typeof v !== 'number';

/** Reports what of a clip's settings the format can't hold. */
export function noteDropped(clip: StoredClip, w: Warnings, carries: Carries = {}): void {
  const id = clip.id;
  if (clip.effects?.length) w.add('Effects were dropped', id);
  const t = clip.transform;
  if (t) {
    const numbers = [t.x, t.y, t.scale, t.scale_x, t.scale_y, t.rotation, t.opacity];
    if (!carries.staticTransform) {
      if (numbers.some((v) => v !== undefined))
        w.add('Transforms (position, scale, rotation, opacity) were dropped', id);
    } else if (numbers.some(isAnimated)) {
      w.add('Keyframed transforms were dropped; their first value was kept', id);
    }
    if (t.crop || (t.flip && t.flip !== 'none') || (t.fit && t.fit !== 'contain'))
      w.add('Crop, flip and fit settings were dropped', id);
  }
  if (clip.blend && clip.blend !== 'normal') w.add('Blend modes were dropped', id);
  if (clip.mask) w.add('Masks were dropped', id);
  if (clip.animation) w.add('In, out and loop animations were dropped', id);
  if (clip.gain !== undefined) {
    if (!carries.staticGain) w.add('Audio gain was dropped', id);
    else if (isAnimated(clip.gain))
      w.add('Keyframed audio gain was dropped; its first value was kept', id);
  }
  if (clip.pan !== undefined) w.add('Audio pan was dropped', id);
  if (clip.fade) w.add('Audio fades were dropped', id);
  if (clip.speed?.curve) w.add('Speed ramps became a constant speed at their average rate', id);
}

/** A constant value, or the first keyframe's value. */
export function firstValue(v: StoredAnimatable | undefined): number | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? v : v.keyframes[0]?.value;
}

/** Reports document-level settings no interchange format holds. */
export function noteDocument(doc: TimelineDoc, w: Warnings): void {
  if (doc.effects?.length) w.add('Timeline effects were dropped');
  if (doc.master) w.add('Master gain and limiter were dropped');
  for (const t of doc.tracks) if (t.effects?.length) w.add('Track effects were dropped', t.name);
}

// ---------------------------------------------------------------------------- timing

/** Constant playback of a clip: speed ramps become their mean rate. */
export interface Playback {
  /** Source ticks per timeline tick, 0 for a freeze; always positive or zero. */
  rate: number;
  reverse: boolean;
  /** Source tick shown at the clip's first frame. */
  first: number;
  /** Source ticks the clip covers. */
  span: number;
}

export function playback(clip: StoredClip, tpf: number): Playback {
  const covered = span(clip);
  const s = clip.speed;
  const rate = s?.curve ? covered / clip.duration : (s?.rate ?? 1);
  return { rate, reverse: !!s?.reverse, first: frameSource(clip, tpf, 0), span: covered };
}

/** Whether a clip plays its source at normal speed, forwards. */
export function isNormalSpeed(clip: StoredClip): boolean {
  const s = clip.speed;
  return !s || (!s.curve && (s.rate ?? 1) === 1 && !s.reverse);
}

/** Exact frames of a frame-aligned tick count (rounded when it isn't aligned). */
export function frames(ticks: number, tpf: number): number {
  return Math.round(ticks / tpf);
}

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** Nominal (integer) timecode rate: 30 for 29.97. */
export function nominalRate(fps: FrameRate): number {
  return Math.round(fps.num / fps.den);
}

/** Drop-frame timecode applies to 29.97 and 59.94. */
export function isDropFrame(fps: FrameRate): boolean {
  const n = nominalRate(fps);
  return fps.den === 1001 && (n === 30 || n === 60);
}

/** SMPTE timecode of a frame count; drop frame uses `;` before the frames. */
export function timecode(frameCount: number, fps: FrameRate): string {
  const rate = nominalRate(fps);
  let f = Math.max(0, Math.round(frameCount));
  const drop = isDropFrame(fps);
  if (drop) {
    // Two frame numbers (four at 59.94) are skipped every minute except each tenth.
    const d = rate === 30 ? 2 : 4;
    const per10 = rate * 600 - d * 9;
    const perMin = rate * 60 - d;
    const tens = Math.floor(f / per10);
    const rest = f % per10;
    f += d * 9 * tens + (rest > d ? d * Math.floor((rest - d) / perMin) : 0);
  }
  const ff = f % rate;
  const totalSeconds = Math.floor(f / rate);
  const two = (n: number) => String(n).padStart(2, '0');
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${two(hh)}:${two(mm)}:${two(ss)}${drop ? ';' : ':'}${two(ff)}`;
}

/** A file reference: URLs stay as they are, absolute paths become file URLs, relative paths are percent-encoded. */
export function mediaUrl(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  if (path.startsWith('/') || /^[a-z]:[\\/]/i.test(path)) return pathToFileURL(path).href;
  return path
    .split(/[\\/]/)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/** Ticks as reduced seconds: [numerator, denominator]. */
export function rationalSeconds(ticks: number): [number, number] {
  const g = gcd(ticks, TICKS_PER_SECOND);
  return [ticks / g, TICKS_PER_SECOND / g];
}

// ---------------------------------------------------------------------------- flattening

export interface Flattened {
  tracks: FlatTrack[];
  /** Media names from the document and every nested timeline, by id. */
  media: Record<string, MediaRef>;
  tpf: number;
}

const MAX_DEPTH = 16;

/**
 * Replaces nested-timeline clips with the clips they show, when that is exact: the nested
 * timeline has one track of the clip's kind with anything on it, no transitions or effects on
 * it, and the clip plays at normal speed. Otherwise the clip is left out (a gap) with a
 * warning. Pieces get ids `outer.inner`.
 */
export function flatten(doc: TimelineDoc, w: Warnings): Flattened {
  const tpf = ticksPerFrame(doc.sequence.fps);
  const media: Record<string, MediaRef> = {};
  for (const n of Object.values(doc.nested ?? {})) Object.assign(media, n.media);
  Object.assign(media, doc.media);

  const expand = (clip: StoredClip, depth: number): FlatClip[] => {
    if (clip.type !== 'timeline') return [clip];
    const nested = doc.nested?.[clip.timeline];
    const why = !nested
      ? 'its timeline is missing from the document'
      : depth >= MAX_DEPTH
        ? 'it nests too deeply'
        : !isNormalSpeed(clip)
          ? 'its speed is changed'
          : nested.effects?.length
            ? 'its timeline has effects'
            : undefined;
    const tracks = nested?.tracks.filter((t) => t.kind === clip.kind && t.clips.length) ?? [];
    const inner = tracks[0];
    const reason =
      why ??
      (tracks.length > 1
        ? `its timeline has ${tracks.length} ${clip.kind} tracks in use`
        : inner?.transitions?.length
          ? 'its timeline has transitions'
          : inner?.effects?.length
            ? 'its timeline has track effects'
            : inner && (inner.kind === 'video' ? inner.hidden : inner.muted)
              ? `its ${clip.kind} track is ${clip.kind === 'video' ? 'hidden' : 'muted'}`
              : undefined);
    if (reason || !nested) {
      w.add('Nested timelines that could not be flattened were left out as gaps', clip.id);
      if (reason) w.add(`Nested clip ${clip.id} was not flattened because ${reason}`);
      return [];
    }
    w.add('Nested timelines were flattened into the clips they show', clip.id);
    noteDropped(clip, w);
    const from = clip.in;
    const to = clip.in + clip.duration;
    const pieces: FlatClip[] = [];
    for (const c of inner?.clips ?? []) {
      const lo = Math.max(from, c.start);
      const hi = Math.min(to, c.start + c.duration);
      if (hi <= lo) continue;
      const sub = subclip(c, lo - c.start, hi - c.start);
      const { speed: _speed, ...rest } = c;
      const piece: StoredClip = {
        ...rest,
        in: sub.in,
        duration: sub.duration,
        ...(sub.speed ? { speed: sub.speed } : {}),
        id: `${clip.id}.${c.id}`,
        start: clip.start + (lo - from),
        enabled: clip.enabled && c.enabled,
        link: clip.link && c.link ? `${clip.link}.${c.link}` : null,
      } as StoredClip;
      pieces.push(...expand(piece, depth + 1));
    }
    return pieces;
  };

  const tracks: FlatTrack[] = doc.tracks.map((track) => {
    const clips: FlatClip[] = [];
    const firstPiece = new Map<string, string>();
    const lastPiece = new Map<string, string>();
    for (const c of track.clips) {
      const out = expand(c, 0);
      if (c.type === 'timeline') {
        const head = out.find((p) => p.start === c.start);
        const tail = out.find((p) => p.start + p.duration === c.start + c.duration);
        if (head) firstPiece.set(c.id, head.id);
        if (tail) lastPiece.set(c.id, tail.id);
      }
      clips.push(...out);
    }
    clips.sort((a, b) => a.start - b.start);
    const ids = new Set(clips.map((c) => c.id));
    const transitions: StoredTransition[] = [];
    for (const tr of track.transitions ?? []) {
      const a = lastPiece.get(tr.a) ?? tr.a;
      const b = firstPiece.get(tr.b) ?? tr.b;
      if (ids.has(a) && ids.has(b)) transitions.push({ ...tr, a, b });
      else w.add('Transitions next to nested timelines that were left out were dropped', tr.id);
    }
    const { transitions: _t, clips: _c, ...rest } = track;
    return { ...rest, clips, ...(transitions.length ? { transitions } : {}) };
  });
  return { tracks, media, tpf };
}

/** Whether a track is shown (video) or heard (audio). */
export function isPlaying(track: Pick<StoredTrack, 'kind' | 'hidden' | 'muted'>): boolean {
  return track.kind === 'video' ? !track.hidden : !track.muted;
}

/** Clip-to-clip transitions of a track, by the clip after the cut. */
export function transitionsInto(track: FlatTrack): Map<string, StoredTransition> {
  return new Map((track.transitions ?? []).map((t) => [t.b, t]));
}

/** Whether two clips are the picture and sound of the same source cut (a linked A/V pair). */
export function sameCut(v: FlatClip, a: FlatClip): boolean {
  return (
    v.type === 'media' &&
    a.type === 'media' &&
    v.link !== null &&
    v.link === a.link &&
    v.media_id === a.media_id &&
    v.start === a.start &&
    v.duration === a.duration &&
    v.in === a.in &&
    v.enabled === a.enabled &&
    JSON.stringify(v.speed ?? null) === JSON.stringify(a.speed ?? null)
  );
}

/** Name of a media item: from the resolver, else the document, else its id. */
export function mediaName(
  id: string,
  resolved: InterchangeMedia | undefined,
  media: Record<string, MediaRef>,
): string {
  return resolved?.name ?? media[id]?.name ?? id;
}
