import * as z from 'zod/v4';
import {
  AnimatableValue,
  BlendMode,
  Crop,
  Fit,
  Flip,
  InOutAnimation,
  LoopAnimation,
  MASK_LIMITS,
  MaskShape,
  TRANSFORM_LIMITS,
  TransitionKind,
} from './compositing.ts';
import { ToolError } from './errors.ts';
import { JobId, MediaId, TimelineId, UploadId } from './ids.ts';
import { JUDGE_LIMITS, JudgeName, JudgeQuestion, JudgeText, NoulFields } from './judge.ts';
import { ASSET_NAME, MOTION_LIMITS } from './motion.ts';
import { Sequence } from './sequence.ts';
import { Colour, TextStyle } from './text.ts';
import { Change, TimelineInput, TimelineView, TrackKind } from './timeline.ts';

const frame = z.number().int().nonnegative();

export const Preview = z
  .enum(['inline', 'link', 'none'])
  .default('link')
  .describe('inline: image in the result; link: URI that renders on read; none');

const Mode = z
  .enum(['overwrite', 'insert'])
  .default('overwrite')
  .describe('overwrite replaces what is underneath; insert pushes later clips right');

const OtherTracks = z
  .enum(['stay', 'sync'])
  .default('stay')
  .describe(
    "What the other tracks do when this edit moves later clips on the clip's own tracks (linked clips always move with it). stay: they don't move, and the result warns which clips there now play early or late. sync: they get the same change, so titles, overlays and sound stay in step: time taken out here comes out of them too (like range.extract), time added here opens the same gap in them (clips crossing that point are split, as insert does). Locked tracks always stay",
  );

const anim = (limits: readonly [number, number], text: string) =>
  AnimatableValue.optional().describe(`${text}; ${limits[0]} to ${limits[1]}`);

export const TransformArgs = z.object({
  x: anim(TRANSFORM_LIMITS.x, 'Centre x, 0 = left edge, 1 = right edge (default 0.5)'),
  y: anim(TRANSFORM_LIMITS.y, 'Centre y, 0 = top, 1 = bottom (default 0.5)'),
  scale: anim(TRANSFORM_LIMITS.scale, 'Size relative to the fit (default 1)'),
  scale_x: anim(TRANSFORM_LIMITS.scale_x, 'Extra horizontal stretch (default 1)'),
  scale_y: anim(TRANSFORM_LIMITS.scale_y, 'Extra vertical stretch (default 1)'),
  rotation: anim(TRANSFORM_LIMITS.rotation, 'Degrees clockwise (default 0)'),
  opacity: anim(TRANSFORM_LIMITS.opacity, 'Opacity (default 1)'),
  fit: Fit.nullable().optional(),
  flip: Flip.nullable().optional(),
  crop: Crop.nullable().optional(),
});

export const MaskArgs = z.object({
  shape: MaskShape,
  x: anim(MASK_LIMITS.x, 'Mask centre x in the clip picture, 0–1 (default 0.5)'),
  y: anim(MASK_LIMITS.y, 'Mask centre y in the clip picture, 0–1 (default 0.5)'),
  width: anim(MASK_LIMITS.width, 'Fraction of the picture width (default 0.5)'),
  height: anim(
    MASK_LIMITS.height,
    'Fraction of the picture height (default 0.5); band thickness for mirror',
  ),
  rotation: anim(MASK_LIMITS.rotation, 'Degrees clockwise; for linear, the edge angle'),
  feather: z
    .number()
    .min(0)
    .max(0.5)
    .optional()
    .describe('Soft edge as a fraction of the picture short side'),
  corner_radius: z
    .number()
    .min(0)
    .max(0.5)
    .optional()
    .describe('rectangle: corner radius as a fraction of its short side'),
  invert: z.boolean().optional().describe('Keep the outside instead'),
  points: z
    .array(z.tuple([z.number().min(-4).max(5), z.number().min(-4).max(5)]))
    .min(3)
    .max(64)
    .optional()
    .describe('polygon: [x, y] corners in the clip picture, 0–1'),
});

const FrameRange = z
  .object({ start: frame, end: frame })
  .refine((r) => r.end > r.start, { message: 'end must be after start (end is exclusive)' })
  .describe('Timeline frames, end exclusive');
const TrackIds = z
  .array(z.string())
  .min(1)
  .optional()
  .describe('Tracks to act on. Default: every unlocked track');

const InOut = z.object({
  name: InOutAnimation,
  duration_frames: z.number().int().positive().max(100_000),
});

