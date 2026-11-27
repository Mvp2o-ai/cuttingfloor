import * as z from 'zod/v4';
import { MediaId, ScoreId } from './ids.ts';
import { AutomationCurve, AutomationTarget, PitchInput } from './score.ts';
import { FrameRate } from './sequence.ts';

// The score.* tools: what each takes and returns, the score view score.get gives and the
// document score.load takes. Every position a result gives is in beats, seconds and (when the
// score has fps) frames; every position an argument takes can be given in seconds instead.

/**
 * Limits that protect the platform (to size on the hosted machine). Nothing else is a number a
 * score tool holds; going over one is refused with the limit in the error.
 */
export const SCORE_LIMITS = {
  /** Parts in a score. */
  parts: 64,
  /** Devices on one part, and on the master. */
  devices: 16,
  /** Regions in a score, on all its parts. */
  regions: 2000,
  /** Notes in a score, in all its notes sources. */
  notes: 50_000,
  /** Notes one call adds, changes or removes. */
  notesPerCall: 2000,
  /** Markers in a score. */
  markers: 1000,
  /** Automation points in a score, on all its lanes. */
  automationPoints: 20_000,
  /** Sends in a score. */
  sends: 256,
  /** Tempo changes, and meter changes, in a score. */
  changes: 1000,
} as const;

/** The most bar starts one result lists; bars_total says how many there are. */
export const BARS_LISTED = 2000;

const n = (limit: number) => limit.toLocaleString('en-US');

const beats = z.number().finite();
const atBeats = z.number().finite().nonnegative();
const seconds = z.number().finite().nonnegative();
const lengthBeats = z.number().finite().positive();
const lengthSeconds = z.number().finite().positive();
const Bpm = z.number().min(20).max(400).describe('Beats per minute, 20 to 400, decimals allowed');
const Gain = z.number().min(-60).max(24);
const Pan = z.number().min(-1).max(1).describe('-1 left to 1 right');
const Velocity = z.number().int().min(1).max(127).describe('1 to 127: how hard it is struck');

export const ScoreMeter = z
  .object({
    beats: z.number().int().min(1).max(64).describe('Beats in a bar'),
    unit: z
      .union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32)])
      .describe('The note that is one beat: 4 a quarter, 8 an eighth'),
  })
  .describe(
    '{beats, unit}: beats in a bar and the note that is one beat, e.g. {beats: 4, unit: 4}',
  );

/** Where something sits in a score, every way a tool gives it. */
export const ScorePosition = z.object({
  beats: z.number().describe('Beats from the start (a quarter note is 1)'),
  seconds: z.number(),
  frames: z
    .number()
    .optional()
    .describe('At the score fps, exact (45.5 is half way through frame 45); absent without fps'),
});
export type ScorePosition = z.infer<typeof ScorePosition>;

const BarPosition = ScorePosition.extend({ bar: z.number().int().describe('From 1') });

const NoteInput = z.object({
  pitch: PitchInput.describe(
    'A MIDI number 0–127, decimals allowed (60.5 a quarter-tone above middle C), or a name such as C3 or F#4; C4 is 60, middle C',
  ),
  at_beats: beats.optional().describe("Start, in beats from the region's start"),
  at_seconds: seconds.optional().describe("Start, in seconds from the region's start"),
  length_beats: lengthBeats.optional(),
  length_seconds: lengthSeconds.optional(),
  velocity: Velocity,
});

/** A list capped by a platform limit, refused over it with the number. */
const capped = (limit: number, what: string) => ({
  message: `up to ${n(limit)} ${what} (a limit of the platform)`,
});

const notesPerCall = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .min(1)
    .max(SCORE_LIMITS.notesPerCall, {
      message: `up to ${n(SCORE_LIMITS.notesPerCall)} notes a call (a limit of the platform)`,
    });

const RegionId = z.string().describe('The region');
const PartId = z.string().describe('The part');

