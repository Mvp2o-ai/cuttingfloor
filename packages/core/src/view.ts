import {
  CfError,
  type Change,
  type ClipView,
  EditArgs,
  MASK_NUMBERS,
  type NestedDoc,
  NestedView,
  SpeedView,
  type StoredAnimatable,
  type StoredClip,
  type StoredEffect,
  type StoredSpeed,
  TextStyle,
  type TimelineDoc,
  type TimelineInput,
  type TimelineView,
  TRANSFORM_NUMBERS,
} from '@cuttingfloor/schema';
import { toStoredAnim, toViewAnim } from './animate.ts';
import {
  applyEdit,
  assertTransitions,
  nestedRef,
  storeEffectParams,
  timelineEnd,
  transitionHalves,
} from './edit.ts';
import { frameSource, span } from './speed.ts';
import { framesToTicks, ticksPerFrame, ticksToFrames } from './time.ts';

/** A clip's speed, audio and compositing settings in tool form (frames from the clip start). */
function propsView(c: StoredClip, tpf: number): Partial<ClipView> {
  const out: Partial<ClipView> = {};
  const effects = effectsView(c.effects, c, tpf);
  if (effects) out.effects = effects;
  if (c.gain !== undefined) out.gain = toViewAnim(c.gain, c, tpf);
  if (c.pan !== undefined) out.pan = c.pan;
  if (c.fade) {
    out.fade = {
      ...(c.fade.in ? { in_frames: Math.round(c.fade.in / tpf) } : {}),
      ...(c.fade.out ? { out_frames: Math.round(c.fade.out / tpf) } : {}),
    };
  }
  if (c.speed) {
    const { rate, curve, reverse, preserve_pitch } = c.speed;
    out.speed = {
      ...(curve
        ? {
            curve: curve.map((p) => {
              const frame = Math.min(
                Math.round(p.t / tpf),
                Math.max(0, Math.round(c.duration / tpf) - 1),
              );
              return {
                at: p.t / c.duration,
                rate: p.rate,
                frame,
                source_frame: Math.round(frameSource(c, tpf, frame) / tpf),
              };
            }),
          }
        : {}),
      ...(rate !== undefined ? { rate } : {}),
      ...(reverse ? { reverse } : {}),
      ...(preserve_pitch === false ? { preserve_pitch } : {}),
    };
  }
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

/** What a clip plays, as tools show it. */
function sourceView(c: StoredClip, tpf: number): Partial<ClipView> {
  switch (c.type) {
    case 'media':
      return { media_id: c.media_id };
    case 'timeline':
      return { nested_timeline: c.timeline };
    case 'title':
      return { text: c.text, ...(c.style ? { style: c.style } : {}) };
    case 'caption':
      return {
        text: c.text,
        ...(c.words
          ? {
              words: c.words.map((w) => ({
                text: w.text,
                start: Math.round((w.t - c.in) / tpf),
                end: Math.round((w.end - c.in) / tpf),
              })),
            }
          : {}),
        ...(c.style ? { style: c.style } : {}),
      };
    case 'adjustment':
      return {};
  }
}

/** Effects as tools show them: keyframes in frames from the clip (or timeline) start. */
function effectsView(
  effects: StoredEffect[] | undefined,
  origin: Pick<StoredClip, 'in'>,
  tpf: number,
): Array<Record<string, unknown>> | undefined {
  if (!effects) return undefined;
  return effects.map((e) => ({
    id: e.id,
    name: e.name,
    params: Object.fromEntries(
      Object.entries(e.params).map(([k, v]) => [
        k,
        v && typeof v === 'object' ? toViewAnim(v as StoredAnimatable, origin, tpf) : v,
      ]),
    ),
    ...(e.enabled === false ? { enabled: false } : {}),
  }));
}

/** The frame-based view of a timeline's body (no ids, history or nesting). */
function bodyView(doc: NestedDoc): NestedView {
  const fps = doc.sequence.fps;
  const f = (t: number) => ticksToFrames(t, fps);
  return {
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
        ...sourceView(c, ticksPerFrame(fps)),
        start: f(c.start),
        end: f(c.start + c.duration),
        source: { in: f(c.in), out: f(c.in + span(c)) },
        link: c.link,
        enabled: c.enabled,
        ...propsView(c, ticksPerFrame(fps)),
      })),
      ...(t.effects ? { effects: effectsView(t.effects, { in: 0 }, ticksPerFrame(fps)) } : {}),
      ...(t.transitions
        ? {
            transitions: t.transitions.map((tr) => {
              const a = t.clips.find((c) => c.id === tr.a);
              const cut = a ? a.start + a.duration : 0;
              const { before, after } = transitionHalves(tr.duration, ticksPerFrame(fps));
              return {
                id: tr.id,
                from_clip_id: tr.a,
                to_clip_id: tr.b,
                kind: tr.kind,
                start: f(cut - before),
                end: f(cut + after),
              };
            }),
          }
        : {}),
    })),
    ...(doc.effects ? { effects: effectsView(doc.effects, { in: 0 }, ticksPerFrame(fps)) } : {}),
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

