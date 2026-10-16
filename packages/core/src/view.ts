import {
  CfError,
  type Change,
  type ClipView,
  EditArgs,
  MASK_NUMBERS,
  type StoredClip,
  type TimelineDoc,
  type TimelineInput,
  type TimelineView,
  TRANSFORM_NUMBERS,
} from '@cuttingfloor/schema';
import { toViewAnim } from './animate.ts';
import { applyEdit, timelineEnd } from './edit.ts';
import { framesToTicks, ticksPerFrame, ticksToFrames } from './time.ts';

/** A clip's compositing settings in tool form (frames from the clip start). */
function propsView(c: StoredClip, tpf: number): Partial<ClipView> {
  const out: Partial<ClipView> = {};
  if (c.transform) {
    const { fit, flip, crop } = c.transform;
    const t: NonNullable<ClipView['transform']> = {};
    for (const k of TRANSFORM_NUMBERS) {
      const v = c.transform[k];
      if (v !== undefined) t[k] = toViewAnim(v, c, tpf);
    }
    out.transform = {
      ...t,
      ...(fit ? { fit } : {}),
      ...(flip ? { flip } : {}),
      ...(crop ? { crop } : {}),
    };
  }
  if (c.blend) out.blend = c.blend;
  if (c.mask) {
    const { shape, feather, corner_radius, invert, points } = c.mask;
    const m: NonNullable<ClipView['mask']> = { shape };
    for (const k of MASK_NUMBERS) {
      const v = c.mask[k];
      if (v !== undefined) m[k] = toViewAnim(v, c, tpf);
    }
    out.mask = {
      ...m,
      ...(feather ? { feather } : {}),
      ...(corner_radius ? { corner_radius } : {}),
      ...(invert ? { invert } : {}),
      ...(points ? { points } : {}),
    };
  }
  if (c.animation) {
    const a = c.animation;
    const f = (ticks: number) => Math.round(ticks / tpf);
    out.animation = {
      ...(a.in ? { in: { name: a.in.name, duration_frames: f(a.in.duration) } } : {}),
      ...(a.out ? { out: { name: a.out.name, duration_frames: f(a.out.duration) } } : {}),
      ...(a.loop
        ? {
            loop: { name: a.loop.name, period_frames: f(a.loop.period), strength: a.loop.strength },
          }
        : {}),
    };
  }
  return out;
}

/** The frame-based view tools return. */
export function toView(id: string, doc: TimelineDoc): TimelineView {
  const fps = doc.sequence.fps;
  const f = (t: number) => ticksToFrames(t, fps);
  return {
    timeline_id: id,
    parent: doc.parent,
    name: doc.name,
    sequence: doc.sequence,
    duration: f(timelineEnd(doc)),
    tracks: doc.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      muted: t.muted,
      hidden: t.hidden,
      locked: t.locked,
      clips: t.clips.map((c) => ({
        id: c.id,
        type: c.type,
        kind: c.kind,
        track_id: t.id,
        media_id: c.media_id,
        start: f(c.start),
        end: f(c.start + c.duration),
        source: { in: f(c.in), out: f(c.in + c.duration) },
        link: c.link,
        enabled: c.enabled,
        ...propsView(c, ticksPerFrame(fps)),
      })),
    })),
    media: Object.fromEntries(
      Object.entries(doc.media).map(([id, m]) => [
        id,
        {
          name: m.name,
          duration: m.duration === null ? null : Math.floor(m.duration / framesToTicks(1, fps)),
          video: m.video,
          audio: m.audio,
        },
      ]),
    ),
  };
}

/**
 * Rebuilds a document from a view (timeline.load). Media facts come from the server's media
 * records, not from the caller, so a loaded timeline can't claim media it doesn't have.
 */