// Edit operations. Each tool takes `{score_id}` plus these args; score.batch takes the args
// alone, by tool name.
export const ScoreEditArgs = {
  'score.set_tempo': z.object({
    tempo: Bpm.optional().describe('One tempo for the whole score, in beats per minute'),
    changes: z
      .array(
        z.object({
          at_beats: atBeats.optional(),
          at_seconds: seconds
            .optional()
            .describe(
              'In place of at_beats: a time in the score as the changes before it in this list leave it',
            ),
          tempo: Bpm,
          ramp: z.boolean().optional().describe('true glides from the change before'),
        }),
      )
      .min(1)
      .max(SCORE_LIMITS.changes, capped(SCORE_LIMITS.changes, 'changes in a score'))
      .optional()
      .describe('[{at_beats, tempo, ramp}]: each replaces a change on its beat or adds one'),
  }),
  'score.set_meter': z.object({
    meter: ScoreMeter,
    from_bar: z.number().int().min(1).default(1).describe('The bar it starts at. Default 1'),
  }),
  'score.set_markers': z.object({
    markers: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          at_beats: atBeats.optional(),
          at_seconds: seconds.optional(),
        }),
      )
      .max(SCORE_LIMITS.markers, capped(SCORE_LIMITS.markers, 'markers in a score'))
      .describe('[{name, at_beats}] or [{name, at_seconds}]'),
  }),
  'score.add_part': z.object({
    name: z.string().min(1).max(200).optional().describe('A label'),
    gain_db: Gain.default(0).describe('Level. Default 0'),
    pan: Pan.default(0),
    output: z
      .string()
      .default('master')
      .describe(
        'Where it sounds: master (default) or a part_id, to group parts under one part’s effects and level',
      ),
  }),
  'score.set_part': z.object({
    part_id: PartId,
    gain_db: Gain.optional().describe('Level'),
    pan: Pan.optional(),
    mute: z.boolean().optional().describe('Silent in every render'),
    solo: z.boolean().optional().describe('Only solo parts sound'),
    name: z.string().min(1).max(200).optional().describe('A label'),
    output: z.string().optional().describe('master or a part_id'),
  }),
  'score.remove_part': z.object({ part_id: PartId }),
  'score.add_device': z.object({
    part_id: z.string().optional().describe('The part. One of part_id or master'),
    master: z.boolean().optional().describe('true puts an effect on the whole score'),
    name: z.string().describe('A device name from video://catalog/devices'),
    params: z
      .record(z.string(), z.unknown())
      .default({})
      .describe(
        "The device's params. For sampler: media_id, from_seconds, until_seconds, root_note (a pitch, as in notes), one_shot, or slices [{note, from_seconds, until_seconds}]",
      ),
    at_index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Position in the part's order. Default last (an instrument: after the part's other instruments)",
      ),
  }),
  'score.set_device': z.object({
    device_id: z.string().describe('The device'),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Params to change; others keep their values. A group or list given replaces it whole; null removes a param',
      ),
    enabled: z.boolean().optional().describe('false bypasses it'),
    at_index: z.number().int().nonnegative().optional().describe('Its new position in the order'),
  }),
  'score.remove_device': z.object({ device_id: z.string().describe('The device') }),
  'score.add_notes': z.object({
    region_id: z.string().describe('A notes region'),
    notes: notesPerCall(NoteInput).describe(
      '[{pitch, at_beats, length_beats, velocity}], or at_seconds and length_seconds for the two positions',
    ),
  }),
  'score.set_notes': z.object({
    notes: notesPerCall(
      z.object({
        note_id: z.string(),
        pitch: NoteInput.shape.pitch.optional(),
        at_beats: beats
          .optional()
          .describe('From the start of the region it sounds in, as score.get shows it'),
        at_seconds: seconds.optional(),
        length_beats: lengthBeats.optional(),
        length_seconds: lengthSeconds.optional(),
        velocity: Velocity.optional(),
      }),
    ).describe('[{note_id, pitch, at_beats, length_beats, velocity}]'),
  }),
  'score.remove_notes': z.object({
    note_ids: notesPerCall(z.string()).describe('The notes'),
  }),
  'score.add_region': z.object({
    part_id: PartId,
    at_beats: atBeats.optional().describe('Where it starts. One of at_beats or at_seconds'),
    at_seconds: seconds.optional().describe('Where it starts, in seconds'),
    length_beats: lengthBeats
      .optional()
      .describe(
        "Its length (or length_seconds). Required for a notes region; default for audio is the source's length",
      ),
    length_seconds: lengthSeconds.optional(),
    notes: notesPerCall(NoteInput)
      .optional()
      .describe('Notes to put in it now, as in score.add_notes'),
    media_id: MediaId.optional().describe('Audio media, for an audio region'),
    source: z
      .object({ from_seconds: seconds.optional(), until_seconds: seconds.optional() })
      .optional()
      .describe('{from_seconds, until_seconds} of the media. Default all of it'),
    fit_beats: lengthBeats
      .optional()
      .describe('Stretch the audio to this many beats, pitch unchanged'),
    gain_db: Gain.optional().describe('Level of an audio region. Default 0'),
  }),
  'score.move_region': z.object({
    region_id: RegionId,
    to_beats: atBeats.optional().describe('Its new start'),
    to_seconds: seconds.optional(),
    part_id: z.string().optional().describe('The part to move it to'),
  }),
  'score.trim_region': z.object({
    region_id: RegionId,
    edge: z.enum(['start', 'end']).describe('The edge to move'),
    to_beats: atBeats.optional().describe('Where it goes'),
    to_seconds: seconds.optional(),
  }),
  'score.split_region': z.object({
    region_id: RegionId,
    at_beats: atBeats.optional().describe("Where to cut, in the score's beats"),
    at_seconds: seconds.optional(),
  }),
  'score.alias_region': z.object({
    region_id: z.string().describe('The region to mirror'),
    at_beats: atBeats.optional().describe('Where the copy starts'),
    at_seconds: seconds.optional(),
    part_id: z.string().optional().describe('Another part to put it on. Default the same part'),
  }),
  'score.unique_region': z.object({ region_id: z.string().describe('The mirrored region') }),
  'score.remove_region': z.object({ region_id: RegionId }),
  'score.set_automation': z.object({
    target: AutomationTarget.describe(
      '{part_id, param: "gain_db"|"pan"} or {send_id, param: "level_db"} or {device_id, param}',
    ),
    points: z
      .array(
        z.object({
          at_beats: atBeats.optional(),
          at_seconds: seconds.optional(),
          value: z.number().finite(),
          curve: AutomationCurve.describe('The move from this point to the next'),
        }),
      )
      .max(
        SCORE_LIMITS.automationPoints,
        capped(SCORE_LIMITS.automationPoints, 'automation points in a score'),
      )
      .describe('[{at_beats, value, curve}]'),
    from_beats: atBeats.optional().describe('Start of the range replaced. Default 0'),
    from_seconds: seconds.optional(),
    until_beats: atBeats.optional().describe("End of the range replaced. Default the score's end"),
    until_seconds: seconds.optional(),
  }),
  'score.add_send': z.object({
    from_part_id: z.string().describe('The part sent from'),
    to_part_id: z.string().describe('The part that receives it'),
    level_db: Gain.describe('How much is sent'),
    before_gain: z
      .boolean()
      .default(false)
      .describe("true sends the sound before the part's own gain and pan. Default false"),
  }),
  'score.set_send': z.object({
    send_id: z.string().describe('The send'),
    level_db: Gain.optional().describe('How much is sent'),
    before_gain: z.boolean().optional().describe("Taken before the part's own gain and pan"),
  }),
  'score.remove_send': z.object({ send_id: z.string().describe('The send') }),
} as const;
export type ScoreEditTool = keyof typeof ScoreEditArgs;
export const SCORE_EDIT_TOOLS = Object.keys(ScoreEditArgs) as ScoreEditTool[];
export type ScoreEditArgsOf<T extends ScoreEditTool> = z.infer<(typeof ScoreEditArgs)[T]>;

