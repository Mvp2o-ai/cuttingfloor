import * as z from 'zod/v4';
import { Sequence } from './sequence.ts';

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

/** Stored clip. All times are ticks (TICKS_PER_SECOND). `start` is on the timeline, `in` in the source. */
export const StoredClip = z.object({
  id: z.string(),
  kind: TrackKind,
  media_id: z.string(),
  start: ticks,
  in: ticks,
  duration: z.number().int().positive(),
  link: z.string().nullable(),
  enabled: z.boolean(),
});
export type StoredClip = z.infer<typeof StoredClip>;

export const StoredTrack = z.object({
  id: z.string(),
  kind: TrackKind,
  name: z.string(),
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  clips: z.array(StoredClip),
});
export type StoredTrack = z.infer<typeof StoredTrack>;

export const TimelineOp = z.object({ tool: z.string(), args: z.unknown() });
export type TimelineOp = z.infer<typeof TimelineOp>;

/**
 * The stored timeline document. Immutable: its id is the hash of its canonical JSON, so an
 * edit always makes a new document whose `parent` is the one it was made from.
 * Video tracks are listed bottom to top; audio tracks are mixed.
 */
export const TimelineDoc = z.object({
  format: z.literal('cuttingfloor.timeline'),
  version: z.literal(1),
  name: z.string(),
  sequence: Sequence,
  tracks: z.array(StoredTrack),
  media: z.record(z.string(), MediaRef),
  next_id: z.number().int().positive(),
  parent: z.string().nullable(),
  op: TimelineOp.nullable(),
});
export type TimelineDoc = z.infer<typeof TimelineDoc>;

const frame = z.number().int().nonnegative();

/** The timeline as tools show it: integer frames at the sequence rate, end exclusive. */
export const ClipView = z.object({
  id: z.string(),
  kind: TrackKind,
  track_id: z.string(),
  media_id: z.string(),
  start: frame.describe('First frame on the timeline'),
  end: frame.describe('Frame after the last one (exclusive)'),
  source: z
    .object({ in: frame, out: frame })
    .describe('Source range in sequence frames from the start of the media, out exclusive'),
  link: z.string().nullable().describe('Link group: linked clips move, trim and split together'),
  enabled: z.boolean(),
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
});
export type TrackView = z.infer<typeof TrackView>;

export const MediaRefView = z.object({
  name: z.string(),
  duration: frame.nullable().describe('Length in sequence frames; null for stills'),
  video: z.boolean(),
  audio: z.boolean(),
});

export const TimelineView = z.object({
  timeline_id: z.string(),
  parent: z.string().nullable(),
  name: z.string(),
  sequence: Sequence,
  duration: frame.describe('Timeline length in frames'),
  tracks: z.array(TrackView).describe('Video tracks bottom to top, then audio tracks'),
  media: z.record(z.string(), MediaRefView),
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
