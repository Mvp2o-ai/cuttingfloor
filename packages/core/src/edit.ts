import {
  CfError,
  type EditArgsOf,
  type EditTool,
  type MediaRef,
  type Sequence,
  type StoredClip,
  type StoredTrack,
  type TimelineDoc,
  type TrackKind,
} from '@cuttingfloor/schema';
import { framesToTicks, ticksPerFrame } from './time.ts';

/** Looks up media an edit refers to. Returns undefined for unknown ids. */
export type MediaResolver = (mediaId: string) => MediaRef | undefined;

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
    version: 1,
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
): OpOutcome {
  const handlers: {
    [K in EditTool]: (doc: TimelineDoc, a: EditArgsOf<K>, m: MediaResolver) => OpOutcome;
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
  };
  const handler = handlers[tool] as (
    d: TimelineDoc,
    a: EditArgsOf<T>,
    m: MediaResolver,
  ) => OpOutcome;
  const outcome = handler(doc, args, media);
  pruneMedia(doc);
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

/** Clears [from, to) on a track, cutting clips that cross the edges (overwrite edit). */
function clearRange(doc: TimelineDoc, track: StoredTrack, from: number, to: number): void {
  const kept: StoredClip[] = [];
  for (const c of track.clips) {
    const cEnd = end(c);
    if (cEnd <= from || c.start >= to) {
      kept.push(c);
      continue;
    }
    if (c.start < from) kept.push({ ...c, duration: from - c.start });
    if (cEnd > to) {
      const cut = to - c.start;
      kept.push({
        ...c,
        id: c.start < from ? nextId(doc, 'c') : c.id,
        start: to,
        in: c.in + cut,
        duration: cEnd - to,
      });
    }
  }
  track.clips = kept;
  sortTrack(track);
}

/** Splits the clip that crosses `at`, if any. Returns the new right-hand clip. */
function splitTrackAt(doc: TimelineDoc, track: StoredTrack, at: number): StoredClip | undefined {
  const c = track.clips.find((x) => x.start < at && end(x) > at);
  if (!c) return undefined;
  const left = at - c.start;
  const right: StoredClip = {
    ...c,
    id: nextId(doc, 'c'),
    start: at,
    in: c.in + left,
    duration: c.duration - left,
  };
  c.duration = left;
  track.clips.push(right);
  sortTrack(track);
  return right;
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
  const media = doc.media[clip.media_id];
  if (clip.in < 0) {
    throw new CfError(
      'bad_request',
      `Clip ${clip.id} would start before the beginning of its media`,
      {
        hint: 'Trim less, or use a later source in-point',
      },
    );
  }
  if (media?.duration != null && clip.in + clip.duration > media.duration) {
    const tpf = ticksPerFrame(doc.sequence.fps);
    throw new CfError('bad_request', `Clip ${clip.id} would run past the end of its media`, {
      hint: `The media is ${Math.floor(media.duration / tpf)} frames long`,
    });
  }
}

/** Removes media entries no clip uses, so equal timelines hash equal. */
function pruneMedia(doc: TimelineDoc): void {
  const used = new Set(doc.tracks.flatMap((t) => t.clips.map((c) => c.media_id)));
  for (const id of Object.keys(doc.media)) if (!used.has(id)) delete doc.media[id];
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

function clipAdd(doc: TimelineDoc, a: EditArgsOf<'clip.add'>, resolve: MediaResolver): OpOutcome {
  const media = resolve(a.media_id);
  if (!media) {
    throw new CfError('not_found', `No media ${a.media_id}`, {
      hint: 'Import it first with media.import; media expires 7 days after last use',
    });
  }
  doc.media[a.media_id] = media;
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
        hint: `The media has ${has || 'no streams'}; pick a matching track or set av`,
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
      kind,
      media_id: a.media_id,
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
      clip.duration += delta;
      if (clip.duration <= 0)
        throw new CfError('bad_request', `Trim would leave clip ${clip.id} with no frames`);
      checkSourceRange(doc, clip);
      if (a.ripple) shiftFrom(track, oldEnd, delta, clip);
      else if (end(clip) > nextStart) {
        throw new CfError('bad_request', `Extending clip ${clip.id} would overlap the next clip`, {
          hint: 'Use ripple: true to push later clips, or trim the next clip first',
        });
      }
    } else if (a.ripple) {
      // Ripple head trim: the clip keeps its position, its content shifts, later clips follow.
      clip.in += delta;
      clip.duration -= delta;
      if (clip.duration <= 0)
        throw new CfError('bad_request', `Trim would leave clip ${clip.id} with no frames`);
      checkSourceRange(doc, clip);
      shiftFrom(track, oldEnd, -delta, clip);
    } else {
      clip.start += delta;
      clip.in += delta;
      clip.duration -= delta;
      if (clip.duration <= 0)
        throw new CfError('bad_request', `Trim would leave clip ${clip.id} with no frames`);
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

/** Timeline length in ticks. */
export function timelineEnd(doc: TimelineDoc): number {
  return doc.tracks.reduce((max, t) => Math.max(max, trackEnd(t)), 0);
}