export function scoreEditInput<T extends ScoreEditTool>(tool: T) {
  return ScoreEditArgs[tool].extend({ score_id: ScoreId.describe('The score to edit') });
}

// Results

export const ScoreChange = z.object({
  id: z.string(),
  type: z.enum([
    'name',
    'tempo',
    'meter',
    'markers',
    'part',
    'device',
    'send',
    'region',
    'note',
    'automation',
  ]),
  change: z.enum(['added', 'removed', 'modified']),
  part_id: z
    .string()
    .optional()
    .describe('The part a device, send or region is on (master for its devices)'),
  at: ScorePosition.optional().describe('Where an added or modified region now starts'),
  end: ScorePosition.optional().describe('Where it ends'),
});
export type ScoreChange = z.infer<typeof ScoreChange>;

export const ScoreEditResult = z.object({
  score_id: ScoreId.describe('The new version: edit this one next (older ids stay valid)'),
  parent: ScoreId.describe('The version this edit started from'),
  changed: z.array(ScoreChange).describe('What the edit added, removed or modified'),
  warnings: z.array(z.string()),
});
export type ScoreEditResult = z.infer<typeof ScoreEditResult>;

export const RegionPlace = z.object({
  region_id: z.string(),
  part_id: z.string(),
  at: ScorePosition.describe('Where it starts'),
  end: ScorePosition.describe('Where it ends'),
  length_beats: z.number(),
  length_seconds: z.number(),
});
export type RegionPlace = z.infer<typeof RegionPlace>;

