import {
  type Animatable,
  CfError,
  type EditArgsOf,
  type EditTool,
  MASK_DEFAULTS,
  MASK_NUMBERS,
  type MediaRef,
  type NestedDoc,
  type Sequence,
  type StoredAnimatable,
  type StoredAnimation,
  type StoredClip,
  type StoredMask,
  type StoredSpeed,
  type StoredTrack,
  type StoredTransform,
  type StoredTransition,
  type TextStyle,
  type TimelineDoc,
  TRANSFORM_DEFAULTS,
  TRANSFORM_NUMBERS,
  type TrackKind,
} from '@cuttingfloor/schema';
import { checkKeyframes, toStoredAnim } from './animate.ts';
import { extended, frameSource, meanRate, span, subclip } from './speed.ts';
import { parseSubtitles } from './subtitles.ts';
import { framesToTicks, ticksPerFrame } from './time.ts';

/** Looks up media an edit refers to. Returns undefined for unknown ids. */
export type MediaResolver = (mediaId: string) => MediaRef | undefined;

/** Looks up a stored timeline an edit nests. Returns undefined for unknown or expired ids. */
export type TimelineResolver = (timelineId: string) => TimelineDoc | undefined;

/** What a nested timeline looks like as a source: its length and whether it has picture and sound. */
export function nestedRef(n: NestedDoc): MediaRef {
  const has = (kind: TrackKind) =>
    n.tracks.some((t) => t.kind === kind && t.clips.some((c) => c.enabled));
  return { name: n.name, duration: timelineEnd(n), video: has('video'), audio: has('audio') };
}

/** What a clip plays: its media, or the timeline it nests. */
export function clipSource(
  doc: Pick<TimelineDoc, 'media' | 'nested'>,
  clip: StoredClip,
): MediaRef | undefined {
  if (clip.type === 'media') return doc.media[clip.media_id];
  if (clip.type === 'timeline') {
    const nested = doc.nested?.[clip.timeline];
    return nested ? nestedRef(nested) : undefined;
  }
  // Text is generated: a picture with no natural length.
  return { name: clip.type, duration: null, video: true, audio: false };
}

export interface OpOutcome {
  clip_id?: string;
  clip_ids?: string[];
  track_id?: string;
  /** Timeline tick the preview centres on. */
  focus: number;
  /** Temporal edits preview as a filmstrip around `focus`; others as a still. */
  temporal: boolean;
  warnings: string[];
}

const STILL_DEFAULT_SECONDS = 5;

/** A fresh document with empty tracks. */
export function newTimeline(
  name: string,
  sequence: Sequence,
  tracks: { video: number; audio: number },
): TimelineDoc {
  ticksPerFrame(sequence.fps);
  const doc: TimelineDoc = {
    format: 'cuttingfloor.timeline',
    version: 2,
    name,
    sequence,
    tracks: [],
    media: {},
    next_id: 1,
    parent: null,
    op: null,
  };
  for (let i = 0; i < tracks.video; i++) addTrack(doc, 'video');
  for (let i = 0; i < tracks.audio; i++) addTrack(doc, 'audio');
  return doc;
}

/**
 * Applies one edit to `doc` in place. Callers pass a copy; documents are immutable once stored.
 * Throws CfError for invalid edits, leaving the copy unusable.
 */
export function applyEdit<T extends EditTool>(
  doc: TimelineDoc,
  tool: T,
  args: EditArgsOf<T>,
  media: MediaResolver,
  timelines: TimelineResolver = () => undefined,
): OpOutcome {
  const handlers: {
    [K in EditTool]: (
      doc: TimelineDoc,
      a: EditArgsOf<K>,
      m: MediaResolver,
      t: TimelineResolver,
    ) => OpOutcome;
  } = {
    'timeline.set_sequence': setSequence,
    'track.add': trackAdd,
    'track.remove': trackRemove,
    'track.set': trackSet,
    'clip.add': clipAdd,
    'clip.remove': clipRemove,
    'clip.move': clipMove,
    'clip.trim': clipTrim,
    'clip.split': clipSplit,
    'clip.link': clipLink,
    'clip.unlink': clipUnlink,
    'clip.set_enabled': clipSetEnabled,
    'clip.set_speed': clipSetSpeed,
    'clip.freeze': clipFreeze,
    'clip.roll': clipRoll,
    'clip.slip': clipSlip,
    'clip.slide': clipSlide,
    'clip.replace': clipReplace,
    'range.lift': (d, a) => rangeRemove(d, a, false),
    'range.extract': (d, a) => rangeRemove(d, a, true),
    'title.add': titleAdd,
    'caption.add': captionAdd,
    'text.set': textSet,
    'transition.add': transitionAdd,
    'transition.set': transitionSet,
    'transition.remove': transitionRemove,
    'clip.set_transform': clipSetTransform,
    'clip.set_blend': clipSetBlend,
    'clip.set_mask': clipSetMask,
    'clip.set_animation': clipSetAnimation,
  };
  const handler = handlers[tool] as (
    d: TimelineDoc,
    a: EditArgsOf<T>,
    m: MediaResolver,
    t: TimelineResolver,
  ) => OpOutcome;
  const outcome = handler(doc, args, media, timelines);
  pruneMedia(doc);
  outcome.warnings.push(...tidyTransitions(doc));
  return outcome;
}

// ---------------------------------------------------------------------------- helpers

function nextId(doc: TimelineDoc, prefix: string): string {
  const id = `${prefix}${doc.next_id}`;
  doc.next_id += 1;
  return id;
}

function addTrack(doc: TimelineDoc, kind: TrackKind, name?: string): StoredTrack {
  const count = doc.tracks.filter((t) => t.kind === kind).length;
  const track: StoredTrack = {
    id: nextId(doc, 't'),
    kind,
    name: name ?? `${kind === 'video' ? 'V' : 'A'}${count + 1}`,
    muted: false,
    hidden: false,
    locked: false,
    clips: [],
  };
  // Video tracks stay before audio tracks; a new track goes on top of its kind.
  const lastOfKind = doc.tracks.map((t) => t.kind).lastIndexOf(kind);
  const at = lastOfKind >= 0 ? lastOfKind + 1 : kind === 'video' ? 0 : doc.tracks.length;
  doc.tracks.splice(at, 0, track);
  return track;
}

function getTrack(doc: TimelineDoc, id: string): StoredTrack {
  const track = doc.tracks.find((t) => t.id === id);
  if (!track) {
    throw new CfError('not_found', `No track ${id}`, {
      hint: `Tracks: ${doc.tracks.map((t) => `${t.id} (${t.kind} ${t.name})`).join(', ') || 'none'}`,
    });
  }
  return track;
}

interface Located {
  track: StoredTrack;
  clip: StoredClip;
}

function locate(doc: TimelineDoc, clipId: string): Located {
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  const ids = doc.tracks.flatMap((t) => t.clips.map((c) => c.id));
  throw new CfError('not_found', `No clip ${clipId}`, {
    hint: ids.length ? `Clips: ${ids.slice(0, 40).join(', ')}` : 'The timeline has no clips',
  });
}

/** The clip plus every clip linked to it. */
function group(doc: TimelineDoc, clipId: string): Located[] {
  const first = locate(doc, clipId);
  if (!first.clip.link) return [first];
  const link = first.clip.link;
  return doc.tracks.flatMap((track) =>
    track.clips.filter((c) => c.link === link).map((clip) => ({ track, clip })),
  );
}

