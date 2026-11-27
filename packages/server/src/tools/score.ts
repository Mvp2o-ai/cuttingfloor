import {
  barsOf,
  fromScoreView,
  markerView,
  newScore,
  positionAt,
  regionPlace,
  runScoreEdits,
  type ScoreBatchOp,
  type ScoreMediaResolver,
  type ScoreOutcome,
  scoreDiff,
  scoreEnd,
  ticksToSeconds,
  toScoreView,
} from '@cuttingfloor/core';
import {
  deviceRosterText,
  KEEP_MS,
  SCORE_EDIT_TOOLS,
  ScoreBatchInput,
  ScoreBatchResult,
  ScoreCreateInput,
  ScoreDiffInput,
  ScoreDiffResult,
  type ScoreDoc,
  ScoreEditResults,
  type ScoreEditTool,
  ScoreGetInput,
  ScoreHistoryInput,
  ScoreHistoryResult,
  ScoreIdResult,
  ScoreLoadInput,
  ScoreView,
  scoreEditInput,
  span,
} from '@cuttingfloor/schema';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { mediaIdsIn, mediaResolver } from '../render.ts';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

// The score.* tools: a score is music made in layers, its own immutable document beside the
// timeline. Each edit is a granular primitive (core/score/edit.ts) that does what its arguments
// say; results give every position in beats, seconds and, with fps, frames.

const KEEP = span(KEEP_MS.score);