export const ScoreMarkerView = z.object({
  marker_id: z.string(),
  name: z.string(),
  given: z
    .enum(['beats', 'seconds'])
    .describe(
      'How it was given: in seconds it keeps its time when the tempo changes, in beats its beat',
    ),
  at: ScorePosition,
});
export type ScoreMarkerView = z.infer<typeof ScoreMarkerView>;

const Bars = {
  bars: z.array(BarPosition).describe('Where each bar starts, up to the end of the score'),
  bars_total: z
    .number()
    .int()
    .describe(`How many bars there are (up to ${n(BARS_LISTED)} are listed)`),
};

export const ScoreEditResults = {
  'score.set_tempo': ScoreEditResult.extend({
    length: ScorePosition.describe('The end of the score: where its last region ends'),
    ...Bars,
  }),
  'score.set_meter': ScoreEditResult.extend(Bars),
  'score.set_markers': ScoreEditResult.extend({ markers: z.array(ScoreMarkerView) }),
  'score.add_part': ScoreEditResult.extend({ part_id: z.string() }),
  'score.set_part': ScoreEditResult,
  'score.remove_part': ScoreEditResult,
  'score.add_device': ScoreEditResult.extend({ device_id: z.string() }),
  'score.set_device': ScoreEditResult,
  'score.remove_device': ScoreEditResult,
  'score.add_notes': ScoreEditResult.extend({
    note_ids: z.array(z.string()).describe('In the order the notes were given'),
  }),
  'score.set_notes': ScoreEditResult,
  'score.remove_notes': ScoreEditResult,
  'score.add_region': ScoreEditResult.extend({
    region_id: z.string(),
    region: RegionPlace,
    note_ids: z.array(z.string()).optional().describe('Notes passed with it, in the order given'),
  }),
  'score.move_region': ScoreEditResult.extend({ region: RegionPlace }),
  'score.trim_region': ScoreEditResult.extend({ region: RegionPlace }),
  'score.split_region': ScoreEditResult.extend({
    region_id: z.string().describe('The new right piece'),
    left: RegionPlace,
    right: RegionPlace,
  }),
  'score.alias_region': ScoreEditResult.extend({ region_id: z.string(), region: RegionPlace }),
  'score.unique_region': ScoreEditResult.extend({
    note_ids: z.array(z.string()).describe("The region's own notes, now with ids of their own"),
    copied_from: z
      .array(z.string())
      .describe('The mirrored note each one copies, in the same order'),
  }),
  'score.remove_region': ScoreEditResult,
  'score.set_automation': ScoreEditResult,
  'score.add_send': ScoreEditResult.extend({ send_id: z.string() }),
  'score.set_send': ScoreEditResult,
  'score.remove_send': ScoreEditResult,
} satisfies Record<ScoreEditTool, z.ZodType>;