function assertUnlocked(track: StoredTrack): void {
  if (track.locked) {
    throw new CfError('bad_request', `Track ${track.id} (${track.name}) is locked`, {
      hint: `Unlock it with track.set {track_id: "${track.id}", locked: false}`,
    });
  }
}

const end = (c: StoredClip) => c.start + c.duration;

function sortTrack(track: StoredTrack): void {
  track.clips.sort((a, b) => a.start - b.start);
}

function trackEnd(track: StoredTrack): number {
  return track.clips.reduce((max, c) => Math.max(max, end(c)), 0);
}

function removeClip(track: StoredTrack, clip: StoredClip): void {
  track.clips = track.clips.filter((c) => c !== clip);
}

/** A copy of `c` showing a different part of its source: new `in`, duration and speed. */
function retimed(
  c: StoredClip,
  timing: { in: number; duration: number; speed?: StoredSpeed | undefined },
  extra: { id?: string; start?: number } = {},
): StoredClip {
  const copy: StoredClip = { ...c, ...extra, in: timing.in, duration: timing.duration };
  if (timing.speed) copy.speed = timing.speed;
  else delete copy.speed;
  return copy;
}

/** Changes a clip's timing in place. */
function setTiming(
  c: StoredClip,
  timing: { in: number; duration: number; speed?: StoredSpeed | undefined },
): void {
  c.in = timing.in;
  c.duration = timing.duration;
  if (timing.speed) c.speed = timing.speed;
  else delete c.speed;
}

/** Moves one edge of a clip by `delta` ticks (positive is later), cutting or growing its content. */
function moveEdge(c: StoredClip, edge: 'start' | 'end', delta: number): void {
  if (delta === 0) return;
  const grow = edge === 'end' ? delta > 0 : delta < 0;
  const by = Math.abs(delta);
  if (c.duration - (grow ? 0 : by) <= 0) {
    throw new CfError('bad_request', `Trim would leave clip ${c.id} with no frames`);
  }
  if (grow) setTiming(c, extended(c, edge, by));
  else setTiming(c, edge === 'end' ? subclip(c, 0, c.duration - by) : subclip(c, by, c.duration));
  if (edge === 'start') c.start += delta;
}

/**
 * Clears [from, to) on a track, cutting clips that cross the edges (overwrite edit). Returns
 * the right-hand pieces it made from clips that crossed `from`.
 */
function clearRange(doc: TimelineDoc, track: StoredTrack, from: number, to: number): StoredClip[] {
  const kept: StoredClip[] = [];
  const made: StoredClip[] = [];
  for (const c of track.clips) {
    const cEnd = end(c);
    if (cEnd <= from || c.start >= to) {
      kept.push(c);
      continue;
    }
    const left = c.start < from ? retimed(c, subclip(c, 0, from - c.start)) : undefined;
    if (left) kept.push(left);
    if (cEnd > to) {
      const right = retimed(c, subclip(c, to - c.start, c.duration), {
        id: left ? nextId(doc, 'c') : c.id,
        start: to,
      });
      if (left) {
        splitAnimation(left, right);
        made.push(right);
      } else dropAnimation(right, 'in');
      kept.push(right);
    } else if (left) dropAnimation(left, 'out');
  }
  track.clips = kept;
  sortTrack(track);
  return made;
}

/** Splits the clip that crosses `at`, if any. Returns the new right-hand clip. */
function splitTrackAt(doc: TimelineDoc, track: StoredTrack, at: number): StoredClip | undefined {
  const c = track.clips.find((x) => x.start < at && end(x) > at);
  if (!c) return undefined;
  const left = at - c.start;
  const right = retimed(c, subclip(c, left, c.duration), { id: nextId(doc, 'c'), start: at });
  setTiming(c, subclip(c, 0, left));
  splitAnimation(c, right);
  track.clips.push(right);
  sortTrack(track);
  return right;
}

/** An entrance stays on the left half of a cut, an exit on the right half. */
function splitAnimation(left: StoredClip, right: StoredClip): void {
  dropAnimation(left, 'out');
  dropAnimation(right, 'in');
}

function dropAnimation(clip: StoredClip, part: 'in' | 'out'): void {
  if (!clip.animation?.[part]) return;
  const { [part]: _gone, ...rest } = clip.animation;
  if (Object.keys(rest).length) clip.animation = rest;
  else delete clip.animation;
}

/** Moves every clip starting at or after `at` by `delta` (except `skip`). */
function shiftFrom(track: StoredTrack, at: number, delta: number, skip?: StoredClip): void {
  if (delta === 0) return;
  for (const c of track.clips) {
    if (c !== skip && c.start >= at) c.start += delta;
  }
  if (track.clips.some((c) => c.start < 0)) {
    throw new CfError('bad_request', 'The edit would move clips before frame 0');
  }
  sortTrack(track);
}

/** Puts a clip on a track with overwrite or insert semantics. */
function place(
  doc: TimelineDoc,
  track: StoredTrack,
  clip: StoredClip,
  mode: 'overwrite' | 'insert',
): void {
  if (mode === 'insert') {
    splitTrackAt(doc, track, clip.start);
    shiftFrom(track, clip.start, clip.duration);
  } else {
    clearRange(doc, track, clip.start, end(clip));
  }
  track.clips.push(clip);
  sortTrack(track);
}

/** Takes clips off their tracks; with ripple, later clips close each gap (latest gap first). */
function removeAndRipple(members: Located[], ripple: boolean): void {
  for (const { track, clip } of members) removeClip(track, clip);
  if (!ripple) return;
  const byStartDesc = [...members].sort((x, y) => y.clip.start - x.clip.start);
  for (const { track, clip } of byStartDesc) shiftFrom(track, end(clip), -clip.duration);
}

function neighbours(track: StoredTrack, clip: StoredClip): { prevEnd: number; nextStart: number } {
  let prevEnd = 0;
  let nextStart = Number.POSITIVE_INFINITY;
  for (const c of track.clips) {
    if (c === clip) continue;
    if (end(c) <= clip.start) prevEnd = Math.max(prevEnd, end(c));
    else if (c.start >= end(clip)) nextStart = Math.min(nextStart, c.start);
  }
  return { prevEnd, nextStart };
}

function checkSourceRange(doc: TimelineDoc, clip: StoredClip): void {
  const media = clipSource(doc, clip);
  if (clip.in < 0) {
    throw new CfError(
      'bad_request',
      `Clip ${clip.id} would start before the beginning of its media`,
      {
        hint: 'Trim less, or use a later source in-point',
      },
    );
  }
  // A freeze frame covers no source span but still needs the frame it holds.
  const last = clip.in + Math.max(span(clip), 1);
  if (media?.duration != null && last > media.duration) {
    const tpf = ticksPerFrame(doc.sequence.fps);
    throw new CfError('bad_request', `Clip ${clip.id} would run past the end of its media`, {
      hint: `The media is ${Math.floor(media.duration / tpf)} frames long`,
    });
  }
}

/** Removes media and nested timelines no clip uses, so equal timelines hash equal. */
function pruneMedia(doc: TimelineDoc): void {
  const clips = doc.tracks.flatMap((t) => t.clips);
  const used = new Set(clips.flatMap((c) => (c.type === 'media' ? [c.media_id] : [])));
  for (const id of Object.keys(doc.media)) if (!used.has(id)) delete doc.media[id];
  if (!doc.nested) return;
  const reached = new Set<string>();
  const visit = (cs: StoredClip[]) => {
    for (const c of cs) {
      if (c.type !== 'timeline' || reached.has(c.timeline)) continue;
      reached.add(c.timeline);
      visit(doc.nested?.[c.timeline]?.tracks.flatMap((t) => t.clips) ?? []);
    }
  };
  visit(clips);
  for (const key of Object.keys(doc.nested)) if (!reached.has(key)) delete doc.nested[key];
  if (!Object.keys(doc.nested).length) delete doc.nested;
}

