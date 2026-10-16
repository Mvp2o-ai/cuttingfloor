import * as z from 'zod/v4';
import {
  BlendMode,
  StoredAnimatable,
  StoredAnimation,
  StoredMask,
  StoredTransform,
  StoredTransition,
  TransitionKind,
} from './compositing.ts';
import { Sequence } from './sequence.ts';
import { StoredWord, TextStyle } from './text.ts';

export const TrackKind = z.enum(['video', 'audio']);
export type TrackKind = z.infer<typeof TrackKind>;

const ticks = z.number().int().nonnegative();

/** What a timeline needs to know about a media item, copied in so the document stands alone. */
export const MediaRef = z.object({
  name: z.string(),
  /** Ticks; null for stills, which have no natural length. */
  duration: ticks.nullable(),
  video: z.boolean(),
  audio: z.boolean(),
});
export type MediaRef = z.infer<typeof MediaRef>;

/**
 * Playback speed: a constant rate or a ramp (rate points over the clip, ticks from its start),
 * optionally reversed. Rate 0 is a freeze frame. Absent means normal speed.
 */
export const StoredSpeed = z.object({
  rate: z.number().min(0).max(100).optional(),
  curve: z
    .array(z.object({ t: z.number().int().nonnegative(), rate: z.number().min(0).max(100) }))
    .min(2)
    .max(64)
    .optional(),
  reverse: z.boolean().optional(),
  /** Absent means pitch is kept when the speed changes. */
  preserve_pitch: z.boolean().optional(),
});
export type StoredSpeed = z.infer<typeof StoredSpeed>;

/** Speed as tools show it: a ramp's points are at fractions of the clip (0–1). */
export const SpeedView = z.object({
  rate: z.number().min(0).max(100).optional(),
  curve: z
    .array(z.object({ at: z.number().min(0).max(1), rate: z.number().min(0).max(100) }))
    .min(2)
    .max(64)
    .optional(),
  reverse: z.boolean().optional(),
  preserve_pitch: z.boolean().optional(),
});

const clipFields = {
  id: z.string(),
  kind: TrackKind,
  start: ticks,
  in: ticks,
  duration: z.number().int().positive(),
  link: z.string().nullable(),
  enabled: z.boolean(),
  speed: StoredSpeed.optional(),
  // Audio; absent means unchanged. Gain in dB animates like transform values; pan is -1 (left)
  // to 1 (right); fades are lengths in ticks.
  gain: StoredAnimatable.optional(),
  pan: z.number().min(-1).max(1).optional(),
  fade: z
    .object({
      in: z.number().int().positive().optional(),
      out: z.number().int().positive().optional(),
    })
    .optional(),
  // Video compositing; absent means the default.
  transform: StoredTransform.optional(),
  blend: BlendMode.optional(),
  mask: StoredMask.optional(),
  animation: StoredAnimation.optional(),
};

/**
 * Stored clip. All times are ticks (TICKS_PER_SECOND). `start` is on the timeline, `in` in the
 * source: an imported media item, or another timeline nested in this one (a compound clip),
 * kept by value in the document's `nested` map under `timeline`.
 */
export const StoredClip = z.discriminatedUnion('type', [
  z.object({ ...clipFields, type: z.literal('media'), media_id: z.string() }),
  z.object({ ...clipFields, type: z.literal('timeline'), timeline: z.string() }),
  // Generated pictures: text over transparency. `in` places the text's own clock, so a trim
  // keeps caption words on time.
  z.object({
    ...clipFields,
    type: z.literal('title'),
    text: z.string(),
    style: TextStyle.optional(),
  }),
  z.object({
    ...clipFields,
    type: z.literal('caption'),
    text: z.string(),
    words: z.array(StoredWord).optional(),
    style: TextStyle.optional(),
  }),
]);
export type StoredClip = z.infer<typeof StoredClip>;

export const StoredTrack = z.object({
  id: z.string(),
  kind: TrackKind,
  name: z.string(),
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  clips: z.array(StoredClip),
  transitions: z.array(StoredTransition).optional(),
});
export type StoredTrack = z.infer<typeof StoredTrack>;

export const TimelineOp = z.object({ tool: z.string(), args: z.unknown() });
export type TimelineOp = z.infer<typeof TimelineOp>;

/**
 * The stored timeline document. Immutable: its id is the hash of its canonical JSON, so an
 * edit always makes a new document whose `parent` is the one it was made from.
 * Video tracks are listed bottom to top; audio tracks are mixed.
 */
const docFields = {
  format: z.literal('cuttingfloor.timeline'),
  version: z.literal(2),
  name: z.string(),
  sequence: Sequence,
  tracks: z.array(StoredTrack),
  media: z.record(z.string(), MediaRef),
  next_id: z.number().int().positive(),
};

/** A timeline nested in another. Nesting is flattened: every level lives in the root's map. */
export const NestedDoc = z.object(docFields);
export type NestedDoc = z.infer<typeof NestedDoc>;