export const ScoreBatchInput = z.object({
  score_id: ScoreId.describe('The score to edit'),
  ops: z
    .array(
      z.object({
        tool: z.enum(SCORE_EDIT_TOOLS as [ScoreEditTool, ...ScoreEditTool[]]),
        args: z.record(z.string(), z.unknown()).describe('The tool’s arguments without score_id'),
      }),
    )
    .min(1)
    .max(200)
    .describe(
      'Score edits applied in order as one change. An arg may be {"$ref":"ops[2].region_id"} (or part_id, device_id, send_id, note_ids[M]) to use an id made by an earlier op',
    ),
});

export const ScoreBatchResult = ScoreEditResult.extend({
  results: z.array(
    z.object({
      tool: z.string(),
      part_id: z.string().optional(),
      device_id: z.string().optional(),
      region_id: z.string().optional(),
      send_id: z.string().optional(),
      note_ids: z.array(z.string()).optional(),
    }),
  ),
});

export const ScoreCreateInput = z.object({
  tempo: Bpm,
  meter: ScoreMeter,
  sample_rate: z
    .union([z.literal(44_100), z.literal(48_000)])
    .describe('44100 or 48000: of the audio it renders'),
  fps: FrameRate.optional().describe(
    "{num, den}: a timeline's frame rate. With it, every position also comes back in frames",
  ),
  name: z.string().min(1).max(200).default('Untitled').describe('A label'),
});
export const ScoreIdResult = z.object({ score_id: ScoreId });

export const SCORE_INCLUDES = [
  'parts',
  'devices',
  'regions',
  'notes',
  'automation',
  'markers',
] as const;
export const ScoreGetInput = z.object({
  score_id: ScoreId.describe('The score'),
  include: z.array(z.enum(SCORE_INCLUDES)).optional().describe('What to return. Default all'),
});

export const ScoreDeviceView = z.object({
  device_id: z.string(),
  name: z.string(),
  kind: z.enum(['instrument', 'effect']),
  enabled: z.boolean(),
  params: z.record(z.string(), z.unknown()).describe('As given'),
  applied: z.record(z.string(), z.unknown()).describe('Every param it applies, defaults filled in'),
  pitches: z
    .array(z.object({ pitch: z.number(), name: z.string(), plays: z.string() }))
    .optional()
    .describe('A drum kit or a sliced sampler: which pitch plays what; any other pitch is silent'),
});

export const ScoreNoteView = z.object({
  note_id: z.string(),
  pitch: z.number(),
  name: z.string().describe('The nearest note name (C4 is 60)'),
  cents: z.number().describe('How far the pitch is off that name'),
  at_beats: z.number().describe("From the region's start"),
  length_beats: z.number(),
  length_seconds: z.number(),
  velocity: z.number().int(),
  sounds: z
    .boolean()
    .describe('false: it starts outside the region’s edges, so it is stored but silent here'),
  at: ScorePosition.describe('Where it starts in the score'),
});

const regionCommon = {
  region_id: z.string(),
  at: ScorePosition,
  end: ScorePosition,
  length_beats: z.number(),
  length_seconds: z.number(),
};