/** Drops link ids that no longer join at least two clips. */
function tidyLinks(doc: TimelineDoc): void {
  const counts = new Map<string, number>();
  for (const t of doc.tracks)
    for (const c of t.clips) if (c.link) counts.set(c.link, (counts.get(c.link) ?? 0) + 1);
  for (const t of doc.tracks)
    for (const c of t.clips) if (c.link && (counts.get(c.link) ?? 0) < 2) c.link = null;
}

const ok = (focus: number, extra: Partial<OpOutcome> = {}): OpOutcome => ({
  focus,
  temporal: false,
  warnings: [],
  ...extra,
});

// ---------------------------------------------------------------------------- operations

function setSequence(doc: TimelineDoc, a: EditArgsOf<'timeline.set_sequence'>): OpOutcome {
  ticksPerFrame(a.sequence.fps);
  doc.sequence = a.sequence;
  return ok(0);
}

function trackAdd(doc: TimelineDoc, a: EditArgsOf<'track.add'>): OpOutcome {
  const track = addTrack(doc, a.kind, a.name);
  return ok(0, { track_id: track.id });
}

function trackRemove(doc: TimelineDoc, a: EditArgsOf<'track.remove'>): OpOutcome {
  const track = getTrack(doc, a.track_id);
  assertUnlocked(track);
  doc.tracks = doc.tracks.filter((t) => t !== track);
  tidyLinks(doc);
  return ok(0, { track_id: track.id });
}

function trackSet(doc: TimelineDoc, a: EditArgsOf<'track.set'>): OpOutcome {
  const track = getTrack(doc, a.track_id);
  if (a.name !== undefined) track.name = a.name;
  if (a.muted !== undefined) track.muted = a.muted;
  if (a.hidden !== undefined) track.hidden = a.hidden;
  if (a.locked !== undefined) track.locked = a.locked;
  const first = track.clips[0];
  return ok(first ? first.start : 0, { track_id: track.id });
}

/** Copies a timeline into `doc.nested` (with everything it nests) and returns its key. */
function nest(doc: TimelineDoc, id: string, resolveTimeline: TimelineResolver): string {
  const source = resolveTimeline(id);
  if (!source) {
    throw new CfError('not_found', `No timeline ${id} to nest`, {
      hint: 'Timelines expire 24 hours after last use; timeline.load brings one back',
    });
  }
  const { parent: _p, op: _o, nested, ...body } = source;
  doc.nested = { ...doc.nested, ...nested, [id]: body };
  if (!timelineEnd(body)) {
    throw new CfError('bad_request', `Timeline ${id} is empty, so there is nothing to nest`);
  }
  return id;
}

function clipAdd(
  doc: TimelineDoc,
  a: EditArgsOf<'clip.add'>,
  resolve: MediaResolver,
  resolveTimeline: TimelineResolver,
): OpOutcome {
  if (Boolean(a.media_id) === Boolean(a.nested_timeline_id)) {
    throw new CfError('bad_request', 'Give media_id or nested_timeline_id, not both');
  }
  const key = a.nested_timeline_id ? nest(doc, a.nested_timeline_id, resolveTimeline) : undefined;
  const mediaId = a.media_id ?? '';
  const media = key ? nestedRef(doc.nested?.[key] as NestedDoc) : resolve(mediaId);
  if (!media) {
    throw new CfError('not_found', `No media ${mediaId}`, {
      hint: 'Import it first with media.import; media expires 7 days after last use',
    });
  }
  if (!key) doc.media[mediaId] = media;
  const primary = getTrack(doc, a.track_id);
  const kinds: TrackKind[] =
    a.av === 'linked'
      ? ([media.video ? 'video' : null, media.audio ? 'audio' : null].filter(
          Boolean,
        ) as TrackKind[])
      : [a.av];
  if (!kinds.includes(primary.kind)) {
    const has = [media.video && 'video', media.audio && 'audio'].filter(Boolean).join(' and ');
    throw new CfError(
      'bad_request',
      `Track ${primary.id} is a ${primary.kind} track, but this clip has no ${primary.kind}`,
      {
        hint: has
          ? `The media has ${has}; pick a matching track or set av`
          : 'It has no picture or sound: a font is used through font_media_id in a text style',
      },
    );
  }
  if (a.av !== 'linked' && !(a.av === 'video' ? media.video : media.audio)) {
    throw new CfError('bad_request', `The media has no ${a.av} stream`);
  }
  const targets = new Map<TrackKind, StoredTrack>([[primary.kind, primary]]);
  for (const kind of kinds) {
    if (targets.has(kind)) continue;
    const other = a.link_track_id
      ? getTrack(doc, a.link_track_id)
      : (doc.tracks.find((t) => t.kind === kind) ?? addTrack(doc, kind));
    if (other.kind !== kind) {
      throw new CfError('bad_request', `link_track_id ${other.id} must be a ${kind} track`);
    }
    targets.set(kind, other);
  }
  for (const t of targets.values()) assertUnlocked(t);

  const fps = doc.sequence.fps;
  let inTicks: number;
  let duration: number;
  if (a.source) {
    if (a.source.out <= a.source.in) {
      throw new CfError(
        'bad_request',
        'source.out must be greater than source.in (out is exclusive)',
      );
    }
    inTicks = framesToTicks(a.source.in, fps);
    duration = framesToTicks(a.source.out - a.source.in, fps);
  } else if (media.duration === null) {
    inTicks = 0;
    duration = framesToTicks(
      a.duration_frames ?? Math.round((STILL_DEFAULT_SECONDS * fps.num) / fps.den),
      fps,
    );
  } else {
    inTicks = 0;
    const tpf = ticksPerFrame(fps);
    duration = Math.floor(media.duration / tpf) * tpf;
    if (duration <= 0) throw new CfError('bad_request', 'The media is shorter than one frame');
  }

  let start: number;
  if (a.at_frame !== undefined) start = framesToTicks(a.at_frame, fps);
  else if (a.after_clip_id) start = end(locate(doc, a.after_clip_id).clip);
  else start = Math.max(...[...targets.values()].map(trackEnd));

  const link = targets.size > 1 ? nextId(doc, 'l') : null;
  const made: StoredClip[] = [];
  for (const [kind, track] of targets) {
    const clip: StoredClip = {
      id: nextId(doc, 'c'),
      ...(key
        ? { type: 'timeline' as const, timeline: key }
        : { type: 'media' as const, media_id: mediaId }),
      kind,
      start,
      in: inTicks,
      duration,
      link,
      enabled: true,
    };
    checkSourceRange(doc, clip);
    place(doc, track, clip, a.mode);
    made.push(clip);
  }
  const main = made.find((c) => c.kind === primary.kind) ?? made[0];
  return ok(start, { clip_id: main?.id ?? '', clip_ids: made.map((c) => c.id) });
}

function clipRemove(doc: TimelineDoc, a: EditArgsOf<'clip.remove'>): OpOutcome {
  const members = group(doc, a.clip_id);
  for (const m of members) assertUnlocked(m.track);
  removeAndRipple(members, a.ripple);
  const ref = members.find((m) => m.clip.id === a.clip_id) ?? members[0];
  return ok(ref ? ref.clip.start : 0, { clip_ids: members.map((m) => m.clip.id) });
}