// Edit operations. Each tool takes `{timeline_id, preview}` plus these args; edit.batch takes
// the args alone, by tool name.
export const EditArgs = {
  'timeline.set_sequence': z.object({ sequence: Sequence }),
  'track.add': z.object({
    kind: TrackKind,
    name: z.string().min(1).max(100).optional(),
  }),
  'track.remove': z.object({ track_id: z.string() }),
  'track.set': z.object({
    track_id: z.string(),
    name: z.string().min(1).max(100).optional(),
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
  }),
  'clip.add': z.object({
    track_id: z
      .string()
      .describe('Track for the clip; a linked A/V clip puts its other half on link_track_id'),
    media_id: MediaId.optional(),
    nested_timeline_id: TimelineId.optional().describe(
      'Instead of media: nest another timeline as one clip (a compound clip)',
    ),
    at_frame: frame.optional().describe('Where the clip starts. Default: after the last clip'),
    after_clip_id: z
      .string()
      .optional()
      .describe('Start where this clip ends (instead of at_frame)'),
    source: z
      .union([
        z.object({ in: frame, out: frame }),
        z
          .object({ words: z.tuple([z.number().int().min(0), z.number().int().min(0)]) })
          .describe('Transcript words i to j (inclusive), from media.get include transcript'),
      ])
      .optional()
      .describe('Source range in sequence frames, out exclusive. Default: the whole media'),
    duration_frames: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Length for stills (default 5 s); ignored when source is given'),
    av: z
      .enum(['linked', 'video', 'audio'])
      .default('linked')
      .describe('linked: video and audio as a link group; video or audio: only that part'),
    link_track_id: z
      .string()
      .optional()
      .describe('Track for the other half of a linked clip. Default: the first track of that kind'),
    mode: Mode,
    other_tracks: OtherTracks,
  }),
  'clip.remove': z.object({
    clip_id: z.string(),
    ripple: z.boolean().default(false).describe('Close the gap by pulling later clips left'),
    other_tracks: OtherTracks,
  }),
  'clip.move': z.object({
    clip_id: z.string(),
    to_frame: frame,
    to_track_id: z.string().optional(),
    mode: Mode,
    ripple: z.boolean().default(false).describe('Close the gap left behind'),
    other_tracks: OtherTracks,
  }),
  'clip.trim': z.object({
    clip_id: z.string(),
    edge: z.enum(['start', 'end']),
    to_frame: frame.describe('New timeline position of that edge'),
    ripple: z
      .boolean()
      .default(false)
      .describe('Shift later clips so nothing overlaps and no gap opens'),
    side: z
      .enum(['both', 'video', 'audio'])
      .default('both')
      .describe('Trim only one half of a link group (J/L cuts)'),
    other_tracks: OtherTracks,
  }),
  'clip.split': z.object({ clip_id: z.string(), at_frame: frame }),
  'clip.link': z.object({ clip_ids: z.array(z.string()).min(2) }),
  'clip.unlink': z.object({ clip_id: z.string() }),
  'clip.set_enabled': z.object({ clip_id: z.string(), enabled: z.boolean() }),
  'clip.set_speed': z.object({
    clip_id: z.string(),
    rate: z.number().min(0.05).max(100).optional().describe('Constant speed: 2 = twice as fast'),
    curve: z
      .array(z.object({ at: z.number().min(0).max(1), rate: z.number().min(0.05).max(100) }))
      .min(2)
      .max(32)
      .optional()
      .describe(
        'Speed ramp: rates at fractions of the clip as it plays after the change (first at 0, last at 1; 0.5 is halfway through the new length), linear between. timeline.get gives each point its clip frame and source frame',
      ),
    reverse: z.boolean().optional(),
    preserve_pitch: z.boolean().optional().describe('Keep voices at their pitch (default true)'),
    ripple: z
      .boolean()
      .default(true)
      .describe('Move later clips as the clip gets longer or shorter'),
    other_tracks: OtherTracks,
  }),
  'clip.freeze': z.object({
    clip_id: z.string(),
    at_frame: frame.describe('Timeline frame to hold'),
    duration_frames: z.number().int().positive().max(1_000_000),
    other_tracks: OtherTracks,
  }),
  'clip.roll': z.object({
    clip_id: z.string().describe('The clip before the cut'),
    to_frame: frame.describe('New position of the cut'),
  }),
  'clip.slip': z.object({
    clip_id: z.string(),
    by_frames: z
      .number()
      .int()
      .min(-10_000_000)
      .max(10_000_000)
      .describe('Positive shows later source'),
  }),
  'clip.slide': z.object({ clip_id: z.string(), to_frame: frame }),
  'clip.replace': z.object({
    clip_id: z.string(),
    media_id: MediaId,
    source_in: frame.optional().describe('Source frame the clip starts at. Default 0'),
  }),
  'range.lift': z.object({ range: FrameRange, track_ids: TrackIds }),
  'range.extract': z.object({ range: FrameRange, track_ids: TrackIds }),
  'title.add': z.object({
    track_id: z.string().describe('A video track; text composites over the tracks below'),
    text: z.string().min(1).max(2000).describe('Line breaks with \\n'),
    at_frame: frame.optional().describe('Default: after the last clip on the track'),
    duration_frames: z.number().int().positive().max(1_000_000).optional().describe('Default 3 s'),
    style: TextStyle.optional(),
  }),
  'caption.add': z.object({
    track_id: z.string().describe('A video track for the captions, usually the top one'),
    segments: z
      .array(
        z.object({
          start_frame: frame,
          end_frame: frame,
          text: z.string().min(1).max(2000),
          words: z
            .array(
              z.object({ text: z.string().min(1).max(200), start_frame: frame, end_frame: frame }),
            )
            .max(500)
            .optional()
            .describe('Word timings for highlights, timeline frames'),
        }),
      )
      .max(5000)
      .optional(),
    in_clip: z
      .object({
        clip_id: z.string(),
        segments: z
          .array(
            z.object({
              start: z.number().min(0),
              end: z.number().min(0),
              text: z.string().min(1).max(2000),
              words: z
                .array(
                  z.object({
                    text: z.string().min(1).max(200),
                    start: z.number().min(0),
                    end: z.number().min(0),
                  }),
                )
                .max(500)
                .optional(),
            }),
          )
          .min(1)
          .max(5000),
      })
      .optional()
      .describe(
        "Segments timed in seconds of a clip's media (e.g. transcript word times), placed where those moments play in the clip, through speed changes; what doesn't play is left out",
      ),
    srt: z.string().max(2_000_000).optional().describe('SubRip text instead of segments'),
    vtt: z.string().max(2_000_000).optional().describe('WebVTT text instead of segments'),
    offset_frames: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .default(0)
      .describe('Shifts srt/vtt times'),
    style: TextStyle.optional(),
  }),
  'text.set': z.object({
    clip_ids: z.array(z.string()).min(1).max(5000).optional().describe('Titles or captions'),
    track_id: z
      .string()
      .optional()
      .describe('Instead of clip_ids: every title and caption on a track'),
    text: z.string().min(1).max(2000).optional().describe('Only with a single clip'),
    style: TextStyle.optional().describe("Merged into each clip's style; null fields reset"),
  }),
  'audio.set_gain': z.object({
    clip_id: z.string().describe('An audio clip, or a video clip whose linked audio to change'),
    gain_db: AnimatableValue.describe('dB, -60 to 24; 0 leaves it as it is; keyframes for rides'),
  }),
  'audio.set_pan': z.object({
    clip_id: z.string(),
    pan: z.number().min(-1).max(1).nullable().describe('-1 left, 0 centre, 1 right; null resets'),
  }),
  'audio.fade': z.object({
    clip_id: z.string(),
    in_frames: z.number().int().positive().max(1_000_000).nullable().optional(),
    out_frames: z.number().int().positive().max(1_000_000).nullable().optional(),
  }),
  'audio.set_master': z.object({
    gain_db: z.number().min(-60).max(40).nullable().optional(),
    limit_db: z
      .number()
      .min(-20)
      .max(0)
      .nullable()
      .optional()
      .describe('Limiter ceiling on sample peaks, dBFS'),
  }),
  'filter.add': z.object({
    clip_id: z.string().optional().describe('Apply to one clip (or an adjustment clip)'),
    track_id: z.string().optional().describe('Or to every clip on a track'),
    timeline: z.boolean().optional().describe('Or true for the whole picture or mix'),
    name: z.string().min(1).max(60).describe('An effect from video://catalog/effects'),
    params: z.record(z.string(), z.unknown()).default({}).describe('As the catalogue lists them'),
  }),
  'filter.set': z.object({
    filter_id: z.string(),
    params: z.record(z.string(), z.unknown()).optional().describe('Merged into its params'),
    enabled: z.boolean().optional(),
  }),
  'filter.remove': z.object({ filter_id: z.string() }),
  'adjustment.add': z.object({
    track_id: z.string().describe('A video track; the effects reach every track below it'),
    at_frame: frame.optional().describe('Default: after the last clip on the track'),
    duration_frames: z.number().int().positive().max(10_000_000),
  }),
  'transition.add': z.object({
    clip_id: z.string().describe('The clip before the cut; the clip after it must touch it'),
    kind: TransitionKind.describe('video://catalog/transitions; crossfade on audio tracks'),
    duration_frames: z.number().int().min(2).max(10_000),
    mode: z
      .enum(['overlap', 'handles'])
      .default('overlap')
      .describe(
        'overlap: the clips overlap by the duration and later clips move earlier; handles: use source past the cut, nothing moves',
      ),
    other_tracks: z
      .enum(['stay', 'extract'])
      .default('stay')
      .describe(
        "overlap only: what the other tracks do. stay: they don't move, so what sits after the cut there plays later against the picture (the result warns which clips); extract: the same span comes out of them too, like range.extract, so everything stays in sync",
      ),
  }),
  'transition.set': z.object({
    transition_id: z.string(),
    kind: TransitionKind.optional(),
    duration_frames: z.number().int().min(2).max(10_000).optional(),
  }),
  'transition.remove': z.object({ transition_id: z.string() }),
  'clip.set_transform': TransformArgs.extend({ clip_id: z.string() }),
  'clip.set_blend': z.object({ clip_id: z.string(), mode: BlendMode }),
  'clip.set_mask': z.object({
    clip_id: z.string(),
    mask: MaskArgs.nullable().describe('null removes the mask'),
  }),
  'clip.set_animation': z.object({
    clip_id: z.string(),
    in: InOut.nullable().optional().describe('Entrance, from the clip start'),
    out: InOut.nullable().optional().describe('Exit, ending at the clip end'),
    loop: z
      .object({
        name: LoopAnimation,
        period_frames: z.number().int().positive().max(100_000).optional(),
        strength: z.number().min(0).max(5).default(1),
      })
      .nullable()
      .optional()
      .describe('Repeats for the whole clip'),
  }),
} as const;
export type EditTool = keyof typeof EditArgs;
export const EDIT_TOOLS = Object.keys(EditArgs) as EditTool[];
export type EditArgsOf<T extends EditTool> = z.infer<(typeof EditArgs)[T]>;