const EDIT_DESCRIPTIONS: Record<ScoreEditTool, { title: string; description: string }> = {
  'score.set_tempo': {
    title: 'Set score tempo',
    description:
      "The tempo of a score in beats per minute: one value for all of it (tempo), or changes at beats (changes; one or the other). A change at beat 0 sets the opening tempo; ramp true glides from the change before and arrives at this one's tempo on its beat. A stretch of n beats at tempo T lasts 60 × n / T seconds, so a change of tempo can put any moment of the picture exactly on a beat. Notes and notes regions keep their beats, so their times in seconds move; audio regions keep their length in seconds unless they were placed with fit_beats. Returns the new score_id (edit that one next), the score's length, and where each bar now starts in seconds and frames.",
  },
  'score.set_meter': {
    title: 'Set score meter',
    description:
      'Beats in a bar and the note that is one beat, from a bar on. Notes keep their beats; the bar lines move. Returns the new score_id (edit that one next) and where each bar starts.',
  },
  'score.set_markers': {
    title: 'Set score markers',
    description:
      'Name points in a score: where the picture cuts, a moment the music should hit, a section’s start. Each marker is given at a beat or at a time in seconds, and comes back with both, and its frame: the way to learn which beat a moment of the picture falls on. When the tempo changes, a marker given in seconds keeps its time and one given in beats keeps its beat. Markers change no sound. Replaces the list. Returns the new score_id (edit that one next) and the markers.',
  },
  'score.add_part': {
    title: 'Add part',
    description:
      'Add a layer to a score: one voice of the music (a drum kit, a bass, a pad, a recorded sound) with its own instrument, effects, level and regions. Silent until it has a region: notes need an instrument on the part; an audio region sounds on its own. Returns the new score_id (edit that one next) and the part_id.',
  },
  'score.set_part': {
    title: 'Set part',
    description:
      "A part's level, pan, mute, solo, name or output. Returns the new score_id (edit that one next).",
  },
  'score.remove_part': {
    title: 'Remove part',
    description:
      'Remove a part with its devices, regions and sends. Returns the new score_id (edit that one next).',
  },
  'score.add_device': {
    title: 'Add device',
    description: `Put an instrument or an effect on a part of a score, or an effect on the whole score (master). A part sounds through its devices in order: its instruments first, every one of them playing every note of the part (two or more sound together as one layered sound), then its effects in the order added. ${deviceRosterText()}. sampler plays any media (media_id), or a time range of it, at each note's pitch, from its start for the note's length, then release_ms; one_shot plays it to its end whatever the length; root_note is the pitch that plays it unchanged; with slices, each pitch plays its own range of the media, as a drum kit does, and a pitch with no slice is silent. synth is oscillators, a filter and envelopes. A wrong name or param is refused with the full list, ranges, units and defaults (also at video://catalog/devices); score.get shows every param applied. Returns the new score_id (edit that one next) and the device_id.`,
  },
  'score.set_device': {
    title: 'Set device',
    description:
      "Change a device's params, turn it off or on, or move it in its part's order. Returns the new score_id (edit that one next).",
  },
  'score.remove_device': {
    title: 'Remove device',
    description:
      'Take a device off a part or the master. Returns the new score_id (edit that one next).',
  },
  'score.add_notes': {
    title: 'Add notes',
    description:
      'Add notes to a region of a score, up to 2,000 a call. Each note: pitch (a MIDI number 0–127, decimals allowed: 60.5 is a quarter-tone above middle C; or a name such as C3 or F#4; C4 is 60, middle C), at_beats (from the region’s start), length_beats and velocity (1–127, how hard it is struck). On a drum kit or a sliced sampler a pitch selects a sound, not a height (score.get lists which pitch plays what). at_seconds and length_seconds may be given in place of the beats, which puts a note on an exact moment, on the grid or off it. Exactly what is passed is stored: nothing is moved to a grid or a scale. Returns the new score_id (edit that one next) and note_ids in the order given.',
  },
  'score.set_notes': {
    title: 'Set notes',
    description:
      'Change notes of a score by id, up to 2,000 a call: pitch, at_beats, length_beats, velocity. Fields left out keep their values. Returns the new score_id (edit that one next).',
  },
  'score.remove_notes': {
    title: 'Remove notes',
    description:
      'Remove notes from a score by id, up to 2,000 a call. Returns the new score_id (edit that one next).',
  },
  'score.add_region': {
    title: 'Add region',
    description:
      'Place a stretch of music on a part: a notes region (empty for score.add_notes, or with notes passed now) or an audio region (media, or a source range of it: a loop, a recording, a stem). at_beats and length_beats place it (or at_seconds and length_seconds). Audio keeps its own speed unless fit_beats is given, which stretches it to that many beats without changing its pitch. Regions on one part may overlap and sound together. Returns the new score_id (edit that one next), the region_id, and where it sits in beats, seconds and frames.',
  },
  'score.move_region': {
    title: 'Move region',
    description:
      'Move a region to another beat, another part, or both. Returns the new score_id (edit that one next) and where it now sits in beats, seconds and frames.',
  },
  'score.trim_region': {
    title: 'Trim region',
    description:
      'Move the start or end edge of a region. No note is changed: one that starts outside the new edges stays stored but silent, one that starts inside sounds at its full length; an audio region shows more or less of its source. Returns the new score_id (edit that one next) and where it now sits.',
  },
  'score.split_region': {
    title: 'Split region',
    description:
      'Cut a region in two at a beat. The left piece keeps its id; region_id is the new right piece. No note is changed: each stays in the piece it starts in, at its full length. Returns the new score_id (edit that one next) and both pieces’ positions.',
  },
  'score.alias_region': {
    title: 'Mirror region',
    description:
      'Place a copy of a region that stays identical to it: notes added, changed or removed in either are added, changed or removed in both. For a pattern or a section that comes back. score.unique_region frees a copy. Returns the new score_id (edit that one next) and the new region_id.',
  },
  'score.unique_region': {
    title: 'Unmirror region',
    description:
      'Free a mirrored region (from score.alias_region) so it can differ: it keeps its notes as its own copy. Returns the new score_id (edit that one next).',
  },
  'score.remove_region': {
    title: 'Remove region',
    description:
      'Remove a region from a score. Its mirrored copies stay. Returns the new score_id (edit that one next).',
  },
  'score.set_automation': {
    title: 'Set automation',
    description:
      "Make a level or a param of a score move over time: a part's gain or pan, a send's level, or any device param (a nested one by its path: filter.cutoff_hz, bands[0].gain_db), as points {at_beats, value} with a curve to the next point (hold, linear or smooth). Replaces that param's points between from_beats and until_beats; an empty list clears them. Returns the new score_id (edit that one next).",
  },
  'score.add_send': {
    title: 'Add send',
    description:
      "Send a share of a part's sound to another part as well as its own output, at a level in dB: several parts into one shared reverb, or a parallel effect. Returns the new score_id (edit that one next) and the send_id.",
  },
  'score.set_send': {
    title: 'Set send',
    description:
      "The level of a send, or whether it is taken before the part's gain. Returns the new score_id (edit that one next).",
  },
  'score.remove_send': {
    title: 'Remove send',
    description: 'Remove a send between two parts. Returns the new score_id (edit that one next).',
  },
};