/** The frame-based view tools return. */
export function toView(id: string, doc: TimelineDoc): TimelineView {
  const nested = doc.nested
    ? Object.fromEntries(Object.entries(doc.nested).map(([k, n]) => [k, bodyView(n)]))
    : undefined;
  return {
    timeline_id: id,
    parent: doc.parent,
    ...bodyView(doc),
    ...(doc.master
      ? {
          master: {
            gain_db: doc.master.gain,
            ...(doc.master.limit !== undefined ? { limit_db: doc.master.limit } : {}),
          },
        }
      : {}),
    ...(nested ? { nested } : {}),
  };
}

type MediaLookup = (id: string) => TimelineDoc['media'][string] | undefined;

/**
 * Rebuilds a document from a view (timeline.load). Media facts come from the server's media
 * records, not from the caller, so a loaded timeline can't claim media it doesn't have.
 * Nested timelines rebuild the same way, each checked on its own.
 */
export function fromView(input: TimelineInput, media: MediaLookup): TimelineDoc {
  const views = input.nested ?? {};
  const nested: Record<string, NestedDoc> = {};
  const building = new Set<string>();
  const build = (key: string): NestedDoc => {
    const done = nested[key];
    if (done) return done;
    const raw = views[key];
    if (!raw) {
      throw new CfError(
        'bad_request',
        `Nested timeline ${key} is not in the timeline's nested map`,
      );
    }
    const parsed = NestedView.safeParse(raw);
    if (!parsed.success) {
      throw new CfError(
        'bad_request',
        `Nested timeline ${key}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    const view = parsed.data;
    if (building.has(key))
      throw new CfError('bad_request', `Nested timeline ${key} contains itself`);
    building.add(key);
    const body = bodyFromView(view, media, build);
    nested[key] = body;
    return body;
  };
  const body = bodyFromView(input, media, build);
  const doc: TimelineDoc = { ...body, parent: null, op: null };
  if (Object.keys(nested).length) doc.nested = nested;
  if (input.master) {
    applyEdit(
      doc,
      'audio.set_master',
      { gain_db: input.master.gain_db, limit_db: input.master.limit_db ?? null },
      () => undefined,
    );
  }
  assertTransitions(doc);
  for (const n of Object.values(nested))
    assertTransitions({ ...n, parent: null, op: null, nested });
  for (const body of [doc, ...Object.values(nested)]) assertCaptionWords(body.tracks);
  replayProps(doc, input.tracks);
  loadEffects(doc, input.tracks, input.effects, media);
  for (const key of Object.keys(views)) {
    const n = nested[key];
    if (!n) continue;
    const view = NestedView.parse(views[key]);
    const scratch: TimelineDoc = { ...n, parent: null, op: null, nested: { ...nested } };
    replayProps(scratch, view.tracks);
    loadEffects(scratch, view.tracks, view.effects, media);
    const { parent: _p, op: _o, nested: _n, ...replayed } = scratch;
    nested[key] = replayed;
  }
  return doc;
}

function bodyFromView(
  input: Pick<TimelineInput, 'name' | 'sequence' | 'tracks'>,
  media: MediaLookup,
  nestedBody: (key: string) => NestedDoc,
): NestedDoc {
  const fps = input.sequence.fps;
  const t = (frames: number) => framesToTicks(frames, fps);
  const doc: NestedDoc = {
    format: 'cuttingfloor.timeline',
    version: 2,
    name: input.name,
    sequence: input.sequence,
    tracks: [],
    media: {},
    next_id: 1,
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
      const speed = speedFromView(c.id, c.speed, t(c.end - c.start));
      const expected = c.end - c.start;
      if (!speed && c.source.out - c.source.in !== expected) {
        throw new CfError(
          'bad_request',
          `Clip ${c.id}: source range length must equal its timeline length`,
          { hint: 'Give the clip a speed if it plays faster or slower than its source' },
        );
      }
      const common = {
        id: c.id,
        kind: c.kind,
        start: t(c.start),
        in: t(c.source.in),
        duration: t(c.end - c.start),
        link: c.link,
        enabled: c.enabled,
        ...(speed ? { speed } : {}),
      };
      if (c.type === 'title' || c.type === 'caption') {
        clips.push(textClip(c, common, t));
        continue;
      }
      if (c.type === 'adjustment') {
        if (c.kind !== 'video')
          throw new CfError('bad_request', `Adjustment clip ${c.id} must be on a video track`);
        clips.push({ ...common, type: 'adjustment' });
        continue;
      }
      const isNested = c.type === 'timeline';
      const key = isNested ? (c.nested_timeline ?? '') : (c.media_id ?? '');
      if (!key) {
        throw new CfError(
          'bad_request',
          `Clip ${c.id} needs ${isNested ? 'nested_timeline' : 'media_id'}`,
        );
      }
      const ref = isNested ? nestedRef(nestedBody(key)) : media(key);
      if (!ref) {
        throw new CfError('media_offline', `Media ${key} used by clip ${c.id} is not available`, {
          hint: 'Import the file again with media.import and replace the media_id in the timeline',
        });
      }
      if ((c.kind === 'video' && !ref.video) || (c.kind === 'audio' && !ref.audio)) {
        throw new CfError(
          'bad_request',
          `${isNested ? 'Timeline' : 'Media'} ${key} has no ${c.kind} for clip ${c.id}`,
        );
      }
      if (!isNested) doc.media[key] = ref;
      clips.push({
        ...common,
        ...(isNested
          ? { type: 'timeline' as const, timeline: key }
          : { type: 'media' as const, media_id: key }),
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
    const { transitions: views, effects: _effects, ...rest } = track;
    const transitions = (views ?? []).map((tr) => ({
      id: tr.id,
      a: tr.from_clip_id,
      b: tr.to_clip_id,
      kind: tr.kind,
      duration: t(tr.end - tr.start),
    }));
    doc.tracks.push({ ...rest, clips, ...(transitions.length ? { transitions } : {}) });
  }
  // Continue numbering after the highest id in the input.
  let max = 0;
  for (const id of ids) {
    const n = Number(/^[a-z](\d+)$/.exec(id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  for (const tr of doc.tracks) {
    for (const c of tr.clips) {
      const n = Number(/^l(\d+)$/.exec(c.link ?? '')?.[1] ?? 0);
      if (n > max) max = n;
    }
    for (const x of tr.transitions ?? [])
      max = Math.max(max, Number(/^x(\d+)$/.exec(x.id)?.[1] ?? 0));
  }
  doc.next_id = max + 1;
  return doc;
}

const EFFECT_ID = /^f(\d+)$/;

/**
 * Effects from a view, checked and stored like filter.add stores them, keeping their ids;
 * numbering then continues after the highest effect id.
 */
function loadEffects(
  doc: TimelineDoc,
  tracks: TimelineInput['tracks'],
  timeline: Array<Record<string, unknown>> | undefined,
  media: MediaLookup,
): void {
  let max = 0;
  const convert = (
    home: Parameters<typeof storeEffectParams>[1],
    views: unknown,
  ): StoredEffect[] | undefined => {
    if (!Array.isArray(views) || !views.length) return undefined;
    return views.map((raw) => {
      const v = raw as { id?: unknown; name?: unknown; params?: unknown; enabled?: unknown };
      const id = typeof v.id === 'string' ? v.id : '';
      const m = EFFECT_ID.exec(id);
      if (!m)
        throw new CfError('bad_request', `Effect id ${String(v.id)} is not valid`, {
          hint: 'Effect ids look like f12',
        });
      max = Math.max(max, Number(m[1]));
      const params = storeEffectParams(
        doc,
        home,
        String(v.name),
        (v.params ?? {}) as Record<string, unknown>,
        media,
      );
      return {
        id,
        name: String(v.name),
        params,
        ...(v.enabled === false ? { enabled: false } : {}),
      };
    });
  };
  for (const tv of tracks) {
    const track = doc.tracks.find((t) => t.id === tv.id);
    if (!track) continue;
    const onTrack = convert({ scope: 'track', track }, tv.effects);
    if (onTrack) track.effects = onTrack;
    for (const cv of tv.clips) {
      const clip = track.clips.find((c) => c.id === cv.id);
      if (!clip) continue;
      const onClip = convert({ scope: 'clip', track, clip }, cv.effects);
      if (onClip) clip.effects = onClip;
    }
  }
  const onTimeline = convert({ scope: 'timeline' }, timeline);
  if (onTimeline) doc.effects = onTimeline;
  doc.next_id = Math.max(doc.next_id, max + 1);
}

type ClipCommon = Omit<Extract<StoredClip, { type: 'media' }>, 'type' | 'media_id'>;

/** A title or caption from its view: text and style checked like the tools check them. */
function textClip(c: ClipView, common: ClipCommon, t: (frames: number) => number): StoredClip {
  if (c.kind !== 'video')
    throw new CfError('bad_request', `Text clip ${c.id} must be on a video track`);
  if (!c.text) throw new CfError('bad_request', `Clip ${c.id} needs text`);
  const style = c.style === undefined ? undefined : TextStyle.safeParse(c.style);
  if (style && !style.success) {
    throw new CfError(
      'bad_request',
      `Clip ${c.id}: style: ${style.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const styled = style?.data ? { style: style.data } : {};
  if (c.type === 'title') return { ...common, type: 'title', text: c.text, ...styled };
  const words = c.words?.map((w) => ({
    text: w.text,
    t: common.in + t(w.start),
    end: common.in + t(w.end),
  }));
  return { ...common, type: 'caption', text: c.text, ...(words ? { words } : {}), ...styled };
}

/** A clip's speed from its view, with ramp points converted back to ticks. */
function speedFromView(clipId: string, value: unknown, duration: number): StoredSpeed | undefined {
  if (value === undefined) return undefined;
  const parsed = SpeedView.safeParse(value);
  if (!parsed.success) {
    throw new CfError(
      'bad_request',
      `Clip ${clipId}: speed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const { rate, curve, reverse, preserve_pitch } = parsed.data;
  const speed: StoredSpeed = {
    ...(curve
      ? { curve: curve.map((p) => ({ t: Math.round(p.at * duration), rate: p.rate })) }
      : {}),
    ...(rate !== undefined && !curve ? { rate } : {}),
    ...(reverse ? { reverse } : {}),
    ...(preserve_pitch === false ? { preserve_pitch } : {}),
  };
  return Object.keys(speed).length ? speed : undefined;
}

/**
 * Applies each clip's compositing settings through the same validated edits the tools use, so
 * a loaded timeline can't hold values a tool would refuse. Locks go back on afterwards.
 */
function replayProps(doc: TimelineDoc, tracks: TimelineInput['tracks']): void {
  const none = () => undefined;
  const locked = new Map(doc.tracks.map((t) => [t.id, t.locked]));
  for (const t of doc.tracks) t.locked = false;
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
  const tpf = ticksPerFrame(doc.sequence.fps);
  for (const track of tracks)
    for (const c of track.clips) {
      // Audio settings belong to this one clip, so they are checked and set directly rather
      // than replayed (audio.set_gain would reach its linked clips too).
      const stored = doc.tracks.flatMap((t) => t.clips).find((x) => x.id === c.id);
      if (stored && (c.gain !== undefined || c.pan !== undefined || c.fade)) {
        const g =
          c.gain === undefined
            ? undefined
            : EditArgs['audio.set_gain'].safeParse({ clip_id: c.id, gain_db: c.gain });
        const p =
          c.pan === undefined
            ? undefined
            : EditArgs['audio.set_pan'].safeParse({ clip_id: c.id, pan: c.pan });
        if ((g && !g.success) || (p && !p.success)) {
          throw new CfError('bad_request', `Clip ${c.id}: gain or pan is not valid`, {
            hint: 'gain is dB (-60 to 24), pan -1 to 1, each a number or {keyframes}',
          });
        }
        if (g?.success && g.data.gain_db !== undefined && g.data.gain_db !== null)
          stored.gain = toStoredAnim(g.data.gain_db, stored, tpf);
        if (p?.success && p.data.pan) stored.pan = p.data.pan;
        if (c.fade) {
          stored.fade = {
            ...(c.fade.in_frames ? { in: Math.round(c.fade.in_frames) * tpf } : {}),
            ...(c.fade.out_frames ? { out: Math.round(c.fade.out_frames) * tpf } : {}),
          };
        }
      }
      if (c.transform) run('clip.set_transform', { clip_id: c.id, ...c.transform });
      if (c.blend) run('clip.set_blend', { clip_id: c.id, mode: c.blend });
      if (c.mask) run('clip.set_mask', { clip_id: c.id, mask: c.mask });
      if (c.animation) run('clip.set_animation', { clip_id: c.id, ...c.animation });
    }
  for (const t of doc.tracks) t.locked = locked.get(t.id) ?? false;
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
    JSON.stringify([t.kind, t.name, t.muted, t.hidden, t.locked, t.effects ?? []]);
  for (const [id, t] of tracksB) {
    const before = tracksA.get(id);
    if (!before) out.push({ id, type: 'track', change: 'added' });
    else if (props(before) !== props(t)) out.push({ id, type: 'track', change: 'modified' });
  }
  for (const id of tracksA.keys())
    if (!tracksB.has(id)) out.push({ id, type: 'track', change: 'removed' });
  if (JSON.stringify(a.effects ?? []) !== JSON.stringify(b.effects ?? [])) {
    out.push({ id: 'effects', type: 'effects', change: 'modified' });
  }
  if (JSON.stringify(a.master ?? null) !== JSON.stringify(b.master ?? null)) {
    out.push({ id: 'master', type: 'master', change: 'modified' });
  }

  // Each transition by id, with its track, kind and the frames it covers around its cut.
  const tpf = ticksPerFrame(b.sequence.fps);
  const transitions = (d: TimelineDoc) =>
    new Map(
      d.tracks.flatMap((t) =>
        (t.transitions ?? []).map(
          (x) => [x.id, { track: t, x, key: JSON.stringify([t.id, x]) }] as const,
        ),
      ),
    );
  const transA = transitions(a);
  const transB = transitions(b);
  for (const [id, { track, x, key }] of transB) {
    const before = transA.get(id);
    if (before && before.key === key) continue;
    const clipA = track.clips.find((c) => c.id === x.a);
    const { before: lead, after: tail } = transitionHalves(x.duration, tpf);
    const cut = clipA ? clipA.start + clipA.duration : undefined;
    out.push({
      id,
      type: 'transition',
      change: before ? 'modified' : 'added',
      track_id: track.id,
      kind: x.kind,
      ...(cut === undefined
        ? {}
        : {
            start: ticksToFrames(cut - lead, b.sequence.fps),
            end: ticksToFrames(cut + tail, b.sequence.fps),
          }),
    });
  }
  for (const id of transA.keys())
    if (!transB.has(id)) out.push({ id, type: 'transition', change: 'removed' });

  const clips = (d: TimelineDoc) =>
    new Map(
      d.tracks.flatMap((t) => t.clips.map((c) => [c.id, JSON.stringify([t.id, c])] as const)),
    );
  const clipsA = clips(a);
  const clipsB = clips(b);
  const f = (ticks: number) => ticksToFrames(ticks, b.sequence.fps);
  const at = new Map(
    b.tracks.flatMap((t) =>
      t.clips.map(
        (c) => [c.id, { track_id: t.id, start: f(c.start), end: f(c.start + c.duration) }] as const,
      ),
    ),
  );
  for (const [id, c] of clipsB) {
    const before = clipsA.get(id);
    if (before === undefined) out.push({ id, type: 'clip', change: 'added', ...at.get(id) });
    else if (before !== c) out.push({ id, type: 'clip', change: 'modified', ...at.get(id) });
  }
  for (const id of clipsA.keys())
    if (!clipsB.has(id)) out.push({ id, type: 'clip', change: 'removed' });
  return out;
}

/**
 * Refuses a caption whose words spell something other than its text: the words are what renders
 * (they time the highlights), so an edit to text alone would silently not show.
 */
function assertCaptionWords(tracks: TimelineDoc['tracks']): void {
  const squash = (t: string) => t.replace(/\s+/g, ' ').trim();
  for (const t of tracks)
    for (const c of t.clips) {
      if (c.type !== 'caption' || !c.words?.length) continue;
      const spelled = squash(c.words.map((w) => w.text).join(' '));
      if (spelled !== squash(c.text)) {
        throw new CfError(
          'bad_request',
          `Caption ${c.id}: its words spell "${spelled}" but its text is "${squash(c.text)}"`,
          {
            hint: 'The words are what renders. Change words[].text to match, or drop words (losing the word timing)',
          },
        );
      }
    }
}
