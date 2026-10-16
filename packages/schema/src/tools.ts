import * as z from 'zod/v4';
import {
  animatable,
  BlendMode,
  Crop,
  Fit,
  Flip,
  InOutAnimation,
  LoopAnimation,
  MASK_LIMITS,
  MaskShape,
  TRANSFORM_LIMITS,
} from './compositing.ts';
import { ToolError } from './errors.ts';
import { JobId, MediaId, TimelineId } from './ids.ts';
import { Sequence } from './sequence.ts';
import { Change, TimelineInput, TimelineView, TrackKind } from './timeline.ts';

const frame = z.number().int().nonnegative();

export const Preview = z
  .enum(['inline', 'link', 'none'])
  .default('link')
  .describe(
    'inline: the result image in this response; link: a resource URI that renders on read; none: no preview',
  );

const Mode = z
  .enum(['overwrite', 'insert'])
  .default('overwrite')
  .describe('overwrite replaces what is underneath; insert pushes later clips right');

const anim = (limits: readonly [number, number], text: string) =>
  animatable(limits[0], limits[1]).optional().describe(text);

export const TransformArgs = z.object({
  x: anim(TRANSFORM_LIMITS.x, 'Centre x, 0 = left edge, 1 = right edge (default 0.5)'),
  y: anim(TRANSFORM_LIMITS.y, 'Centre y, 0 = top, 1 = bottom (default 0.5)'),
  scale: anim(TRANSFORM_LIMITS.scale, 'Size relative to the fit (default 1)'),
  scale_x: anim(TRANSFORM_LIMITS.scale_x, 'Extra horizontal stretch (default 1)'),
  scale_y: anim(TRANSFORM_LIMITS.scale_y, 'Extra vertical stretch (default 1)'),
  rotation: anim(TRANSFORM_LIMITS.rotation, 'Degrees clockwise (default 0)'),
  opacity: anim(TRANSFORM_LIMITS.opacity, '0 to 1 (default 1)'),
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
    media_id: MediaId,
    at_frame: frame.optional().describe('Where the clip starts. Default: after the last clip'),
    after_clip_id: z
      .string()
      .optional()
      .describe('Start where this clip ends (instead of at_frame)'),
    source: z
      .object({ in: frame, out: frame })
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
  }),
  'clip.remove': z.object({
    clip_id: z.string(),
    ripple: z.boolean().default(false).describe('Close the gap by pulling later clips left'),
  }),
  'clip.move': z.object({
    clip_id: z.string(),
    to_frame: frame,
    to_track_id: z.string().optional(),
    mode: Mode,
    ripple: z.boolean().default(false).describe('Close the gap left behind'),
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
  }),
  'clip.split': z.object({ clip_id: z.string(), at_frame: frame }),
  'clip.link': z.object({ clip_ids: z.array(z.string()).min(2) }),
  'clip.unlink': z.object({ clip_id: z.string() }),
  'clip.set_enabled': z.object({ clip_id: z.string(), enabled: z.boolean() }),
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
  frames: z.array(frame),
  status: z.enum(['ready', 'pending']),
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
export const MediaSource = z.union([
  z.object({
    path: z
      .string()
      .min(1)
      .describe('A file under a media root, e.g. /media/videos/clip.mp4 (local mode)'),
  }),
  z.object({ url: z.url().describe('An http(s) URL to download') }),
]);

export const MediaImportInput = z.object({
  source: MediaSource,
  name: z.string().min(1).max(200).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const MediaStatus = z.enum(['importing', 'processing', 'ready', 'failed']);

export const MediaInfo = z.object({
  media_id: MediaId,
  name: z.string(),
  status: MediaStatus.describe(
    'importing: not probed yet; processing: usable in edits, proxy still rendering; ready; failed',
  ),
  kind: z.enum(['video', 'audio', 'image']).nullable(),
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
    .object({
      scenes: z.array(z.number()).describe('Scene cut times, seconds'),
      loudness_lufs: z.number().nullable(),
      silences: z.array(z.object({ start: z.number(), end: z.number() })),
    })
    .nullable(),
  error: ToolError.optional(),
});
export type MediaInfo = z.infer<typeof MediaInfo>;

export const MediaRefInput = z.object({ media_id: MediaId });

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
  status_message: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  created_at: z.string(),
  updated_at: z.string(),
  result: z.unknown().optional().describe("The tool's structured result once completed"),
  error: ToolError.optional(),
});
export const JobRef = z.object({ job_id: JobId });
export const JobListInput = z.object({
  status: JobStatus.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export const JobListResult = z.object({ jobs: z.array(JobView) });

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
    format: z.enum(['webp', 'png']).default('webp'),
  })
  .refine((v) => Boolean(v.timeline_id) !== Boolean(v.media_id), {
    message: 'Give exactly one of timeline_id or media_id',
  });

export const RenderFramesResult = z.object({
  images: z.array(z.object({ uri: z.string(), frames: z.array(frame) })),
});

export const ExportPreset = z.enum(['web_1080p_h264', 'master_prores_422hq']);

export const ExportVideoInput = z.object({
  timeline_id: TimelineId,
  preset: ExportPreset,
  range: z.object({ start: frame, end: frame }).optional().describe('Frames, end exclusive'),
  filename: z
    .string()
    .regex(/^[\w][\w .-]{0,120}$/)
    .optional()
    .describe('Output file name without extension. Default: timeline name and id'),
  overwrite: z.boolean().default(false),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const ExportResult = z.object({
  url: z.string().describe('Signed download URL'),
  expires_at: z.string(),
  uri: z.string().describe('MCP resource for the output'),
  file: z
    .string()
    .optional()
    .describe('Where the file was written in the exports folder (local mode)'),
  bytes: z.number(),
  frames: z.number(),
  preset: ExportPreset,
  mime_type: z.string(),
});

export const QaCheckInput = z.object({
  timeline_id: TimelineId,
  range: z.object({ start: frame, end: frame }).optional(),
  loudness_target_lufs: z.number().min(-40).max(-5).default(-14),
});

export const QaFinding = z.object({ start: frame, end: frame, detail: z.string() });
export const QaCheckResult = z.object({
  passed: z.boolean(),
  checks: z.array(
    z.object({
      check: z.enum([
        'gaps',
        'offline_media',
        'black_frames',
        'silence',
        'loudness',
        'frame_count',
      ]),
      status: z.enum(['pass', 'fail', 'warn']),
      findings: z.array(QaFinding),
    }),
  ),
  measured: z.object({
    frames: z.number(),
    integrated_lufs: z.number().nullable(),
    true_peak_dbtp: z.number().nullable(),
  }),
});