const editEnvelope = { timeline_id: TimelineId, preview: Preview };

export function editInput<T extends EditTool>(tool: T) {
  return EditArgs[tool].extend(editEnvelope);
}

export const PreviewRef = z.object({
  uri: z.string(),
  frames: z.array(frame).describe('Frames shown; for a waveform, the start and end of its span'),
  status: z.enum(['ready', 'pending']),
  loudness: z
    .object({ lufs: z.number().nullable(), true_peak_db: z.number().nullable() })
    .optional()
    .describe('Measured for audio edits, over the waveform span'),
});

export const EditResult = z.object({
  timeline_id: TimelineId,
  parent: TimelineId,
  changed: z.array(Change),
  clip_id: z.string().optional(),
  clip_ids: z.array(z.string()).optional(),
  track_id: z.string().optional(),
  preview: PreviewRef.nullable(),
  warnings: z.array(z.string()),
});
export type EditResult = z.infer<typeof EditResult>;

export const BatchInput = z.object({
  timeline_id: TimelineId,
  preview: Preview,
  ops: z
    .array(
      z.object({
        tool: z.enum(EDIT_TOOLS as [EditTool, ...EditTool[]]),
        args: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(200)
    .describe(
      'Edits applied in order as one change. An arg may be {"$ref":"ops[2].clip_id"} to use an id made by an earlier op',
    ),
});

export const BatchResult = EditResult.extend({
  results: z.array(
    z.object({
      tool: z.string(),
      clip_id: z.string().optional(),
      clip_ids: z.array(z.string()).optional(),
      track_id: z.string().optional(),
    }),
  ),
});

export const TimelineCreateInput = z.object({
  name: z.string().min(1).max(200).default('Untitled'),
  sequence: Sequence,
  tracks: z
    .object({ video: z.number().int().min(0).max(32), audio: z.number().int().min(0).max(32) })
    .default({ video: 1, audio: 1 })
    .describe('How many empty tracks to start with'),
});
export const TimelineRef = z.object({ timeline_id: TimelineId });
export const TimelineLoadInput = z.object({ timeline: TimelineInput });
export const TimelineIdResult = z.object({ timeline_id: TimelineId });
export const TimelineCreateResult = z.object({
  timeline_id: TimelineId,
  tracks: z
    .array(z.object({ id: z.string(), kind: TrackKind, name: z.string() }))
    .describe('The new tracks; edits take the id (track_id), not the name'),
});
export const TimelineGetResult = TimelineView;
export const TimelineHistoryInput = z.object({
  timeline_id: TimelineId,
  limit: z.number().int().min(1).max(500).default(50),
});
export const TimelineHistoryResult = z.object({
  entries: z.array(
    z.object({
      timeline_id: TimelineId,
      parent: TimelineId.nullable(),
      tool: z.string().nullable(),
      args: z.unknown(),
      available: z.boolean().describe('false once the stored timeline has expired'),
    }),
  ),
  truncated: z.boolean(),
});
export const TimelineDiffInput = z.object({ from: TimelineId, to: TimelineId });
export const TimelineDiffResult = z.object({ changed: z.array(Change) });

// Media
/** Limits that protect the server. */
export const MEDIA_LIMITS = {
  /** Largest file a data: URI may carry. */
  inlineBytes: 8 * 1024 ** 2,
} as const;

export const MediaSource = z.union([
  z.object({
    path: z
      .string()
      .min(1)
      .describe('A file under a media root, e.g. /media/videos/clip.mp4 (local mode)'),
  }),
  z.object({ url: z.url().describe('An http(s) URL to download') }),
  z.object({
    upload_id: UploadId.describe('A file sent to the URL media.upload gave, once fully sent'),
  }),
  z
    .object({
      upload: z.object({
        name: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[^/\\]+$/)
          .describe('The file name with its extension, e.g. interview.mp4'),
        bytes: z
          .int()
          .positive()
          .optional()
          .describe('The file size, to be refused now rather than part way if it is too big'),
      }),
    })
    .describe(
      'A file you send next: the answer is the new media with upload.url; PUT the file there and it imports once the last byte arrives',
    ),
  z.object({
    data: z
      .string()
      .min(6)
      .max(Math.ceil((MEDIA_LIMITS.inlineBytes * 4) / 3) + 200)
      .describe(
        `A small file written out as a data: URI (data:image/png;base64,…), up to ${MEDIA_LIMITS.inlineBytes / 1024 ** 2} MB: a logo, a still, a short sound. Bigger files go through media.upload`,
      ),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe(
        "The file's SHA-256 in hex; the import is refused if the data decodes to anything else",
      ),
  }),
  z.object({
    job_id: JobId.describe(
      'A completed export.video: its rendered file becomes media, e.g. to re-edit a finished cut or place it in a sequence of another shape',
    ),
  }),
]);

/** A file the client attached (ChatGPT passes these for fields named in openai/fileParams). */
export const AttachedFile = z.object({
  download_url: z.url().describe('Where the server downloads the file from'),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

export const MediaImportInput = z.object({
  source: MediaSource.optional().describe('Where the file is. Give this or file'),
  file: AttachedFile.optional().describe(
    'A file the user attached in the chat, as the client passes it (instead of source)',
  ),
  name: z.string().min(1).max(200).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const MediaUploadInput = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^/\\]+$/)
    .describe('The file name with its extension, e.g. interview.mp4'),
  bytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('The file size, to be refused now rather than part way if it is too big'),
});

export const MediaUploadResult = z.object({
  upload_id: UploadId,
  url: z.string().describe('Signed: PUT the file here; no other credentials needed'),
  expires_at: z.string(),
  max_bytes: z.number(),
  how: z.string(),
});

export const ANALYSES = ['transcript', 'beats', 'faces', 'look'] as const;

export const MediaRefInput = z.object({
  media_id: MediaId,
  include: z
    .array(z.enum(ANALYSES))
    .optional()
    .describe(
      'Also return these analyses (otherwise only their summaries): in full, or the piece from_seconds, to_seconds, offset and limit choose',
    ),
  from_seconds: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Only what ends after this media time: transcript words, beats, face and look frames',
    ),
  to_seconds: z.number().positive().optional().describe('Only what starts before this media time'),
  offset: z
    .int()
    .min(0)
    .default(0)
    .describe('Skip this many items of each included list (after the time range)'),
  limit: z
    .int()
    .min(1)
    .optional()
    .describe('At most this many items of each included list; pages says where the next starts'),
});

/** Stored look runs. Loosely typed in results: the shapes are JudgeQuestion and JudgeAnswer. */
export const LookAnalysis = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      questions: z.record(z.string(), z.unknown()),
      with_previous: z.boolean(),
      state: z.record(z.string(), z.unknown()).optional(),
      frames: z.array(
        z.object({
          time: z.number(),
          answers: z.record(z.string(), z.record(z.string(), z.unknown())),
        }),
      ),
    }),
  ),
});