/** This owner's media a score names, as the score needs it: seconds of sound, and whether it has any. */
async function scoreMedia(
  rt: ServerDeps['runtime'],
  owner: string,
  ids: string[],
): Promise<ScoreMediaResolver> {
  const refs = await mediaResolver(rt, owner, ids);
  return (id) => {
    const r = refs.get(id);
    if (!r) return undefined;
    const ticks = r.sound ?? r.duration ?? 0;
    return { name: r.name, duration: ticksToSeconds(ticks), audio: r.audio };
  };
}

/** What a tool's result adds to the common edit result, from the new document. */
function extraFor(tool: ScoreEditTool, doc: ScoreDoc, o: ScoreOutcome): Record<string, unknown> {
  const region = () => regionPlace(doc, o.region_id as string);
  switch (tool) {
    case 'score.set_tempo':
      return { length: positionAt(doc, scoreEnd(doc)), ...barsOf(doc) };
    case 'score.set_meter':
      return barsOf(doc);
    case 'score.set_markers':
      return { markers: doc.markers.map((m) => markerView(doc, m)) };
    case 'score.add_part':
      return { part_id: o.part_id };
    case 'score.add_device':
      return { device_id: o.device_id };
    case 'score.add_notes':
      return { note_ids: o.note_ids };
    case 'score.add_region':
      return {
        region_id: o.region_id,
        region: region(),
        ...(o.note_ids ? { note_ids: o.note_ids } : {}),
      };
    case 'score.move_region':
    case 'score.trim_region':
      return { region: region() };
    case 'score.split_region':
      return {
        region_id: o.region_id,
        left: regionPlace(doc, o.left_id as string),
        right: region(),
      };
    case 'score.alias_region':
      return { region_id: o.region_id, region: region() };
    case 'score.unique_region':
      return { note_ids: o.note_ids, copied_from: o.copied_from };
    case 'score.add_send':
      return { send_id: o.send_id };
    default:
      return {};
  }
}

async function applyAndReply(
  deps: ServerDeps,
  baseId: string,
  ops: ScoreBatchOp[],
  record: { tool: string; args: unknown },
  batch: boolean,
): Promise<CallToolResult> {
  const rt = deps.runtime;
  const owner = deps.owner();
  const base = await rt.scores.get(owner, baseId);
  const media = await scoreMedia(rt, owner, mediaIdsIn(ops));
  const { doc, outcome, results } = runScoreEdits(base, baseId, ops, media, record);
  const id = await rt.scores.put(owner, doc);
  const common = {
    score_id: id,
    parent: baseId,
    changed: scoreDiff(base, doc),
    warnings: outcome.warnings,
  };
  const only = ops[0];
  return ok(
    batch || !only ? { ...common, results } : { ...common, ...extraFor(only.tool, doc, outcome) },
  );
}