export function fromView(
  input: TimelineInput,
  media: (id: string) => TimelineDoc['media'][string] | undefined,
): TimelineDoc {
  const fps = input.sequence.fps;
  const t = (frames: number) => framesToTicks(frames, fps);
  const doc: TimelineDoc = {
    format: 'cuttingfloor.timeline',
    version: 2,
    name: input.name,
    sequence: input.sequence,
    tracks: [],
    media: {},
    next_id: 1,
    parent: null,
    op: null,
  };
  const ids = new Set<string>();
  const claim = (id: string) => {
    if (ids.has(id)) throw new CfError('bad_request', `Duplicate id ${id} in the timeline`);
    ids.add(id);
  };
  const sorted = [...input.tracks].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1,
  );
  for (const track of sorted) {
    claim(track.id);
    const clips: StoredClip[] = [];
    for (const c of track.clips) {
      claim(c.id);
      if (c.kind !== track.kind)
        throw new CfError(
          'bad_request',
          `Clip ${c.id} is ${c.kind} on ${track.kind} track ${track.id}`,
        );
      if (c.end <= c.start) throw new CfError('bad_request', `Clip ${c.id} has no frames`);
      if (c.source.out - c.source.in !== c.end - c.start) {
        throw new CfError(
          'bad_request',
          `Clip ${c.id}: source range length must equal its timeline length`,
        );
      }
      const ref = media(c.media_id);
      if (!ref) {
        throw new CfError(
          'media_offline',
          `Media ${c.media_id} used by clip ${c.id} is not available`,
          {
            hint: 'Import the file again with media.import and replace the media_id in the timeline',
          },
        );
      }
      if ((c.kind === 'video' && !ref.video) || (c.kind === 'audio' && !ref.audio)) {
        throw new CfError('bad_request', `Media ${c.media_id} has no ${c.kind} for clip ${c.id}`);
      }
      doc.media[c.media_id] = ref;
      clips.push({
        id: c.id,
        type: 'media',
        kind: c.kind,
        media_id: c.media_id,
        start: t(c.start),
        in: t(c.source.in),
        duration: t(c.end - c.start),
        link: c.link,
        enabled: c.enabled,
      });
    }
    clips.sort((a, b) => a.start - b.start);
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1];
      const cur = clips[i];
      if (prev && cur && prev.start + prev.duration > cur.start) {
        throw new CfError(
          'bad_request',
          `Clips ${prev.id} and ${cur.id} overlap on track ${track.id}`,
        );
      }
    }
    // Locks are restored after compositing settings are replayed below.
    doc.tracks.push({ ...track, locked: false, clips });
  }
  // Continue numbering after the highest id in the input.
  let max = 0;
  for (const id of ids) {
    const n = Number(/^[a-z](\d+)$/.exec(id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  for (const t of doc.tracks)
    for (const c of t.clips) {
      const n = Number(/^l(\d+)$/.exec(c.link ?? '')?.[1] ?? 0);
      if (n > max) max = n;
    }
  doc.next_id = max + 1;
  replayProps(doc, input);
  for (const track of sorted) {
    const stored = doc.tracks.find((t) => t.id === track.id);
    if (stored) stored.locked = track.locked;
  }
  return doc;
}

/**
 * Applies each clip's compositing settings through the same validated edits the tools use, so
 * a loaded timeline can't hold values a tool would refuse.
 */
function replayProps(doc: TimelineDoc, input: TimelineInput): void {
  const none = () => undefined;
  const run = <
    T extends 'clip.set_transform' | 'clip.set_blend' | 'clip.set_mask' | 'clip.set_animation',
  >(
    tool: T,
    args: Record<string, unknown>,
  ) => {
    const parsed = EditArgs[tool].safeParse(args);
    if (!parsed.success) {
      throw new CfError(
        'bad_request',
        `Clip ${String(args.clip_id)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    applyEdit(doc, tool, parsed.data as never, none);
  };
  for (const track of input.tracks)
    for (const c of track.clips) {
      if (c.transform) run('clip.set_transform', { clip_id: c.id, ...c.transform });
      if (c.blend) run('clip.set_blend', { clip_id: c.id, mode: c.blend });
      if (c.mask) run('clip.set_mask', { clip_id: c.id, mask: c.mask });
      if (c.animation) run('clip.set_animation', { clip_id: c.id, ...c.animation });
    }
}

/** Structural diff between two documents. Every edit result's `changed[]` is this diff. */
export function diff(a: TimelineDoc, b: TimelineDoc): Change[] {
  const out: Change[] = [];
  if (a.name !== b.name) out.push({ id: 'name', type: 'name', change: 'modified' });
  if (JSON.stringify(a.sequence) !== JSON.stringify(b.sequence)) {
    out.push({ id: 'sequence', type: 'sequence', change: 'modified' });
  }
  const tracksA = new Map(a.tracks.map((t) => [t.id, t]));
  const tracksB = new Map(b.tracks.map((t) => [t.id, t]));
  const props = (t: TimelineDoc['tracks'][number]) =>
    JSON.stringify([t.kind, t.name, t.muted, t.hidden, t.locked]);
  for (const [id, t] of tracksB) {
    const before = tracksA.get(id);
    if (!before) out.push({ id, type: 'track', change: 'added' });
    else if (props(before) !== props(t)) out.push({ id, type: 'track', change: 'modified' });
  }
  for (const id of tracksA.keys())
    if (!tracksB.has(id)) out.push({ id, type: 'track', change: 'removed' });

  const clips = (d: TimelineDoc) =>
    new Map(
      d.tracks.flatMap((t) => t.clips.map((c) => [c.id, JSON.stringify([t.id, c])] as const)),
    );
  const clipsA = clips(a);
  const clipsB = clips(b);
  for (const [id, c] of clipsB) {
    const before = clipsA.get(id);
    if (before === undefined) out.push({ id, type: 'clip', change: 'added' });
    else if (before !== c) out.push({ id, type: 'clip', change: 'modified' });
  }
  for (const id of clipsA.keys())
    if (!clipsB.has(id)) out.push({ id, type: 'clip', change: 'removed' });
  return out;
}