export const MediaAnalyzeInput = z.object({
  media_id: MediaId,
  kind: z
    .enum(['transcript', 'beats', 'faces', 'track', 'look', 'silence', 'scenes'])
    .describe(
      'transcript: words with times (whisper.cpp, local); beats: tempo and beat times; faces: face boxes over time; track: follow a region; look: your own questions answered on sampled frames; silence: stretches quieter than threshold_db for min_seconds; scenes: times the picture changes by more than threshold',
    ),
  questions: z
    .record(JudgeName, JudgeQuestion)
    .optional()
    .describe(
      `look: id (yours, not shown to the model) to question; up to ${JUDGE_LIMITS.lookQuestions}, all asked of every frame`,
    ),
  state: z
    .record(JudgeName, JudgeText)
    .optional()
    .describe(
      'look: text or JSON entries shown beside `frame` on every frame, by name, for questions to refer to (a script line, a definition)',
    ),
  every_seconds: z
    .number()
    .min(0.04)
    .max(3600)
    .optional()
    .describe('look: sample a frame this often. Default 1'),
  at_seconds: z
    .array(z.number().min(0))
    .min(1)
    .max(600)
    .optional()
    .describe('look: sample exactly these times instead'),
  from_seconds: z.number().min(0).optional().describe('look: start sampling here. Default 0'),
  with_previous: z
    .boolean()
    .default(false)
    .describe('look: also show the frame sampled before, as `previous`'),
  model: z
    .enum(['tiny', 'base', 'small'])
    .default('base')
    .describe('transcript: speed vs accuracy'),
  language: z.string().min(2).max(8).default('auto').describe("transcript: e.g. 'en', or 'auto'"),
  region: z
    .object({
      at_seconds: z.number().min(0),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0.005).max(1),
      h: z.number().min(0.005).max(1),
    })
    .optional()
    .describe(
      'track: the box to follow (top-left x, y and size, fractions of the picture) and when',
    ),
  until_seconds: z.number().min(0).optional().describe('track, look: stop here. Default: the end'),
  threshold_db: z
    .number()
    .min(-100)
    .max(0)
    .optional()
    .describe('silence (required): quieter than this counts as silence, dBFS'),
  min_seconds: z
    .number()
    .min(0.01)
    .max(3600)
    .optional()
    .describe('silence (required): only stretches at least this long'),
  threshold: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('scenes (required): how much the picture must change to count as a cut, 0–100'),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const Transcript = z.object({
  model: z.string(),
  language: z.string(),
  text: z.string(),
  words: z
    .array(
      z.object({ text: z.string(), start: z.number(), end: z.number(), confidence: z.number() }),
    )
    .describe(
      'Media seconds, up to about a second off: starts can sit in the silence before a word and ends run over the pause after it; short ums are often missing',
    ),
});
export const BeatsAnalysis = z.object({
  bpm: z.number(),
  beats: z.array(z.number()),
  downbeats: z.array(z.number()),
});
export const FacesAnalysis = z.object({
  rate: z.number(),
  frames: z.array(
    z.object({
      time: z.number(),
      faces: z.array(
        z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), score: z.number() }),
      ),
    }),
  ),
});

export const MediaStatus = z.enum(['importing', 'processing', 'ready', 'failed']);