export function registerScoreTools(server: McpServer, deps: ServerDeps): void {
  const { runtime: rt } = deps;
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const readOnly = { ...annotations, readOnlyHint: true };

  server.registerTool(
    'score.create',
    {
      title: 'Create score',
      description: `Start an empty score: music made in layers and rendered to audio media for a timeline. A score is its own document beside the timeline: parts (layers), each with devices (instruments, then effects) and regions (stretches of notes or audio) on a grid of beats. tempo, meter and sample_rate are required; nothing is assumed. Positions are beats from 0 (a quarter note is 1; decimals allowed); results give each one in seconds too, and in frames when fps is given, and any position argument can be given in seconds instead (at_seconds for at_beats, and so on). Scores are immutable: every edit returns a new score_id, and older ids stay valid for ${KEEP} after last use. For work longer than that, keep the score.get document on your side and restore it with score.load. Returns the score_id.`,
      inputSchema: ScoreCreateInput,
      outputSchema: ScoreIdResult,
      annotations: { ...annotations, title: 'Create score' },
    },
    guard(async (args) => {
      const doc = newScore(args);
      doc.op = { tool: 'score.create', args };
      return ok({ score_id: await rt.scores.put(deps.owner(), doc) });
    }),
  );

  server.registerTool(
    'score.get',
    {
      title: 'Get score',
      description: `The full score: tempo and meter with their changes, markers, parts, each part's devices with every param, sends, regions and their notes, and automation, each position in beats, seconds and frames. include narrows what comes back; left out, everything. The server keeps a score ${KEEP} after last use: for work longer than that, save this document on your side (it is the music) and restore it with score.load.`,
      inputSchema: ScoreGetInput,
      outputSchema: ScoreView,
      annotations: { ...readOnly, title: 'Get score' },
    },
    guard(async (args) =>
      ok(
        toScoreView(args.score_id, await rt.scores.get(deps.owner(), args.score_id), args.include),
      ),
    ),
  );

  server.registerTool(
    'score.load',
    {
      title: 'Load score',
      description: `Restore a score from the document score.get returned, e.g. after it expired (${KEEP} after last use). Media its samplers and audio regions use must still be here.`,
      inputSchema: ScoreLoadInput,
      outputSchema: ScoreIdResult,
      annotations: { ...annotations, title: 'Load score' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const media = await scoreMedia(rt, owner, mediaIdsIn(args.score));
      const doc = fromScoreView(args.score, media);
      doc.op = { tool: 'score.load', args: null };
      return ok({ score_id: await rt.scores.put(owner, doc) });
    }),
  );

  server.registerTool(
    'score.history',
    {
      title: 'Score history',
      description:
        'The chain of edits that made this score, newest first. To go back, keep using an older score_id.',
      inputSchema: ScoreHistoryInput,
      outputSchema: ScoreHistoryResult,
      annotations: { ...readOnly, title: 'Score history' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const entries: Array<{
        score_id: string;
        parent: string | null;
        tool: string | null;
        args: unknown;
        available: boolean;
      }> = [];
      let id: string | null = args.score_id;
      await rt.scores.get(owner, args.score_id);
      while (id && entries.length < args.limit) {
        const doc: ScoreDoc | undefined = await rt.scores.find(owner, id);
        if (!doc) {
          entries.push({ score_id: id, parent: null, tool: null, args: null, available: false });
          break;
        }
        entries.push({
          score_id: id,
          parent: doc.parent,
          tool: doc.op?.tool ?? null,
          args: doc.op?.args ?? null,
          available: true,
        });
        id = doc.parent;
      }
      return ok({ entries, truncated: Boolean(id) && entries.length >= args.limit });
    }),
  );

  server.registerTool(
    'score.diff',
    {
      title: 'Diff scores',
      description: 'Which parts, devices, regions, notes and settings differ between two scores.',
      inputSchema: ScoreDiffInput,
      outputSchema: ScoreDiffResult,
      annotations: { ...readOnly, title: 'Diff scores' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const [a, b] = await Promise.all([
        rt.scores.get(owner, args.from),
        rt.scores.get(owner, args.to),
      ]);
      return ok({ changed: scoreDiff(a, b) });
    }),
  );

  for (const tool of SCORE_EDIT_TOOLS) {
    const meta = EDIT_DESCRIPTIONS[tool];
    server.registerTool(
      tool,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: scoreEditInput(tool),
        outputSchema: ScoreEditResults[tool],
        annotations: { ...annotations, title: meta.title },
      },
      guard(async (args: Record<string, unknown> & { score_id: string }) => {
        const { score_id, ...rest } = args;
        return applyAndReply(deps, score_id, [{ tool, args: rest }], { tool, args: rest }, false);
      }),
    );
  }

  server.registerTool(
    'score.batch',
    {
      title: 'Batch score edit',
      description:
        'A pipeline of score edits in one call: each op runs on the result of the one before, and a later op takes an id an earlier op made with {"$ref":"ops[N].region_id"} (or part_id, device_id, send_id, note_ids[M]). Each op is a score.* edit by name with its own args, less score_id. All apply or none do, and one new score_id comes back. Returns the new score_id, what changed, warnings, and results: [{tool, part_id?, device_id?, region_id?, send_id?, note_ids?}] per op.',
      inputSchema: ScoreBatchInput,
      outputSchema: ScoreBatchResult,
      annotations: { ...annotations, title: 'Batch score edit' },
    },
    guard(async (args) =>
      applyAndReply(
        deps,
        args.score_id,
        args.ops as ScoreBatchOp[],
        { tool: 'score.batch', args: { ops: args.ops } },
        true,
      ),
    ),
  );
}