export const TimelineDoc = z.object({
  ...docFields,
  parent: z.string().nullable(),
  op: TimelineOp.nullable(),
  /** The mix's master gain (dB) and limiter ceiling (dBFS). Absent means untouched. */
  master: z
    .object({ gain: z.number().min(-60).max(40), limit: z.number().min(-20).max(0).optional() })
    .optional(),
  /** Timelines its clips nest, at any depth, by key. Absent when there are none. */
  nested: z.record(z.string(), NestedDoc).optional(),
});
export type TimelineDoc = z.infer<typeof TimelineDoc>;

const frame = z.number().int().nonnegative();

/**
 * Compositing settings in a clip view, in the same shape the clip.set_* tools take. Kept loose
 * here so timeline.get and timeline.load stay small; timeline.load checks every value by
 * replaying them through those tools.
 */
const settings = (tool: string) =>
  z.record(z.string(), z.unknown()).describe(`As ${tool} takes it`);

/** The timeline as tools show it: integer frames at the sequence rate, end exclusive. */
export const ClipView = z.object({
  id: z.string(),
  type: z.enum(['media', 'timeline', 'title', 'caption']).default('media'),
  kind: TrackKind,
  track_id: z.string(),
  media_id: z.string().optional().describe('For media clips'),
  nested_timeline: z
    .string()
    .optional()
    .describe("For nested timelines (compound clips): a key of the view's `nested` map"),
  text: z.string().optional().describe('For titles and captions'),
  words: z
    .array(z.object({ text: z.string(), start: z.number().int(), end: z.number().int() }))
    .optional()
    .describe('Caption word timings, frames from the clip start'),
  style: settings('text.set style').optional(),
  start: frame.describe('First frame on the timeline'),
  end: frame.describe('Frame after the last one (exclusive)'),
  source: z
    .object({ in: frame, out: frame })
    .describe(
      'Source range in sequence frames from the start of the media, out exclusive; longer or shorter than the clip when its speed is changed',
    ),
  link: z.string().nullable().describe('Link group: linked clips move, trim and split together'),
  enabled: z.boolean(),
  speed: settings('clip.set_speed').optional(),
  gain: z.unknown().optional().describe('dB, as audio.set_gain takes it'),
  pan: z.number().optional().describe('-1 left to 1 right'),
  fade: z
    .object({ in_frames: z.number().optional(), out_frames: z.number().optional() })
    .optional(),
  transform: settings('clip.set_transform').optional(),
  blend: BlendMode.optional(),
  mask: settings('clip.set_mask mask').optional(),
  animation: settings('clip.set_animation').optional(),
});
export type ClipView = z.infer<typeof ClipView>;

export const TrackView = z.object({
  id: z.string(),
  kind: TrackKind,
  name: z.string(),
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  clips: z.array(ClipView),
  transitions: z
    .array(
      z.object({
        id: z.string(),
        from_clip_id: z.string(),
        to_clip_id: z.string(),
        kind: TransitionKind,
        start: frame,
        end: frame,
      }),
    )
    .optional()
    .describe('Transitions at cuts, frames end exclusive'),
});
export type TrackView = z.infer<typeof TrackView>;

export const MediaRefView = z.object({
  name: z.string(),
  duration: frame.nullable().describe('Length in sequence frames; null for stills'),
  video: z.boolean(),
  audio: z.boolean(),
});

const viewFields = {
  name: z.string(),
  sequence: Sequence,
  duration: frame.describe('Timeline length in frames'),
  tracks: z.array(TrackView).describe('Video tracks bottom to top, then audio tracks'),
  media: z.record(z.string(), MediaRefView),
};

export const NestedView = z.object(viewFields);
export type NestedView = z.infer<typeof NestedView>;

export const TimelineView = z.object({
  timeline_id: z.string(),
  parent: z.string().nullable(),
  ...viewFields,
  master: z.object({ gain_db: z.number(), limit_db: z.number().optional() }).optional(),
  // Loose here to keep timeline.get and timeline.load small; timeline.load checks each entry
  // against NestedView.
  nested: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .optional()
    .describe(
      'Timelines nested as compound clips, at any depth: each has this shape without timeline_id, parent or nested',
    ),
});
export type TimelineView = z.infer<typeof TimelineView>;

/** What `timeline.load` accepts: a view from `timeline.get`, without the ids it will recompute. */
export const TimelineInput = TimelineView.omit({ timeline_id: true, parent: true, duration: true })
  .extend({
    timeline_id: z.string().optional(),
    parent: z.string().nullable().optional(),
    duration: frame.optional(),
  })
  .describe('A timeline as returned by timeline.get');
export type TimelineInput = z.infer<typeof TimelineInput>;

export const Change = z.object({
  id: z.string(),
  type: z.enum(['clip', 'track', 'sequence', 'name']),
  change: z.enum(['added', 'removed', 'modified']),
});
export type Change = z.infer<typeof Change>;