function clipMove(doc: TimelineDoc, a: EditArgsOf<'clip.move'>): OpOutcome {
  const members = group(doc, a.clip_id);
  const ref = members.find((m) => m.clip.id === a.clip_id);
  if (!ref) throw new CfError('not_found', `No clip ${a.clip_id}`);
  const delta = framesToTicks(a.to_frame, doc.sequence.fps) - ref.clip.start;
  const destination = a.to_track_id ? getTrack(doc, a.to_track_id) : ref.track;
  if (destination.kind !== ref.clip.kind) {
    throw new CfError(
      'bad_request',
      `Cannot move a ${ref.clip.kind} clip to ${destination.kind} track ${destination.id}`,
    );
  }
  for (const m of members) assertUnlocked(m.track);
  assertUnlocked(destination);
  removeAndRipple(members, a.ripple);
  for (const m of members) {
    const moved = { ...m.clip, start: m.clip.start + delta };
    if (moved.start < 0)
      throw new CfError('bad_request', 'The move would put a linked clip before frame 0');
    place(doc, m === ref ? destination : m.track, moved, a.mode);
  }
  return ok(ref.clip.start + delta, {
    clip_id: ref.clip.id,
    clip_ids: members.map((m) => m.clip.id),
    temporal: true,
  });
}

function clipTrim(doc: TimelineDoc, a: EditArgsOf<'clip.trim'>): OpOutcome {
  const all = group(doc, a.clip_id);
  const ref = all.find((m) => m.clip.id === a.clip_id);
  if (!ref) throw new CfError('not_found', `No clip ${a.clip_id}`);
  const members = a.side === 'both' ? all : all.filter((m) => m.clip.kind === a.side);
  if (!members.length) {
    throw new CfError('bad_request', `Clip ${a.clip_id} has no ${a.side} part to trim`);
  }
  const target = framesToTicks(a.to_frame, doc.sequence.fps);
  const delta = a.edge === 'end' ? target - end(ref.clip) : target - ref.clip.start;
  for (const m of members) assertUnlocked(m.track);
  for (const { track, clip } of members) {
    const oldEnd = end(clip);
    const { prevEnd, nextStart } = neighbours(track, clip);
    if (a.edge === 'end') {
      moveEdge(clip, 'end', delta);
      checkSourceRange(doc, clip);
      if (a.ripple) shiftFrom(track, oldEnd, delta, clip);
      else if (end(clip) > nextStart) {
        throw new CfError('bad_request', `Extending clip ${clip.id} would overlap the next clip`, {
          hint: 'Use ripple: true to push later clips, or trim the next clip first',
        });
      }
    } else if (a.ripple) {
      // Ripple head trim: the clip keeps its position, its content shifts, later clips follow.
      const start = clip.start;
      moveEdge(clip, 'start', delta);
      clip.start = start;
      checkSourceRange(doc, clip);
      shiftFrom(track, oldEnd, -delta, clip);
    } else {
      moveEdge(clip, 'start', delta);
      if (clip.start < 0)
        throw new CfError('bad_request', 'Trim would move the clip before frame 0');
      checkSourceRange(doc, clip);
      if (clip.start < prevEnd) {
        throw new CfError(
          'bad_request',
          `Extending clip ${clip.id} would overlap the previous clip`,
          {
            hint: 'Trim the previous clip first, or use ripple: true',
          },
        );
      }
    }
    sortTrack(track);
  }
  const focus = a.edge === 'end' ? end(ref.clip) : ref.clip.start;
  return ok(focus, {
    clip_id: ref.clip.id,
    clip_ids: members.map((m) => m.clip.id),
    temporal: true,
  });
}

function clipSplit(doc: TimelineDoc, a: EditArgsOf<'clip.split'>): OpOutcome {
  const members = group(doc, a.clip_id);
  const at = framesToTicks(a.at_frame, doc.sequence.fps);
  const ref = members.find((m) => m.clip.id === a.clip_id);
  if (!ref || !(ref.clip.start < at && end(ref.clip) > at)) {
    const tpf = ticksPerFrame(doc.sequence.fps);
    const c = ref?.clip;
    throw new CfError('bad_request', `Frame ${a.at_frame} is not inside clip ${a.clip_id}`, {
      ...(c ? { hint: `The clip covers frames ${c.start / tpf} to ${end(c) / tpf - 1}` } : {}),
    });
  }
  for (const m of members) assertUnlocked(m.track);
  const rights: StoredClip[] = [];
  for (const { track, clip } of members) {
    if (!(clip.start < at && end(clip) > at)) continue;
    const right = splitTrackAt(doc, track, at);
    if (right) rights.push(right);
  }
  const link = rights.length > 1 ? nextId(doc, 'l') : null;
  for (const r of rights) r.link = link;
  tidyLinks(doc);
  const main = rights.find((r) => r.kind === ref.clip.kind);
  return ok(at, { clip_id: main?.id ?? '', clip_ids: rights.map((r) => r.id), temporal: true });
}

function clipLink(doc: TimelineDoc, a: EditArgsOf<'clip.link'>): OpOutcome {
  const found = a.clip_ids.map((id) => locate(doc, id));
  const link = nextId(doc, 'l');
  for (const { clip } of found) clip.link = link;
  tidyLinks(doc);
  return ok(found[0]?.clip.start ?? 0, { clip_ids: a.clip_ids });
}

function clipUnlink(doc: TimelineDoc, a: EditArgsOf<'clip.unlink'>): OpOutcome {
  const members = group(doc, a.clip_id);
  for (const { clip } of members) clip.link = null;
  return ok(members[0]?.clip.start ?? 0, { clip_ids: members.map((m) => m.clip.id) });
}

function clipSetEnabled(doc: TimelineDoc, a: EditArgsOf<'clip.set_enabled'>): OpOutcome {
  const { track, clip } = locate(doc, a.clip_id);
  assertUnlocked(track);
  clip.enabled = a.enabled;
  return ok(clip.start, { clip_id: clip.id });
}

/** The clip a timing edit applies to, plus its linked clips, all unlocked. */
function unlockedGroup(doc: TimelineDoc, clipId: string): { ref: Located; members: Located[] } {
  const members = group(doc, clipId);
  const ref = members.find((m) => m.clip.id === clipId);
  if (!ref) throw new CfError('not_found', `No clip ${clipId}`);
  for (const m of members) assertUnlocked(m.track);
  return { ref, members };
}

function isStill(doc: TimelineDoc, clip: StoredClip): boolean {
  return clip.type === 'media' && doc.media[clip.media_id]?.duration === null;
}

/** Speed runs through a remapped media file, so nested timelines refuse it. */
function assertRetimable(clip: StoredClip, what: string): void {
  if (clip.type === 'timeline') {
    throw new CfError(
      'bad_request',
      `${what} applies to media clips; ${clip.id} is a nested timeline`,
      {
        hint: 'Change the speed of the clips inside the nested timeline, then nest it again',
      },
    );
  }
}