export const ScoreRegionView = z.discriminatedUnion('type', [
  z.object({
    ...regionCommon,
    type: z.literal('notes'),
    offset_beats: z
      .number()
      .describe('Beats of its notes before the region’s start (moved by trimming or splitting)'),
    mirrors: z
      .array(z.string())
      .describe('Regions that share its notes (score.alias_region, or pieces of one split)'),
    notes: z.array(ScoreNoteView).optional(),
  }),
  z.object({
    ...regionCommon,
    type: z.literal('audio'),
    media_id: z.string(),
    source: z.object({ from_seconds: z.number(), until_seconds: z.number() }),
    fit_beats: z.number().optional(),
    gain_db: z.number(),
  }),
]);

export const ScorePartView = z.object({
  part_id: z.string(),
  name: z.string(),
  gain_db: z.number(),
  pan: z.number(),
  mute: z.boolean(),
  solo: z.boolean(),
  output: z.string().describe('master or a part_id'),
  sends: z.array(
    z.object({
      send_id: z.string(),
      to_part_id: z.string(),
      level_db: z.number(),
      before_gain: z.boolean(),
    }),
  ),
  devices: z.array(ScoreDeviceView).optional().describe('In the order they sound'),
  regions: z.array(ScoreRegionView).optional(),
});

export const ScoreView = z.object({
  score_id: ScoreId,
  parent: ScoreId.nullable(),
  format: z.literal('cuttingfloor.score'),
  version: z.literal(1),
  name: z.string(),
  sample_rate: z.number(),
  fps: z.object({ num: z.number(), den: z.number() }).optional(),
  length: ScorePosition.describe('The end of the score: where its last region ends'),
  tempo: z.array(z.object({ at: ScorePosition, tempo: z.number(), ramp: z.boolean() })),
  meter: z.array(
    z.object({
      bar: z.number().int(),
      beats: z.number().int(),
      unit: z.number().int(),
      at: ScorePosition,
    }),
  ),
  markers: z.array(ScoreMarkerView).optional(),
  parts: z.array(ScorePartView).optional(),
  master: z.object({ devices: z.array(ScoreDeviceView) }).optional(),
  automation: z
    .array(
      z.object({
        target: AutomationTarget,
        points: z.array(z.object({ at: ScorePosition, value: z.number(), curve: AutomationCurve })),
      }),
    )
    .optional(),
  media: z
    .record(z.string(), z.object({ name: z.string(), duration_seconds: z.number() }))
    .describe('Media its samplers and audio regions use'),
});
export type ScoreView = z.infer<typeof ScoreView>;