/** Which piece of one analysis list media.get returned. */
export const MediaPage = z.object({
  list: z
    .string()
    .describe(
      "The list paged: transcript.words, beats.beats, faces.frames, or look runs[].frames (each run is cut the same way; first and the counts are the latest run's)",
    ),
  first: z
    .int()
    .describe(
      'Index in the whole list of the first item returned (transcript: the word index clip.add source {words} takes)',
    ),
  returned: z.int(),
  matching: z.int().describe('Items in the time range (the whole list without one)'),
  total: z.int().describe('Items in the whole list'),
  next_offset: z
    .int()
    .nullable()
    .describe('The offset that gives the next page of this range, or null at its end'),
});
export type MediaPage = z.infer<typeof MediaPage>;
/** Where a media came from, as recorded when it was made. */
export const MediaOrigin = z
  .object({
    from: z
      .enum(['upload', 'url', 'path', 'render', 'created'])
      .describe(
        'upload: a file the user sent; url: downloaded; path: a media root; render: an export.video; created: a create.* tool',
      ),
    url: z
      .string()
      .optional()
      .describe('url: the address it was downloaded from, without its query string'),
    attached: z
      .boolean()
      .optional()
      .describe('url: the file the user attached in the chat, passed as media.import file'),
    path: z.string().optional().describe('path: the file it was imported from'),
    upload_id: UploadId.optional(),
    file_name: z.string().optional().describe('upload: the name the file was sent with'),
    via: z
      .enum(['media.upload', 'account_page', 'data_uri'])
      .optional()
      .describe(
        'upload: sent through a media.upload link, dropped on the account page, or a data: URI',
      ),
    job_id: JobId.optional().describe('render: the export.video job; created: the create.* job'),
    timeline_id: TimelineId.optional().describe('render: the timeline that was exported'),
    preset: z.string().optional().describe('render: the export preset'),
    range: z
      .object({ start: z.number(), end: z.number() })
      .optional()
      .describe('render: the frames exported, when not the whole timeline'),
    sources: z
      .array(
        z.object({
          track_id: z.string().describe('Track of the timeline; outer/inner inside a nested one'),
          kind: z.enum(['video', 'audio']),
          start: z.number().describe('Seconds into this file'),
          end: z.number(),
          media_id: MediaId.describe('The media this stretch plays'),
          source_in: z.number().describe('Seconds into that media'),
          source_out: z.number(),
          speed: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("The clip's speed change, as clip.set_speed set it"),
        }),
      )
      .optional()
      .describe(
        "render: where each stretch of this file comes from, per track, read from the timeline when it was exported (kept after the timeline expires). With a speed curve, source_in and source_out are the clip's whole source range",
      ),
    tool: z.string().optional().describe('created: the create.* tool that made it'),
    recipe: z
      .string()
      .optional()
      .describe('created: a hash of what it was made from; the same recipe makes the same media'),
    media_ids: z
      .array(MediaId)
      .optional()
      .describe("created: the media it was made from (a cutout's source, a page's assets)"),
  })
  .describe(
    'Where it came from, to tell one version from another: the import source, the export of which timeline, or the create.* tool and the media it was made from',
  );
export type MediaOrigin = z.infer<typeof MediaOrigin>;

export const MediaInfo = z.object({
  media_id: MediaId,
  name: z.string(),
  url: z
    .string()
    .optional()
    .describe('media.get: a signed download of the file itself, once it has one'),
  page_url: z
    .string()
    .optional()
    .describe(
      'media.get: a page that plays or shows the file in any browser, with no sign-in, to give a person; works until expires_at',
    ),
  expires_at: z.string().optional().describe('When url and page_url stop working'),
  origin: MediaOrigin.optional(),
  created_at: z.string().optional().describe('When it was imported or made'),
  status: MediaStatus.describe(
    'importing: not probed yet; processing: usable in edits, proxy still rendering; ready; failed',
  ),
  kind: z.enum(['video', 'audio', 'image', 'font', 'lut']).nullable(),
  font_family: z
    .string()
    .optional()
    .describe('Fonts: the family; use font_media_id in a text style to set text in it'),
  duration_seconds: z.number().nullable(),
  fps: z.object({ num: z.number(), den: z.number() }).nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  has_video: z.boolean(),
  has_audio: z.boolean(),
  codecs: z.object({ video: z.string().nullable(), audio: z.string().nullable() }),
  conform: z
    .array(z.string())
    .describe('Why a mezzanine was made (vfr, rotation, hdr, codec); empty when not needed'),
  analysis: z
    .object({ loudness_lufs: z.number().nullable().describe('Integrated loudness at import') })
    .nullable(),
  analyses: z
    .object({
      transcript: z
        .object({
          model: z.string(),
          language: z.string(),
          words: z
            .number()
            .describe('How many words; the words themselves are in transcript.words'),
        })
        .optional(),
      beats: z.object({ bpm: z.number(), beats: z.number() }).optional(),
      faces: z.object({ rate: z.number(), frames_with_faces: z.number() }).optional(),
      look: z
        .object({ runs: z.number(), frames: z.number(), questions: z.array(z.string()) })
        .optional()
        .describe('frames and questions: the latest run'),
    })
    .optional()
    .describe(
      'Summaries of media.analyze results (counts, not data); include puts each in full at the top level',
    ),
  transcript: Transcript.optional().describe(
    'With include ["transcript"]: every word as {text, start, end, confidence}',
  ),
  beats: BeatsAnalysis.optional(),
  faces: FacesAnalysis.optional(),
  look: LookAnalysis.optional(),
  upload: z
    .object({
      upload_id: UploadId,
      url: z.string().describe('Signed: PUT the file here; no other credentials needed'),
      expires_at: z.string(),
      max_bytes: z.number(),
    })
    .optional()
    .describe(
      'media.import {source: {upload}}: where to send the file. It imports once the last byte arrives (the PUT answers with the job_id); media.get says where it stands',
    ),
  pages: z
    .partialRecord(z.enum(ANALYSES), MediaPage)
    .optional()
    .describe(
      'media.get with a range, offset or limit: per included analysis, which piece of its list came back',
    ),
  error: ToolError.optional(),
});
export type MediaInfo = z.infer<typeof MediaInfo>;

/** Limits that protect the server: the most of each list one media.list returns. */
export const MEDIA_LIST_LIMIT = 200;

export const MediaListInput = z.object({});