function clipSetSpeed(doc: TimelineDoc, a: EditArgsOf<'clip.set_speed'>): OpOutcome {
  if (a.rate !== undefined && a.curve) {
    throw new CfError('bad_request', 'Give rate or curve, not both');
  }
  if (a.curve) {
    const first = a.curve[0];
    const last = a.curve[a.curve.length - 1];
    if (
      first?.at !== 0 ||
      last?.at !== 1 ||
      a.curve.some((p, i) => i && p.at <= (a.curve?.[i - 1]?.at ?? 0))
    ) {
      throw new CfError('bad_request', 'A speed curve runs from at 0 to at 1 in increasing order', {
        hint: 'e.g. [{at: 0, rate: 1}, {at: 0.5, rate: 4}, {at: 1, rate: 1}]',
      });
    }
  }
  const { ref, members } = unlockedGroup(doc, a.clip_id);
  for (const m of members) assertRetimable(m.clip, 'clip.set_speed');
  if (isStill(doc, ref.clip)) {
    throw new CfError('bad_request', `Clip ${a.clip_id} is a still image, which has no speed`, {
      hint: 'Change its length with clip.trim instead',
    });
  }
  const tpf = ticksPerFrame(doc.sequence.fps);
  for (const { track, clip } of members) {
    const oldEnd = end(clip);
    const sourceSpan = Math.max(span(clip), tpf);
    const old = clip.speed;
    const reverse = a.reverse ?? old?.reverse;
    const pitch = a.preserve_pitch ?? old?.preserve_pitch;
    let duration = clip.duration;
    let speed: StoredSpeed = {};
    if (a.rate !== undefined || a.curve) {
      // The clip keeps the same source span and gets as long as the new speed makes it.
      const mean = a.curve ? meanRate(a.curve) : (a.rate as number);
      // Whole frames, rounded down so the clip never reaches past the source it had.
      duration = Math.max(tpf, Math.floor(sourceSpan / mean / tpf) * tpf);
      if (a.curve) {
        speed = { curve: a.curve.map((p) => ({ t: Math.round(p.at * duration), rate: p.rate })) };
      } else if (a.rate !== 1) speed = { rate: a.rate as number };
    } else if (old?.curve) speed = { curve: old.curve };
    else if (old?.rate !== undefined) speed = { rate: old.rate };
    if (reverse) speed.reverse = true;
    if (pitch === false) speed.preserve_pitch = false;
    clip.duration = duration;
    if (Object.keys(speed).length) clip.speed = speed;
    else delete clip.speed;
    checkSourceRange(doc, clip);
    const delta = end(clip) - oldEnd;
    if (a.ripple) shiftFrom(track, oldEnd, delta, clip);
    else if (delta > 0 && end(clip) > neighbours(track, clip).nextStart) {
      throw new CfError(
        'bad_request',
        `Clip ${clip.id} would overlap the next clip at this speed`,
        {
          hint: 'Use ripple: true to push later clips, or make room first',
        },
      );
    }
    sortTrack(track);
  }
  return ok(ref.clip.start, {
    clip_id: ref.clip.id,
    clip_ids: members.map((m) => m.clip.id),
    temporal: true,
  });
}

function clipFreeze(doc: TimelineDoc, a: EditArgsOf<'clip.freeze'>): OpOutcome {
  const { ref, members } = unlockedGroup(doc, a.clip_id);
  const video = members.find((m) => m.clip.kind === 'video');
  if (!video) {
    throw new CfError('bad_request', `Clip ${a.clip_id} has no picture to freeze`);
  }
  assertRetimable(video.clip, 'clip.freeze');
  const fps = doc.sequence.fps;
  const at = framesToTicks(a.at_frame, fps);
  const v = video.clip;
  if (at < v.start || at >= end(v)) {
    throw new CfError('bad_request', `Frame ${a.at_frame} is not inside clip ${v.id}`, {
      hint: `The clip covers frames ${v.start / ticksPerFrame(fps)} to ${end(v) / ticksPerFrame(fps) - 1}`,
    });
  }
  const tpf = ticksPerFrame(fps);
  const held = Math.round(frameSource(v, tpf, Math.round((at - v.start) / tpf)));
  const duration = framesToTicks(a.duration_frames, fps);
  const tracks = [...new Set(members.map((m) => m.track))];
  const rights: StoredClip[] = [];
  for (const track of tracks) {
    const right = splitTrackAt(doc, track, at);
    if (right) rights.push(right);
  }
  const link = rights.length > 1 ? nextId(doc, 'l') : null;
  for (const r of rights) r.link = link;
  // Everything from the frame on moves later on the clip's tracks; its sound has a gap there.
  for (const track of tracks) shiftFrom(track, at, duration);
  const { speed: _s, animation: _a, ...look } = v;
  const frozen: StoredClip = {
    ...look,
    id: nextId(doc, 'c'),
    start: at,
    in: held,
    duration,
    link: null,
    speed: { rate: 0 },
  };
  video.track.clips.push(frozen);
  sortTrack(video.track);
  tidyLinks(doc);
  return ok(at, { clip_id: frozen.id, temporal: true });
}