// What score.load takes: the score.get document. Only what rebuilds the score is read; the
// derived fields (seconds, frames, applied params, names) are ignored.
const AtIn = z.object({ beats: z.number().finite() });
const LoadDevice = z.object({
  device_id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()),
});
export const ScoreLoadDoc = z.object({
  name: z.string().min(1).max(200),
  sample_rate: z.union([z.literal(44_100), z.literal(48_000)]),
  fps: FrameRate.optional(),
  tempo: z
    .array(z.object({ at: AtIn, tempo: Bpm, ramp: z.boolean().optional() }))
    .min(1)
    .max(SCORE_LIMITS.changes, capped(SCORE_LIMITS.changes, 'changes in a score')),
  meter: z
    .array(ScoreMeter.extend({ bar: z.number().int().min(1) }))
    .min(1)
    .max(SCORE_LIMITS.changes, capped(SCORE_LIMITS.changes, 'changes in a score')),
  markers: z
    .array(
      z.object({
        marker_id: z.string(),
        name: z.string().min(1).max(200),
        given: z.enum(['beats', 'seconds']),
        at: z.object({ beats: z.number().finite(), seconds: z.number().finite() }),
      }),
    )
    .optional(),
  parts: z
    .array(
      z.object({
        part_id: z.string(),
        name: z.string(),
        gain_db: Gain,
        pan: Pan,
        mute: z.boolean(),
        solo: z.boolean(),
        output: z.string(),
        sends: z.array(
          z.object({
            send_id: z.string(),
            to_part_id: z.string(),
            level_db: Gain,
            before_gain: z.boolean(),
          }),
        ),
        devices: z.array(LoadDevice).optional(),
        regions: z
          .array(
            z.discriminatedUnion('type', [
              z.object({
                region_id: z.string(),
                type: z.literal('notes'),
                at: AtIn,
                length_beats: lengthBeats,
                offset_beats: beats,
                mirrors: z.array(z.string()),
                notes: z
                  .array(
                    z.object({
                      note_id: z.string(),
                      pitch: z.number().min(0).max(127),
                      at_beats: beats,
                      length_beats: lengthBeats,
                      velocity: Velocity,
                    }),
                  )
                  .optional(),
              }),
              z.object({
                region_id: z.string(),
                type: z.literal('audio'),
                at: AtIn,
                media_id: MediaId,
                source: z.object({ from_seconds: seconds, until_seconds: seconds }),
                fit_beats: lengthBeats.optional(),
                gain_db: Gain,
              }),
            ]),
          )
          .optional(),
      }),
    )
    .optional(),
  master: z.object({ devices: z.array(LoadDevice) }).optional(),
  automation: z
    .array(
      z.object({
        target: AutomationTarget,
        points: z.array(z.object({ at: AtIn, value: z.number().finite(), curve: AutomationCurve })),
      }),
    )
    .optional(),
});
export type ScoreLoadDoc = z.infer<typeof ScoreLoadDoc>;
export const ScoreLoadInput = z.object({
  score: ScoreLoadDoc.describe('The document from score.get'),
});

export const ScoreHistoryInput = z.object({
  score_id: ScoreId.describe('The score'),
  limit: z.number().int().min(1).max(500).default(50).describe('How many edits back'),
});
export const ScoreHistoryResult = z.object({
  entries: z.array(
    z.object({
      score_id: ScoreId,
      parent: ScoreId.nullable(),
      tool: z.string().nullable(),
      args: z.unknown(),
      available: z.boolean().describe('false once the stored score has expired'),
    }),
  ),
  truncated: z.boolean(),
});
export const ScoreDiffInput = z.object({
  from: ScoreId.describe('A score_id'),
  to: ScoreId.describe('A score_id'),
});
export const ScoreDiffResult = z.object({ changed: z.array(ScoreChange) });

type Shape = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: Shape[];
  oneOf?: Shape[];
  properties?: Record<string, Shape>;
  required?: string[];
  items?: Shape;
};
const shapes = new Map<string, string>();

/** A score op's arguments in brief, from its own schema, as a refused batch op names them. */
export function scoreArgsShape(tool: ScoreEditTool): string {
  let shape = shapes.get(tool);
  if (!shape) {
    const full = brief(
      z.toJSONSchema(ScoreEditArgs[tool], { io: 'input', unrepresentable: 'any' }) as Shape,
      0,
    );
    shape = full.length > 900 ? `${full.slice(0, 900)}…` : full;
    shapes.set(tool, shape);
  }
  return shape;
}

function brief(s: Shape, depth: number): string {
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join('|');
  const variants = s.anyOf ?? s.oneOf;
  if (variants) return variants.map((v) => brief(v, depth)).join(' | ');
  if (s.type === 'array') return `${s.items ? brief(s.items, depth + 1) : 'any'}[]`;
  if (s.properties) {
    if (depth > 2) return 'object';
    const required = new Set(s.required ?? []);
    const fields = Object.entries(s.properties).map(
      ([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${brief(v, depth + 1)}`,
    );
    return `{${fields.join(', ')}}`;
  }
  return Array.isArray(s.type) ? s.type.join('|') : (s.type ?? 'any');
}