export const MediaListResult = z.object({
  media: z
    .array(
      z.object({
        media_id: MediaId,
        name: z.string(),
        status: MediaStatus,
        kind: z.enum(['video', 'audio', 'image', 'font', 'lut']).nullable(),
        duration_seconds: z.number().nullable(),
        from: z
          .enum(['upload', 'url', 'path', 'render', 'created'])
          .describe(
            'upload: a file the user sent; url: downloaded; path: a media root; render: an export.video; created: a create.* tool',
          ),
        origin: MediaOrigin,
        bytes: z.number().nullable().describe('Size of the original file'),
        created_at: z.string(),
        expires_at: z.string().describe('7 days after last use; any use pushes it back'),
      }),
    )
    .describe(`Imported and created media, most recently used first (up to ${MEDIA_LIST_LIMIT})`),
  media_count: z.number().int().describe('All media held, including any not listed'),
  uploads: z
    .array(
      z.object({
        upload_id: UploadId,
        name: z.string(),
        received_bytes: z.number(),
        bytes: z.number().nullable().describe('The size given when the upload began, if any'),
        complete: z.boolean().describe('All sent: media.import {source: {upload_id}} takes it'),
        created_at: z.string(),
        expires_at: z.string(),
      }),
    )
    .describe(
      `Files sent to the server and not imported yet, newest first (up to ${MEDIA_LIST_LIMIT}): through media.upload, or dropped on the account page by the user`,
    ),
  upload_count: z.number().int(),
  storage: z.object({
    used_bytes: z.number().describe('Everything held: uploads, media with its proxies, exports'),
    max_bytes: z.number().nullable().describe("The plan's cap; null for none"),
  }),
});

export const MediaDeleteInput = z.object({ media_id: MediaId });

export const MediaDeleteResult = z.object({
  media_id: MediaId,
  deleted: z.literal(true),
  freed_bytes: z
    .number()
    .describe('What it held here: the file, its proxy and mezzanine, and its analyses'),
  storage: z.object({
    used_bytes: z.number(),
    max_bytes: z.number().nullable().describe("The plan's cap; null for none"),
  }),
});

export const MediaAnalyzeResult = z.object({
  media_id: MediaId,
  kind: z.enum(['transcript', 'beats', 'faces', 'track', 'look', 'silence', 'scenes']),
  summary: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The summary media.get gives under analyses; look: where each answer holds'),
  model: z.string().optional().describe('look: the Jev model'),
  frames: z.number().optional().describe('look: frames asked about'),
  transcript: Transcript.optional(),
  beats: BeatsAnalysis.optional(),
  faces: FacesAnalysis.optional(),
  look: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('look: this run (id, model, questions, frames with answers)'),
  track: z
    .object({
      rate: z.number(),
      points: z.array(
        z.object({
          time: z.number(),
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          found: z.boolean(),
        }),
      ),
    })
    .optional(),
  silences: z
    .array(z.object({ start: z.number(), end: z.number() }))
    .optional()
    .describe('silence: media seconds'),
  scenes: z.array(z.number()).optional().describe('scenes: cut times, media seconds'),
  note: z
    .string()
    .optional()
    .describe('In place of the analysis when it is too long to return: where to read it'),
});

/** A media.seek criterion: a Jev noul, or its instructions alone as a plain statement. */
export const SeekCriterion = z.union([z.string().min(1), z.object(NoulFields).strict()]);

export const MediaSeekInput = z
  .object({
    media_id: MediaId.optional().describe('Seek in imported media (media seconds)'),
    timeline_id: TimelineId.optional().describe(
      'Seek in an edit as it renders (timeline seconds): gaps, cuts, titles and effects included',
    ),
    criteria: z
      .record(JudgeName, SeekCriterion)
      .describe(
        `Name (yours, not shown to the model) to what a matching frame shows: a statement or question about the picture, or {instructions, criteria: {true, false}} to say what counts as yes and as no. Up to ${JUDGE_LIMITS.lookQuestions}, each judged on every frame`,
      ),
    state: z
      .record(JudgeName, JudgeText)
      .optional()
      .describe(
        'Text or JSON entries shown beside `frame` on every frame, by name, for criteria to refer to (a script line, what a term means)',
      ),
    every_seconds: z
      .number()
      .min(0.04)
      .max(3600)
      .optional()
      .describe('Sample a frame this often. Default 1'),
    at_seconds: z
      .array(z.number().min(0))
      .min(1)
      .max(JUDGE_LIMITS.frames)
      .optional()
      .describe('Sample exactly these times instead'),
    from_seconds: z.number().min(0).optional().describe('Start sampling here. Default 0'),
    until_seconds: z.number().min(0).optional().describe('Stop here. Default: the end'),
    with_previous: z
      .boolean()
      .default(false)
      .describe(
        'Also show the frame sampled before, as `previous`, for criteria about change. The first sample is only shown as `previous`',
      ),
    min_probability: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe('A frame matches a criterion when its probability is at least this'),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.media_id) !== Boolean(v.timeline_id), {
    message: 'Give exactly one of media_id or timeline_id',
  });

export const MediaSeekResult = z.object({
  media_id: MediaId.optional(),
  timeline_id: TimelineId.optional(),
  model: z.string().describe('The Jev model that judged the frames'),
  frames: z.number().describe('Frames judged'),
  asked: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .describe('Per criterion: the noul question Jev was asked, as sent'),
  matches: z
    .record(
      z.string(),
      z.array(
        z.object({
          start: z.number().describe('First matching sample, in seconds'),
          end: z.number().describe('Last matching sample of the run, in seconds'),
          peak_seconds: z.number().describe('The sample most likely to match'),
          peak_probability: z.number(),
          frame: frame.describe('peak_seconds as a frame number, for render.frames'),
          uri: z.string().describe('MCP resource: the picture at peak_seconds'),
        }),
      ),
    )
    .describe(
      'Per criterion: runs of consecutive samples that match, in time order; empty when none do',
    ),
  samples: z
    .array(
      z.object({
        seconds: z.number(),
        probabilities: z.record(z.string(), z.number()).describe('Per criterion, 0 to 1'),
      }),
    )
    .describe('Every judged sample, for your own cut-off or arithmetic'),
});

// Create: new media from a recipe. Always a job; the result is a media_id for clip.add.
const createCommon = {
  name: z.string().min(1).max(200).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
};
const size = (fallback: number) =>
  z.int().min(MOTION_LIMITS.minSize).max(MOTION_LIMITS.maxSize).default(fallback);