/** The clip on the same track that starts exactly where `clip` ends, and the one that ends where it starts. */
function touching(
  track: StoredTrack,
  clip: StoredClip,
): { before?: StoredClip; after?: StoredClip } {
  const before = track.clips.find((c) => c !== clip && end(c) === clip.start);
  const after = track.clips.find((c) => c !== clip && c.start === end(clip));
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

function clipRoll(doc: TimelineDoc, a: EditArgsOf<'clip.roll'>): OpOutcome {
  const { ref, members } = unlockedGroup(doc, a.clip_id);
  const to = framesToTicks(a.to_frame, doc.sequence.fps);
  const delta = to - end(ref.clip);
  if (!touching(ref.track, ref.clip).after) {
    throw new CfError(
      'bad_request',
      `No clip starts where ${a.clip_id} ends, so there is no cut to roll`,
      {
        hint: 'Use clip.trim to move one edge on its own',
      },
    );
  }
  const changed: string[] = [];
  for (const { track, clip } of members) {
    const { after } = touching(track, clip);
    if (after) {
      assertUnlocked(track);
      moveEdge(after, 'start', delta);
      checkSourceRange(doc, after);
      changed.push(after.id);
    } else if (delta > 0 && end(clip) + delta > neighbours(track, clip).nextStart) {
      throw new CfError(
        'bad_request',
        `Rolling would push linked clip ${clip.id} into the next clip`,
      );
    }
    moveEdge(clip, 'end', delta);
    checkSourceRange(doc, clip);
    changed.push(clip.id);
    sortTrack(track);
  }
  return ok(to, { clip_id: ref.clip.id, clip_ids: changed, temporal: true });
}

function clipSlip(doc: TimelineDoc, a: EditArgsOf<'clip.slip'>): OpOutcome {
  const { ref, members } = unlockedGroup(doc, a.clip_id);
  const by = framesToTicks(a.by_frames, doc.sequence.fps);
  for (const { clip } of members) {
    if (isStill(doc, clip)) continue;
    clip.in += by;
    checkSourceRange(doc, clip);
  }
  return ok(ref.clip.start, {
    clip_id: ref.clip.id,
    clip_ids: members.map((m) => m.clip.id),
    temporal: true,
  });
}

function clipSlide(doc: TimelineDoc, a: EditArgsOf<'clip.slide'>): OpOutcome {
  const { ref, members } = unlockedGroup(doc, a.clip_id);
  const delta = framesToTicks(a.to_frame, doc.sequence.fps) - ref.clip.start;
  const changed: string[] = [];
  for (const { track, clip } of members) {
    const { before, after } = touching(track, clip);
    const { prevEnd, nextStart } = neighbours(track, clip);
    if (!before && clip.start + delta < prevEnd) {
      throw new CfError('bad_request', `Sliding clip ${clip.id} would overlap the clip before it`);
    }
    if (!after && end(clip) + delta > nextStart) {
      throw new CfError('bad_request', `Sliding clip ${clip.id} would overlap the clip after it`);
    }
    if (clip.start + delta < 0)
      throw new CfError('bad_request', 'The slide would move the clip before frame 0');
    if (before) {
      moveEdge(before, 'end', delta);
      checkSourceRange(doc, before);
      changed.push(before.id);
    }
    if (after) {
      moveEdge(after, 'start', delta);
      checkSourceRange(doc, after);
      changed.push(after.id);
    }
    clip.start += delta;
    changed.push(clip.id);
    sortTrack(track);
  }
  return ok(ref.clip.start, { clip_id: ref.clip.id, clip_ids: changed, temporal: true });
}

function clipReplace(
  doc: TimelineDoc,
  a: EditArgsOf<'clip.replace'>,
  resolve: MediaResolver,
): OpOutcome {
  const { track, clip: found } = locate(doc, a.clip_id);
  assertUnlocked(track);
  const media = resolve(a.media_id);
  if (!media) {
    throw new CfError('not_found', `No media ${a.media_id}`, {
      hint: 'Import it first with media.import; media expires 7 days after last use',
    });
  }
  if (found.kind === 'video' ? !media.video : !media.audio) {
    throw new CfError(
      'bad_request',
      `Media ${a.media_id} has no ${found.kind} for clip ${found.id}`,
    );
  }
  doc.media[a.media_id] = media;
  // The clip keeps its place and look; a nested timeline swapped for media becomes a media clip.
  const { timeline: _t, media_id: _m, ...look } = { timeline: '', media_id: '', ...found };
  const clip: StoredClip = {
    ...look,
    type: 'media',
    media_id: a.media_id,
    in: framesToTicks(a.source_in ?? 0, doc.sequence.fps),
  };
  track.clips = track.clips.map((c) => (c === found ? clip : c));
  if (media.duration === null) delete clip.speed;
  checkSourceRange(doc, clip);
  return ok(clip.start, { clip_id: clip.id });
}

function rangeRemove(doc: TimelineDoc, a: EditArgsOf<'range.lift'>, ripple: boolean): OpOutcome {
  const fps = doc.sequence.fps;
  const from = framesToTicks(a.range.start, fps);
  const to = framesToTicks(a.range.end, fps);
  const tracks = a.track_ids
    ? a.track_ids.map((id) => getTrack(doc, id))
    : doc.tracks.filter((t) => !t.locked);
  for (const t of tracks) assertUnlocked(t);
  const before = new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  // Pieces cut off the right of a linked clip form their own link group.
  const relinked = new Map<string, string>();
  for (const track of tracks) {
    for (const piece of clearRange(doc, track, from, to)) {
      if (!piece.link) continue;
      const link = relinked.get(piece.link) ?? nextId(doc, 'l');
      relinked.set(piece.link, link);
      piece.link = link;
    }
    if (ripple) shiftFrom(track, to, from - to);
  }
  tidyLinks(doc);
  const removed = [...before].filter(
    (id) => !doc.tracks.some((t) => t.clips.some((c) => c.id === id)),
  );
  return ok(from, { clip_ids: removed, temporal: true });
}

// ------------------------------------------------------------------------------------ text

function textTrack(doc: TimelineDoc, trackId: string): StoredTrack {
  const track = getTrack(doc, trackId);
  if (track.kind !== 'video') {
    throw new CfError('bad_request', `Text goes on a video track; ${track.id} is audio`, {
      hint: `Video tracks: ${
        doc.tracks
          .filter((t) => t.kind === 'video')
          .map((t) => t.id)
          .join(', ') || 'none (track.add one)'
      }`,
    });
  }
  assertUnlocked(track);
  return track;
}

/**
 * Applies a style patch: a value sets a field and an absent field stays. null turns an
 * outline, shadow, box or highlight off (it overrides the default), so it is kept.
 */
function mergeStyle(
  base: TextStyle | undefined,
  patch: TextStyle | undefined,
): TextStyle | undefined {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? (out as TextStyle) : undefined;
}

function titleAdd(doc: TimelineDoc, a: EditArgsOf<'title.add'>): OpOutcome {
  const track = textTrack(doc, a.track_id);
  const fps = doc.sequence.fps;
  const start = a.at_frame !== undefined ? framesToTicks(a.at_frame, fps) : trackEnd(track);
  const duration = framesToTicks(a.duration_frames ?? Math.round((3 * fps.num) / fps.den), fps);
  const style = mergeStyle(undefined, a.style);
  const clip: StoredClip = {
    id: nextId(doc, 'c'),
    type: 'title',
    kind: 'video',
    text: a.text,
    ...(style ? { style } : {}),
    start,
    in: 0,
    duration,
    link: null,
    enabled: true,
  };
  place(doc, track, clip, 'overwrite');
  return ok(start, { clip_id: clip.id });
}

function captionAdd(doc: TimelineDoc, a: EditArgsOf<'caption.add'>): OpOutcome {
  const given = [a.segments, a.srt, a.vtt].filter((x) => x !== undefined).length;
  if (given !== 1) {
    throw new CfError('bad_request', 'Give exactly one of segments, srt or vtt');
  }
  const track = textTrack(doc, a.track_id);
  const fps = doc.sequence.fps;
  const tpf = ticksPerFrame(fps);
  const toFrame = (sec: number) => Math.round((sec * fps.num) / fps.den) + a.offset_frames;
  const segments =
    a.segments ??
    parseSubtitles((a.srt ?? a.vtt) as string, a.srt !== undefined ? 'srt' : 'vtt').map((cue) => ({
      start_frame: toFrame(cue.start),
      end_frame: toFrame(cue.end),
      text: cue.text,
      ...(cue.words
        ? {
            words: cue.words.map((w) => ({
              text: w.text,
              start_frame: toFrame(w.start),
              end_frame: toFrame(w.end),
            })),
          }
        : {}),
    }));
  const style = mergeStyle(undefined, a.style);
  const ids: string[] = [];
  for (const seg of segments) {
    if (seg.start_frame < 0) {
      throw new CfError(
        'bad_request',
        `A caption starts before frame 0 (${seg.text.slice(0, 40)})`,
        {
          hint: 'Use offset_frames to move them later',
        },
      );
    }
    if (seg.end_frame <= seg.start_frame) {
      throw new CfError('bad_request', `Caption "${seg.text.slice(0, 40)}" ends before it starts`);
    }
    const start = seg.start_frame * tpf;
    const words = seg.words?.map((w) => {
      if (w.end_frame < w.start_frame) {
        throw new CfError('bad_request', `Word "${w.text}" ends before it starts`);
      }
      // Word times are on the caption's own clock, which starts at 0.
      return {
        text: w.text,
        t: (w.start_frame - seg.start_frame) * tpf,
        end: (w.end_frame - seg.start_frame) * tpf,
      };
    });
    const clip: StoredClip = {
      id: nextId(doc, 'c'),
      type: 'caption',
      kind: 'video',
      text: seg.text,
      ...(words?.length ? { words } : {}),
      ...(style ? { style } : {}),
      start,
      in: 0,
      duration: (seg.end_frame - seg.start_frame) * tpf,
      link: null,
      enabled: true,
    };
    place(doc, track, clip, 'overwrite');
    ids.push(clip.id);
  }
  const first = segments[0];
  return ok(first ? first.start_frame * tpf : 0, {
    clip_ids: ids,
    ...(ids[0] ? { clip_id: ids[0] } : {}),
  });
}

function textSet(doc: TimelineDoc, a: EditArgsOf<'text.set'>): OpOutcome {
  if (Boolean(a.clip_ids) === Boolean(a.track_id)) {
    throw new CfError('bad_request', 'Give clip_ids or track_id');
  }
  const targets: Located[] = a.track_id
    ? (() => {
        const track = getTrack(doc, a.track_id);
        return track.clips
          .filter((c) => c.type === 'title' || c.type === 'caption')
          .map((clip) => ({ track, clip }));
      })()
    : (a.clip_ids ?? []).map((id) => locate(doc, id));
  if (!targets.length)
    throw new CfError('bad_request', `Track ${a.track_id} has no titles or captions`);
  if (a.text !== undefined && targets.length !== 1) {
    throw new CfError('bad_request', 'text changes one clip at a time', {
      hint: 'Give a single clip id',
    });
  }
  for (const { track, clip } of targets) {
    if (clip.type !== 'title' && clip.type !== 'caption') {
      throw new CfError('bad_request', `Clip ${clip.id} is not a title or caption`);
    }
    assertUnlocked(track);
    if (a.text !== undefined) {
      clip.text = a.text;
      // New text no longer matches the old word timings.
      if (clip.type === 'caption') delete clip.words;
    }
    const style = mergeStyle(clip.style, a.style);
    if (style) clip.style = style;
    else delete clip.style;
  }
  const first = targets[0]?.clip;
  return ok(first?.start ?? 0, {
    clip_ids: targets.map((t) => t.clip.id),
    ...(first ? { clip_id: first.id } : {}),
  });
}

// ------------------------------------------------------------------------------ transitions

interface Cut {
  track: StoredTrack;
  a: StoredClip;
  b: StoredClip;
}

/** Frames of a transition before and after its cut (the first half rounds down). */
export function transitionHalves(duration: number, tpf: number): { before: number; after: number } {
  const frames = Math.round(duration / tpf);
  const before = Math.floor(frames / 2);
  return { before: before * tpf, after: (frames - before) * tpf };
}

/**
 * Why a transition can't play, or undefined when it can: both clips on its track, touching,
 * enabled, with enough source past the cut on each side.
 */
function transitionProblem(
  doc: TimelineDoc,
  track: StoredTrack,
  tr: StoredTransition,
): string | undefined {
  const a = track.clips.find((c) => c.id === tr.a);
  const b = track.clips.find((c) => c.id === tr.b);
  if (!a || !b) return 'one of its clips is gone';
  if (end(a) !== b.start) return 'its clips no longer touch';
  if (!a.enabled || !b.enabled) return 'one of its clips is disabled';
  const tpf = ticksPerFrame(doc.sequence.fps);
  const { before, after } = transitionHalves(tr.duration, tpf);
  if (b.duration < after || a.duration < before) return 'it is longer than one of its clips';
  const short = (c: StoredClip, edge: 'start' | 'end', by: number) => {
    if (by === 0) return false;
    const grown = retimed(c, extended(c, edge, by));
    try {
      checkSourceRange(doc, grown);
      return false;
    } catch {
      return true;
    }
  };
  if (short(a, 'end', after)) return `clip ${a.id} has no source past its end to play into it`;
  if (short(b, 'start', before))
    return `clip ${b.id} has no source before its start to play into it`;
  return undefined;
}

/** Refuses a document holding a transition that can't play (timeline.load). */
export function assertTransitions(doc: TimelineDoc): void {
  for (const track of doc.tracks)
    for (const tr of track.transitions ?? []) {
      const problem = transitionProblem(doc, track, tr);
      if (problem) throw new CfError('bad_request', `Transition ${tr.id} can't play: ${problem}`);
    }
}

/** Drops transitions an edit made impossible, saying why. */
function tidyTransitions(doc: TimelineDoc): string[] {
  const warnings: string[] = [];
  for (const track of doc.tracks) {
    if (!track.transitions) continue;
    track.transitions = track.transitions.filter((tr) => {
      const problem = transitionProblem(doc, track, tr);
      if (problem) warnings.push(`Transition ${tr.id} was removed: ${problem}`);
      return !problem;
    });
    if (!track.transitions.length) delete track.transitions;
  }
  return warnings;
}

function findTransition(
  doc: TimelineDoc,
  id: string,
): { track: StoredTrack; tr: StoredTransition } {
  for (const track of doc.tracks) {
    const tr = track.transitions?.find((x) => x.id === id);
    if (tr) return { track, tr };
  }
  const ids = doc.tracks.flatMap((t) => (t.transitions ?? []).map((x) => x.id));
  throw new CfError('not_found', `No transition ${id}`, {
    hint: ids.length ? `Transitions: ${ids.join(', ')}` : 'The timeline has no transitions',
  });
}

function checkKind(track: StoredTrack, kind: StoredTransition['kind']): void {
  if ((track.kind === 'audio') !== (kind === 'crossfade')) {
    throw new CfError(
      'bad_request',
      track.kind === 'audio'
        ? `Audio tracks take crossfade transitions, not ${kind}`
        : 'crossfade is for audio tracks; video takes dissolve, wipes, slides and the rest',
      { hint: 'See video://catalog/transitions' },
    );
  }
}

/** Sets a transition on a cut, replacing one already there, and checks it can play. */
function putTransition(
  doc: TimelineDoc,
  cut: Cut,
  kind: StoredTransition['kind'],
  duration: number,
): string {
  const existing = cut.track.transitions?.find((t) => t.a === cut.a.id && t.b === cut.b.id);
  const tr: StoredTransition = {
    id: existing?.id ?? nextId(doc, 'x'),
    a: cut.a.id,
    b: cut.b.id,
    kind,
    duration,
  };
  const problem = transitionProblem(doc, cut.track, tr);
  if (problem) {
    throw new CfError('bad_request', `The transition can't play: ${problem}`, {
      hint: "Use a shorter duration, mode: 'overlap', or trim the clips to leave source past the cut",
    });
  }
  cut.track.transitions = [...(cut.track.transitions ?? []).filter((t) => t !== existing), tr].sort(
    (x, y) =>
      cut.track.clips.findIndex((c) => c.id === x.a) -
      cut.track.clips.findIndex((c) => c.id === y.a),
  );
  return tr.id;
}

function transitionAdd(doc: TimelineDoc, a: EditArgsOf<'transition.add'>): OpOutcome {
  const { ref, members } = unlockedGroup(doc, a.clip_id);
  const next = touching(ref.track, ref.clip).after;
  if (!next) {
    throw new CfError(
      'bad_request',
      `No clip starts where ${a.clip_id} ends, so there is no cut for a transition`,
      {
        hint: 'Move the clips so they touch; for a fade from or to black use clip.set_animation with fade',
      },
    );
  }
  checkKind(ref.track, a.kind);
  const tpf = ticksPerFrame(doc.sequence.fps);
  const duration = framesToTicks(a.duration_frames, doc.sequence.fps);
  const { before, after } = transitionHalves(duration, tpf);
  // The same cut on every track of the link group, where the next clip there touches too.
  const cuts: Cut[] = [];
  for (const m of members) {
    const b = m === ref ? next : touching(m.track, m.clip).after;
    if (!b || (m !== ref && next.link && b.link !== next.link)) continue;
    assertUnlocked(m.track);
    cuts.push({ track: m.track, a: m.clip, b });
  }
  if (a.mode === 'overlap') {
    // Free source on each side of the cut by overlapping the clips; later clips move earlier.
    for (const cut of cuts) {
      if (cut.a.duration <= after || cut.b.duration <= before) {
        throw new CfError('bad_request', 'The transition is longer than one of its clips', {
          hint: 'Use a shorter duration',
        });
      }
      const cutAt = end(cut.a);
      moveEdge(cut.a, 'end', -after);
      moveEdge(cut.b, 'start', before);
      shiftFrom(cut.track, cutAt + before, -(before + after));
      checkSourceRange(doc, cut.a);
      checkSourceRange(doc, cut.b);
    }
  }
  const ids = cuts.map((cut) =>
    putTransition(doc, cut, cut.track.kind === 'audio' ? 'crossfade' : a.kind, duration),
  );
  const focus = end(ref.clip);
  return ok(focus, { clip_ids: ids, temporal: true, ...(ids[0] ? { clip_id: ids[0] } : {}) });
}

function transitionSet(doc: TimelineDoc, a: EditArgsOf<'transition.set'>): OpOutcome {
  const { track, tr } = findTransition(doc, a.transition_id);
  assertUnlocked(track);
  const kind = a.kind ?? tr.kind;
  checkKind(track, kind);
  const duration = a.duration_frames
    ? framesToTicks(a.duration_frames, doc.sequence.fps)
    : tr.duration;
  const clipA = track.clips.find((c) => c.id === tr.a) as StoredClip;
  const clipB = track.clips.find((c) => c.id === tr.b) as StoredClip;
  putTransition(doc, { track, a: clipA, b: clipB }, kind, duration);
  return ok(end(clipA), { clip_id: tr.id, temporal: true });
}

function transitionRemove(doc: TimelineDoc, a: EditArgsOf<'transition.remove'>): OpOutcome {
  const { track, tr } = findTransition(doc, a.transition_id);
  assertUnlocked(track);
  track.transitions = track.transitions?.filter((t) => t !== tr);
  if (!track.transitions?.length) delete track.transitions;
  const clipA = track.clips.find((c) => c.id === tr.a);
  return ok(clipA ? end(clipA) : 0, { clip_id: tr.id, temporal: true });
}

function videoClip(doc: TimelineDoc, clipId: string, tool: string): Located {
  const found = locate(doc, clipId);
  if (found.clip.kind !== 'video') {
    const partner = found.clip.link
      ? doc.tracks
          .flatMap((t) => t.clips)
          .find((c) => c.link === found.clip.link && c.kind === 'video')
      : undefined;
    throw new CfError('bad_request', `${tool} applies to video clips; ${clipId} is audio`, {
      hint: partner ? `Use its linked video clip ${partner.id}` : 'Pick a clip on a video track',
    });
  }
  assertUnlocked(found.track);
  return found;
}

/** Sets an animatable field: undefined keeps it, null resets it, defaults are not stored. */
function setAnimatable<K extends string>(
  target: Partial<Record<K, StoredAnimatable | undefined>>,
  key: K,
  value: Animatable | null | undefined,
  fallback: number,
  clip: StoredClip,
  tpf: number,
): void {
  if (value === undefined) return;
  checkKeyframes(key, value);
  if (value === null || value === fallback) {
    delete target[key];
    return;
  }
  target[key] = toStoredAnim(value, clip, tpf);
}

function clipSetTransform(doc: TimelineDoc, a: EditArgsOf<'clip.set_transform'>): OpOutcome {
  const { clip } = videoClip(doc, a.clip_id, 'clip.set_transform');
  const tpf = ticksPerFrame(doc.sequence.fps);
  const t: StoredTransform = { ...clip.transform };
  for (const key of TRANSFORM_NUMBERS) {
    setAnimatable(t, key, a[key], TRANSFORM_DEFAULTS[key], clip, tpf);
  }
  if (a.fit !== undefined) {
    if (a.fit === null || a.fit === 'contain') delete t.fit;
    else t.fit = a.fit;
  }
  if (a.flip !== undefined) {
    if (a.flip === null || a.flip === 'none') delete t.flip;
    else t.flip = a.flip;
  }
  if (a.crop !== undefined) {
    const c = a.crop;
    if (c === null || (!c.left && !c.right && !c.top && !c.bottom)) delete t.crop;
    else t.crop = c;
  }
  if (Object.keys(t).length) clip.transform = t;
  else delete clip.transform;
  return ok(clip.start, { clip_id: clip.id });
}

function clipSetBlend(doc: TimelineDoc, a: EditArgsOf<'clip.set_blend'>): OpOutcome {
  const { clip } = videoClip(doc, a.clip_id, 'clip.set_blend');
  if (a.mode === 'normal') delete clip.blend;
  else clip.blend = a.mode;
  return ok(clip.start, { clip_id: clip.id });
}

function clipSetMask(doc: TimelineDoc, a: EditArgsOf<'clip.set_mask'>): OpOutcome {
  const { clip } = videoClip(doc, a.clip_id, 'clip.set_mask');
  if (!a.mask) {
    delete clip.mask;
    return ok(clip.start, { clip_id: clip.id });
  }
  const m = a.mask;
  if (m.shape === 'polygon' && !m.points) {
    throw new CfError('bad_request', 'A polygon mask needs points', {
      hint: 'Give points: [[x, y], ...] with at least 3 corners in the clip picture (0–1)',
    });
  }
  if (m.shape !== 'polygon' && m.points) {
    throw new CfError('bad_request', `points apply only to polygon masks, not ${m.shape}`);
  }
  if (m.corner_radius && m.shape !== 'rectangle') {
    throw new CfError('bad_request', 'corner_radius applies only to rectangle masks');
  }
  const tpf = ticksPerFrame(doc.sequence.fps);
  const mask: StoredMask = { shape: m.shape };
  for (const key of MASK_NUMBERS) setAnimatable(mask, key, m[key], MASK_DEFAULTS[key], clip, tpf);
  if (m.feather) mask.feather = m.feather;
  if (m.corner_radius) mask.corner_radius = m.corner_radius;
  if (m.invert) mask.invert = true;
  if (m.points) mask.points = m.points;
  clip.mask = mask;
  return ok(clip.start, { clip_id: clip.id });
}

function clipSetAnimation(doc: TimelineDoc, a: EditArgsOf<'clip.set_animation'>): OpOutcome {
  const { clip } = videoClip(doc, a.clip_id, 'clip.set_animation');
  const fps = doc.sequence.fps;
  const anim: StoredAnimation = { ...clip.animation };
  for (const part of ['in', 'out'] as const) {
    const v = a[part];
    if (v === null) delete anim[part];
    else if (v) anim[part] = { name: v.name, duration: framesToTicks(v.duration_frames, fps) };
  }
  if (a.loop === null) delete anim.loop;
  else if (a.loop) {
    const period = a.loop.period_frames ?? Math.max(1, Math.round(fps.num / fps.den));
    anim.loop = {
      name: a.loop.name,
      period: framesToTicks(period, fps),
      strength: a.loop.strength,
    };
  }
  const warnings: string[] = [];
  if ((anim.in?.duration ?? 0) + (anim.out?.duration ?? 0) > clip.duration) {
    warnings.push(
      `The entrance and exit together are longer than clip ${clip.id}, so they overlap`,
    );
  }
  if (Object.keys(anim).length) clip.animation = anim;
  else delete clip.animation;
  return ok(clip.start, { clip_id: clip.id, temporal: true, warnings });
}

/** Timeline length in ticks. */
export function timelineEnd(doc: Pick<TimelineDoc, 'tracks'>): number {
  return doc.tracks.reduce((max, t) => Math.max(max, trackEnd(t)), 0);
}