const MotionAssets = z
  .array(
    z.object({
      name: z.string().regex(ASSET_NAME).describe('The page refers to it as assets/<name>'),
      media_id: MediaId.describe('An imported image or font'),
    }),
  )
  .max(MOTION_LIMITS.maxAssets)
  .default([]);

export const CreateMotionInput = z.object({
  html: z
    .string()
    .min(1)
    .max(MOTION_LIMITS.maxHtmlBytes)
    .describe(
      'An animated HTML page or fragment laid out at width × height. Anything that animates in a browser renders frame-exactly: CSS animations and transitions, the Web Animations API, SVG, requestAnimationFrame and timers (canvas, WebGL), window.__seek(seconds) for hand-driven drawing. Libraries load from lib/: anime.umd.min.js, three.module.js, lottie.min.js, d3.min.js.',
    ),
  duration_seconds: z.number().positive().max(MOTION_LIMITS.maxSeconds),
  width: size(1920),
  height: size(1080),
  fps: z.number().positive().max(MOTION_LIMITS.maxFps).default(30),
  transparent: z
    .boolean()
    .default(true)
    .describe('Alpha (ProRes 4444) so it composites over video; false gives H.264'),
  assets: MotionAssets,
  ...createCommon,
});

export const CreateStillInput = z.object({
  html: z
    .string()
    .min(1)
    .max(MOTION_LIMITS.maxHtmlBytes)
    .describe('An HTML page or fragment, laid out at width × height'),
  width: size(1920),
  height: size(1080),
  transparent: z.boolean().default(true).describe('Unpainted areas stay transparent'),
  assets: MotionAssets,
  ...createCommon,
});

/** Kokoro's English voices, in speaker-id order: a = American, b = British; f/m = female/male. */
export const VOICES = [
  'af_alloy',
  'af_aoede',
  'af_bella',
  'af_heart',
  'af_jessica',
  'af_kore',
  'af_nicole',
  'af_nova',
  'af_river',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_echo',
  'am_eric',
  'am_fenrir',
  'am_liam',
  'am_michael',
  'am_onyx',
  'am_puck',
  'am_santa',
  'bf_alice',
  'bf_emma',
  'bf_isabella',
  'bf_lily',
  'bm_daniel',
  'bm_fable',
  'bm_george',
  'bm_lewis',
] as const;

export const CreateVoiceoverInput = z.object({
  text: z.string().trim().min(1).max(5000).describe('What to say, in English'),
  voice: z.enum(VOICES).default('af_heart').describe('a/b: American/British; f/m: female/male'),
  speed: z.number().min(0.5).max(2).default(1),
  words: z.boolean().default(true).describe('Time each word'),
  ...createCommon,
});

export const CreateCutoutInput = z.object({
  media_id: MediaId,
  subject: z
    .enum(['auto', 'people', 'any'])
    .default('auto')
    .describe(
      'people: MODNet, fast, for video of people; any: BiRefNet, any subject (products, animals, objects), about 1 s a frame and 3 GB of memory; auto: any for pictures, people for video',
    ),
  smooth: z.number().min(0).max(0.9).default(0.3).describe('Video: steadies the edge'),
  ...createCommon,
});

export const CreateStabilizedInput = z.object({
  media_id: MediaId.describe('Video to steady'),
  shakiness: z
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('How shaky the footage is: 1 a little, 10 a lot'),
  smoothing: z
    .int()
    .min(0)
    .max(500)
    .default(10)
    .describe(
      'Frames each side the camera path is smoothed over: more is steadier but follows intended moves (pans) more slowly',
    ),
  tripod: z
    .boolean()
    .default(false)
    .describe('Hold the picture still against its first frame, as if on a tripod'),
  edges: z
    .enum(['zoom', 'adaptive_zoom', 'black', 'keep'])
    .default('zoom')
    .describe(
      'What fills the edges steadying moves into view. zoom: one zoom for the whole video, enough to hide them; adaptive_zoom: as little zoom as each moment needs; black: no zoom, black edges; keep: no zoom, edges filled from earlier frames',
    ),
  ...createCommon,
});

export const CreateMatteInput = z
  .object({
    color: Colour.optional().describe('A solid colour'),
    gradient: z
      .object({
        from: Colour,
        to: Colour,
        angle: z.number().min(0).max(360).default(180).describe('Degrees; 180 runs top to bottom'),
        kind: z.enum(['linear', 'radial']).default('linear'),
      })
      .optional(),
    width: size(1920),
    height: size(1080),
    ...createCommon,
  })
  .refine((m) => Boolean(m.color) !== Boolean(m.gradient), {
    message: 'Give either color or gradient',
  });

// Jobs
export const JobStatus = z.enum(['working', 'completed', 'failed', 'cancelled']);

export const JobStarted = z.object({
  job_id: JobId,
  status: JobStatus,
  status_uri: z.string(),
  media_id: MediaId.optional(),
  hint: z.string(),
});

export const JobView = z.object({
  job_id: JobId,
  tool: z.string(),
  status: JobStatus,
  status_message: z
    .string()
    .optional()
    .describe(
      'What it is doing; while it waits, its place in the queue and what it waits for (a job slot, a render slot or the sandbox)',
    ),
  progress: z.number().min(0).max(1).optional(),
  created_at: z.string(),
  updated_at: z.string(),
  result: z.unknown().optional().describe("The tool's structured result once completed"),
  error: ToolError.optional(),
});
export const JobRef = z.object({ job_id: JobId });
/** Limits that protect the server: the most jobs one job.get reads. */
export const JOB_GET_LIMIT = 100;
export const JobGetInput = z.object({
  job_id: JobId.optional().describe('One job: the answer is that job'),
  job_ids: z
    .array(JobId)
    .min(1)
    .max(JOB_GET_LIMIT)
    .optional()
    .describe(`Many jobs at once (up to ${JOB_GET_LIMIT}): the answer is {jobs, not_found}`),
});
export const JobGetManyResult = z.object({
  jobs: z.array(JobView).describe('The jobs found, in the order asked'),
  not_found: z
    .array(z.string())
    .describe('Ids with no job of yours (finished jobs are kept 7 days)'),
});
export const JobGetResult = z.union([JobView, JobGetManyResult]);
export const JobListInput = z.object({
  status: JobStatus.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const JobListResult = z.object({ jobs: z.array(JobView) });

/** What a long-running tool answers while it works: poll job.get with job_id for the result. */
export const JobHandle = z.object({
  job_id: JobId,
  status: JobStatus,
  status_uri: z.string(),
  media_id: MediaId.optional().describe('The media it is making; usable in edits once processing'),
  hint: z.string(),
});

/**
 * A long-running tool's output: its result when it finishes in the call, or a JobHandle while it
 * works (job.get then gives the result).
 */
export function withJob<T extends z.ZodType>(result: T) {
  return z.union([result, JobHandle]);
}

// Render and export
export const RenderFramesInput = z
  .object({
    timeline_id: TimelineId.optional(),
    media_id: MediaId.optional(),
    frames: z
      .array(frame)
      .min(1)
      .max(16)
      .describe('Timeline frames, or media frames at the media rate'),
    layout: z.enum(['single', 'grid']).default('grid').describe('grid: one contact sheet'),
    long_edge: z.number().int().min(64).max(1920).default(640),
    size: z
      .enum(['preview', 'full'])
      .default('preview')
      .describe('full: the sequence size from original media (long_edge ignored)'),
    format: z
      .enum(['webp', 'png', 'jpeg'])
      .default('webp')
      .describe('jpeg: for places that take nothing else; png: lossless'),
    quality: z
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('WebP and JPEG, 1–100 (default 82 WebP, 85 JPEG)'),
  })
  .refine((v) => Boolean(v.timeline_id) !== Boolean(v.media_id), {
    message: 'Give exactly one of timeline_id or media_id',
  })
  .refine((v) => v.size !== 'full' || v.frames.length <= 4, {
    message: 'size full renders up to 4 frames at a time',
  });

export const RenderFramesResult = z.object({
  images: z.array(
    z.object({
      uri: z.string().describe('MCP resource for the image'),
      frames: z.array(frame),
      url: z.string().describe('Signed download of this image'),
      expires_at: z.string(),
      mime_type: z.string(),
      bytes: z.number(),
    }),
  ),
});

export const ExportPreset = z
  .enum([
    'web_1080p_h264',
    'master_prores_422hq',
    'social_9x16_h264',
    'web_1080p_av1',
    'gif',
    'review_h264',
    'audio_wav_48k',
    'audio_mp3',
  ])
  .describe('video://catalog/presets lists each with what it takes');

export const ExportOverrides = z
  .object({
    width: z.int().min(16).max(7680).optional(),
    height: z.int().min(16).max(7680).optional(),
    fps: z.number().positive().max(120).optional(),
    bitrate: z
      .string()
      .regex(/^\d+(\.\d+)?[kM]$/)
      .optional()
      .describe('Video bitrate like 8M, instead of constant quality'),
    crf: z.int().min(0).max(63).optional(),
  })
  .describe('Change the preset: a size box (aspect kept), frame rate, bitrate or quality');

export const ExportVideoInput = z.object({
  timeline_id: TimelineId,
  preset: ExportPreset,
  overrides: ExportOverrides.optional(),
  range: z.object({ start: frame, end: frame }).optional().describe('Frames, end exclusive'),
  filename: z
    .string()
    .regex(/^[\w][\w .-]{0,120}$/)
    .optional()
    .describe('Output file name without extension. Default: timeline name and id'),
  overwrite: z.boolean().default(false),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const ExportTimelineInput = z.object({
  timeline_id: TimelineId,
  format: z
    .enum(['fcpxml', 'otio', 'edl', 'srt', 'vtt'])
    .describe(
      'fcpxml: Final Cut Pro, Resolve; otio: Premiere, Resolve, any OTIO app; edl: CMX 3600; srt/vtt: captions',
    ),
  media: z
    .enum(['reference', 'collect'])
    .default('reference')
    .describe('reference: point at the media where it is; collect: a .zip with the media in it'),
  filename: z
    .string()
    .regex(/^[\w][\w .-]{0,120}$/)
    .optional()
    .describe('Output file name without extension. Default: timeline name and id'),
  overwrite: z.boolean().default(false),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const ExportTimelineResult = z.object({
  url: z.string().describe('Signed download URL'),
  expires_at: z.string(),
  uri: z.string().describe('MCP resource for the output'),
  file: z.string().optional().describe('Where it was written in the exports folder (local mode)'),
  bytes: z.number(),
  format: z.string(),
  mime_type: z.string(),
  media: z.number().describe('Media files referenced (or collected)'),
  warnings: z.array(z.string()).describe('What the format could not carry'),
});

export const ExportResult = z.object({
  url: z.string().describe('Signed download URL'),
  page_url: z
    .string()
    .describe(
      'A page that plays the file in any browser, with no sign-in: the link to give a person to watch or share it. Works until expires_at',
    ),
  expires_at: z.string(),
  uri: z.string().describe('MCP resource for the output'),
  file: z
    .string()
    .optional()
    .describe('Where the file was written in the exports folder (local mode)'),
  bytes: z.number(),
  frames: z.number(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  preset: ExportPreset,
  mime_type: z.string(),
});

export const QaCheckInput = z.object({
  timeline_id: TimelineId,
  range: z.object({ start: frame, end: frame }).optional(),
  black: z
    .object({
      pixel_threshold: z.number().min(0).max(1).describe('A pixel this dark or darker is black'),
      picture_share: z
        .number()
        .min(0)
        .max(1)
        .describe('A frame with this share of black pixels is black'),
      min_seconds: z.number().min(0.01).max(3600),
    })
    .optional()
    .describe('Find black stretches with these settings; left out, none are looked for'),
  silence: z
    .object({
      threshold_db: z.number().min(-100).max(0).describe('Quieter than this, dBFS'),
      min_seconds: z.number().min(0.01).max(3600),
    })
    .optional()
    .describe(
      'Find silent stretches in the mix with these settings; left out, none are looked for',
    ),
});

const QaSpan = z.object({ start: frame, end: frame });
export const QaCheckResult = z.object({
  range: QaSpan,
  gaps: z.array(QaSpan).describe('Frames with no picture on any visible video track'),
  offline_media: z.array(z.string()).describe('Media ids that are offline; nothing was rendered'),
  frames: z
    .object({ expected: z.number(), rendered: z.number() })
    .nullable()
    .describe('null when offline media stopped the render'),
  black: z.array(QaSpan).optional().describe('With black settings: black stretches, frames'),
  silences: z.array(QaSpan).optional().describe('With silence settings: silent stretches, frames'),
  integrated_lufs: z.number().nullable().describe('null below the EBU R128 -70 LUFS gate'),
  true_peak_dbtp: z.number().nullable(),
});
