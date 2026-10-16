import {
  type BatchOp,
  diff,
  fromView,
  type MediaFacts,
  newTimeline,
  runEdits,
  ticksPerFrame,
  toView,
} from '@cuttingfloor/core';
import { lengthFrames, measureMix } from '@cuttingfloor/engine';
import {
  BatchInput,
  CfError,
  EDIT_TOOLS,
  type EditTool,
  editInput,
  LoudnessInput,
  TimelineCreateInput,
  TimelineDiffInput,
  TimelineDiffResult,
  type TimelineDoc,
  TimelineGetResult,
  TimelineHistoryInput,
  TimelineHistoryResult,
  TimelineIdResult,
  TimelineLoadInput,
  TimelineRef,
} from '@cuttingfloor/schema';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import {
  assertOnline,
  factsResolver,
  framesUri,
  mediaIdsIn,
  mediaResolver,
  nestedIdsIn,
  previewFrames,
  sourcesFor,
  timelineImage,
  timelineResolver,
  timelineWaveform,
  waveformUri,
} from '../render.ts';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

const EDIT_DESCRIPTIONS: Record<EditTool, { title: string; description: string }> = {
  'timeline.set_sequence': {
    title: 'Set sequence',
    description:
      'Change resolution, frame rate or audio format. Clip times are kept in time, so they survive a rate change.',
  },
  'track.add': {
    title: 'Add track',
    description: 'Add an empty video or audio track. New video tracks go on top.',
  },
  'track.remove': { title: 'Remove track', description: 'Remove a track and its clips.' },
  'track.set': {
    title: 'Set track',
    description: 'Rename, mute (audio), hide (video) or lock a track.',
  },
  'clip.add': {
    title: 'Add clip',
    description:
      'Place media on the timeline. A/V media lands as a linked pair on a video and an audio track. Default: the whole media, after the last clip, overwriting.',
  },
  'clip.remove': {
    title: 'Remove clip',
    description: 'Remove a clip and the clips linked to it; ripple closes the gap.',
  },
  'clip.move': {
    title: 'Move clip',
    description: 'Move a clip (and its linked clips) to a frame and optionally another track.',
  },
  'clip.trim': {
    title: 'Trim clip',
    description:
      'Move the start or end edge of a clip. side: video or audio trims one half of a link group (J/L cuts).',
  },
  'clip.split': {
    title: 'Split clip',
    description: 'Cut a clip (and its linked clips) in two at a frame.',
  },
  'clip.link': { title: 'Link clips', description: 'Make clips move, trim and split together.' },
  'clip.unlink': { title: 'Unlink clip', description: 'Break the link group a clip belongs to.' },
  'clip.set_enabled': {
    title: 'Enable/disable clip',
    description: 'A disabled clip stays on the timeline but renders as a gap.',
  },
  'clip.set_speed': {
    title: 'Set speed',
    description:
      'Speed up, slow down, ramp or reverse a clip and its linked clips. rate is constant; curve is a speed ramp over the clip. The clip keeps its source and its length changes; ripple (default) moves later clips. Pitch is kept unless preserve_pitch is false.',
  },
  'clip.freeze': {
    title: 'Freeze frame',
    description:
      'Hold the frame at at_frame for duration_frames: the clip splits there, a freeze frame goes in, and later clips on its tracks move later.',
  },
  'clip.roll': {
    title: 'Roll edit',
    description:
      'Move the cut between a clip and the clip right after it: one gets longer, the other shorter, nothing else moves.',
  },
  'clip.slip': {
    title: 'Slip edit',
    description: 'Show earlier or later source in a clip without moving or resizing it.',
  },
  'clip.slide': {
    title: 'Slide edit',
    description:
      'Move a clip between its neighbours: the clip before it and the clip after it change length so nothing else moves.',
  },
  'clip.replace': {
    title: 'Replace media',
    description:
      'Swap the media in a clip, keeping its place, length, speed and look. Starts at source_in (default 0).',
  },
  'range.lift': {
    title: 'Lift range',
    description:
      'Remove everything in a frame range on the given tracks (default all unlocked), leaving a gap.',
  },
  'range.extract': {
    title: 'Extract range',
    description:
      'Remove everything in a frame range on the given tracks (default all unlocked) and close the gap. For cutting out silences, filler words or mistakes across all tracks at once.',
  },
  'title.add': {
    title: 'Add title',
    description:
      'Text on a video track, over the tracks below: styled with font, size, colour, outline, shadow and box, placed by x/y, revealed with a typewriter or word animation. It is a clip, so transforms, masks, animations and transitions apply.',
  },
  'caption.add': {
    title: 'Add captions',
    description:
      'Captions on a video track from segments (with optional word timings for highlights) or from SRT/VTT text. One clip per caption; returns their clip_ids. Burned in when exported.',
  },
  'text.set': {
    title: 'Set text',
    description:
      "Change a title's or caption's text, or restyle many at once (clip_ids, or every one on track_id). The style is merged; null turns an outline, shadow, box or highlight off. Highlight modes and fonts: video://catalog/text and video://catalog/fonts.",
  },
  'audio.set_gain': {
    title: 'Set gain',
    description:
      "Volume of an audio clip (or a video clip's linked audio) in dB; keyframes ride it up and down. The preview is a waveform of the clip with the measured loudness.",
  },
  'audio.set_pan': {
    title: 'Set pan',
    description: "Place a clip's sound left (-1) to right (1).",
  },
  'audio.fade': {
    title: 'Fade audio',
    description: "Fade a clip's sound in from its start and out to its end. null removes a fade.",
  },
  'audio.duck': {
    title: 'Duck under speech',
    description:
      'Lower a track (usually music) wherever the other audio tracks have sound, using the silences found at import; writes gain keyframes on its clips that you can see and change.',
  },
  'audio.set_master': {
    title: 'Set master',
    description:
      'Gain (dB) and limiter ceiling (dBFS) on the whole mix. audio.set_loudness sets both from a measured loudness target.',
  },
  'filter.add': {
    title: 'Add effect',
    description:
      'Apply an effect from video://catalog/effects (colour, LUT, blur, vignette, chroma key, glitch; EQ, compressor, denoise, pitch and more) to a clip, every clip on a track, or the whole timeline. Number params take keyframes. Returns its id as clip_id.',
  },
  'filter.set': {
    title: 'Set effect',
    description: "Change an effect's params (merged) or turn it off and on.",
  },
  'filter.remove': { title: 'Remove effect', description: 'Take an effect off.' },
  'adjustment.add': {
    title: 'Add adjustment clip',
    description:
      'An empty clip on a video track whose effects (filter.add with its clip_id) change everything below it while it runs: a colour grade or blur over a stretch of the edit.',
  },
  'transition.add': {
    title: 'Add transition',
    description:
      'Transition at the cut after a clip, into the clip that touches it (video://catalog/transitions). Linked audio gets a crossfade at the same cut. mode overlap (default) overlaps the clips and moves later clips earlier; handles uses source past the cut and moves nothing.',
  },
  'transition.set': {
    title: 'Set transition',
    description: "Change a transition's kind or duration.",
  },
  'transition.remove': {
    title: 'Remove transition',
    description: 'Remove a transition; the cut becomes a hard cut.',
  },
  'clip.set_transform': {
    title: 'Set transform',
    description:
      'Position, scale, rotate, fade, flip, crop or fit a video clip over the tracks below (picture-in-picture, overlays, punch-ins). Any number takes a constant or {keyframes: [{frame, value, ease}]} with frames from the clip start; eases are listed at video://catalog/eases. Omitted fields keep their value; null resets one.',
  },
  'clip.set_blend': {
    title: 'Set blend mode',
    description:
      'How a video clip mixes with the tracks below: normal, multiply, screen, overlay and more (video://catalog/blend_modes).',
  },
  'clip.set_mask': {
    title: 'Set mask',
    description:
      'Show only part of a video clip: rectangle (rounded), ellipse, linear, mirror, heart, star or polygon, with feather and invert. Position, size, rotation and feather animate like transform values. null removes the mask.',
  },
  'clip.set_animation': {
    title: 'Set animation',
    description:
      'Entrance, exit and loop presets layered over the clip transform (video://catalog/animations): e.g. in {name: "pop", duration_frames: 12}, loop {name: "float"}. null removes one.',
  },
};

// Edit results share one shape, described here rather than as 13 copies of an output schema
// (packages/schema EditResult/BatchResult define it; tests hold results to it).
const RETURNS = 'Returns the edit result (see the server instructions).';

export function registerTimelineTools(server: McpServer, deps: ServerDeps): void {
  const { runtime: rt } = deps;
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  server.registerTool(
    'timeline.create',
    {
      title: 'Create timeline',
      description:
        'Start an empty timeline. Returns its timeline_id. Timelines are immutable: every edit returns a new timeline_id, and older ids stay valid for 24 hours after last use.',
      inputSchema: TimelineCreateInput,
      outputSchema: TimelineIdResult,
      annotations: { ...annotations, title: 'Create timeline' },
    },
    guard(async (args) => {
      const doc = newTimeline(args.name, args.sequence, args.tracks);
      doc.op = { tool: 'timeline.create', args };
      return ok({ timeline_id: await rt.timelines.put(deps.owner(), doc) });
    }),
  );

  server.registerTool(
    'timeline.get',
    {
      title: 'Get timeline',
      description:
        'The full timeline: tracks, clips (frames, end exclusive), link groups and the media it uses. Keep this JSON to restore the timeline later with timeline.load.',
      inputSchema: TimelineRef,
      outputSchema: TimelineGetResult,
      annotations: { ...readOnly, title: 'Get timeline' },
    },
    guard(async (args) =>
      ok(toView(args.timeline_id, await rt.timelines.get(deps.owner(), args.timeline_id))),
    ),
  );

  server.registerTool(
    'timeline.load',
    {
      title: 'Load timeline',
      description:
        'Restore a timeline from the JSON timeline.get returned, e.g. after it expired. Its media must still be imported.',
      inputSchema: TimelineLoadInput,
      outputSchema: TimelineIdResult,
      annotations: { ...annotations, title: 'Load timeline' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const media = await mediaResolver(rt, owner, mediaIdsIn(args.timeline.tracks));
      const doc = fromView(args.timeline, (id) => media.get(id));
      doc.op = { tool: 'timeline.load', args: null };
      return ok({ timeline_id: await rt.timelines.put(owner, doc) });
    }),
  );

  server.registerTool(
    'timeline.history',
    {
      title: 'Timeline history',
      description:
        'The chain of edits that made this timeline, newest first. To go back, keep using an older timeline_id.',
      inputSchema: TimelineHistoryInput,
      outputSchema: TimelineHistoryResult,
      annotations: { ...readOnly, title: 'Timeline history' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const entries: Array<{
        timeline_id: string;
        parent: string | null;
        tool: string | null;
        args: unknown;
        available: boolean;
      }> = [];
      let id: string | null = args.timeline_id;
      await rt.timelines.get(owner, args.timeline_id);
      while (id && entries.length < args.limit) {
        const doc: TimelineDoc | undefined = await rt.timelines.find(owner, id);
        if (!doc) {
          entries.push({ timeline_id: id, parent: null, tool: null, args: null, available: false });
          break;
        }
        entries.push({
          timeline_id: id,
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
    'timeline.diff',
    {
      title: 'Diff timelines',
      description: 'Which clips, tracks and settings differ between two timelines.',
      inputSchema: TimelineDiffInput,
      outputSchema: TimelineDiffResult,
      annotations: { ...readOnly, title: 'Diff timelines' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const [a, b] = await Promise.all([
        rt.timelines.get(owner, args.from),
        rt.timelines.get(owner, args.to),
      ]);
      return ok({ changed: diff(a, b) });
    }),
  );

  for (const tool of EDIT_TOOLS) {
    const meta = EDIT_DESCRIPTIONS[tool];
    server.registerTool(
      tool,
      {
        title: meta.title,
        description: `${meta.description} ${RETURNS}`,
        inputSchema: editInput(tool),
        annotations: { ...annotations, title: meta.title },
      },
      guard(
        async (
          args: Record<string, unknown> & {
            timeline_id: string;
            preview: 'inline' | 'link' | 'none';
          },
        ) => {
          const { timeline_id, preview, ...rest } = args;
          return applyAndReply(deps, timeline_id, preview, [{ tool, args: rest }], {
            tool,
            args: rest,
          });
        },
      ),
    );
  }

  registerLoudness(server, deps);

  server.registerTool(
    'edit.batch',
    {
      title: 'Batch edit',
      description:
        'Apply many edits as one change: one new timeline_id, one preview. All apply or none do. Use {"$ref":"ops[N].clip_id"} (or track_id, clip_ids[M]) to use an id an earlier op made. Returns the edit result plus results: [{tool, clip_id?, clip_ids?, track_id?}] per op.',
      inputSchema: BatchInput,
      annotations: { ...annotations, title: 'Batch edit' },
    },
    guard(async (args) =>
      applyAndReply(
        deps,
        args.timeline_id,
        args.preview,
        args.ops as BatchOp[],
        { tool: 'edit.batch', args: { ops: args.ops } },
        true,
      ),
    ),
  );
}

/** Timelines up to this long set loudness in the call; longer ones become a task or job. */
const LOUDNESS_INLINE_SECONDS = 60;

function registerLoudness(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;
  server.registerTool(
    'audio.set_loudness',
    {
      title: 'Set loudness',
      description:
        'Measure the mix and set the master gain and a limiter so the whole timeline lands on target_lufs (default -14, the usual for online video) with peaks under true_peak_db. Returns the edit result plus measured {before_lufs, lufs, true_peak_db}. Short timelines answer at once; longer ones return a task or job.',
      inputSchema: LoudnessInput,
      annotations: {
        title: 'Set loudness',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const base = await rt.timelines.get(owner, args.timeline_id);
      const work = async ({ signal }: { signal: AbortSignal }) => {
        const { sources, offline } = await sourcesFor(rt, owner, base, 'export');
        assertOnline(offline);
        // Measure without any master, set the gain, then measure again and correct once
        // (the limiter takes a little off the top).
        const { master: _m, ...bare } = base;
        const before = await measureMix(bare, sources, { signal });
        if (before.lufs === null) {
          throw new CfError('bad_request', 'The timeline has no measurable sound', {
            hint: 'Add audio, or unmute its tracks',
          });
        }
        const limit = Math.round((args.true_peak_db - 0.5) * 10) / 10;
        let gain = Math.round((args.target_lufs - before.lufs) * 100) / 100;
        let after = await measureMix({ ...bare, master: { gain, limit } }, sources, { signal });
        if (after.lufs !== null) {
          gain = Math.round((gain + args.target_lufs - after.lufs) * 100) / 100;
          after = await measureMix({ ...bare, master: { gain, limit } }, sources, { signal });
        }
        return applyAndReply(
          deps,
          args.timeline_id,
          args.preview,
          [{ tool: 'audio.set_master', args: { gain_db: gain, limit_db: limit } }],
          {
            tool: 'audio.set_loudness',
            args: { target_lufs: args.target_lufs, true_peak_db: args.true_peak_db },
          },
          false,
          { measured: { before_lufs: before.lufs, lufs: after.lufs, true_peak_db: after.peak } },
        );
      };
      const seconds = (lengthFrames(base) * ticksPerFrame(base.sequence.fps)) / 705_600_000;
      if (seconds <= LOUDNESS_INLINE_SECONDS) {
        const signal =
          (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal ??
          new AbortController().signal;
        return work({ signal });
      }
      const job = await rt.jobs.store.create({
        owner,
        tool: 'audio.set_loudness',
        statusMessage: 'measuring',
      });
      rt.jobs.start(job, work as never);
      return jobReply(job, ctx);
    }),
  );
}

async function applyAndReply(
  deps: ServerDeps,
  baseId: string,
  preview: 'inline' | 'link' | 'none',
  ops: BatchOp[],
  record: { tool: string; args: unknown },
  batch = false,
  extra: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const rt = deps.runtime;
  const owner = deps.owner();
  const base = await rt.timelines.get(owner, baseId);
  const media = await mediaResolver(rt, owner, mediaIdsIn(ops));
  const nestable = await timelineResolver(rt, owner, nestedIdsIn(ops));
  // Ducking, transcript captions and word-range clips read what import and media.analyze
  // found; only those load the media records.
  const needsFacts = ops.some(
    (o) =>
      o.tool === 'audio.duck' ||
      (o.tool === 'caption.add' && 'from_transcript' in o.args) ||
      (o.tool === 'clip.add' && JSON.stringify(o.args.source ?? '').includes('"words"')),
  );
  const facts = needsFacts
    ? await factsResolver(rt, owner, base, mediaIdsIn(ops))
    : new Map<string, MediaFacts>();
  const { doc, outcome, results } = runEdits(
    base,
    baseId,
    ops,
    (id) => media.get(id),
    record,
    (id) => nestable.get(id),
    (id) => facts.get(id),
  );
  const id = await rt.timelines.put(owner, doc);
  const warnings = [...outcome.warnings];
  const content: CallToolResult['content'] = [];
  let previewRef: {
    uri: string;
    frames: number[];
    status: 'ready' | 'pending';
    loudness?: { lufs: number | null; true_peak_db: number | null };
  } | null = null;
  const fail = (error: unknown) =>
    warnings.push(
      `Preview not rendered: ${error instanceof CfError ? error.message : String(error)}`,
    );
  if (outcome.audio && preview !== 'none') {
    // Audio edits show the sound of the span they changed, with its measured loudness.
    const tpf = ticksPerFrame(doc.sequence.fps);
    const span = {
      start: Math.round(outcome.audio.start / tpf),
      end: Math.min(lengthFrames(doc), Math.round(outcome.audio.end / tpf)),
    };
    if (span.end > span.start) {
      previewRef = {
        uri: waveformUri(id, span),
        frames: [span.start, span.end],
        status: 'pending',
      };
      if (preview === 'inline') {
        try {
          const wave = await timelineWaveform(rt, owner, id, doc, span);
          content.push({
            type: 'image',
            data: wave.image.toString('base64'),
            mimeType: 'image/webp',
          });
          previewRef.status = 'ready';
          previewRef.loudness = { lufs: wave.lufs, true_peak_db: wave.peak };
        } catch (error) {
          fail(error);
        }
      }
    }
  } else {
    const frames = previewFrames(doc, outcome.focus, outcome.temporal);
    if (preview !== 'none' && frames.length) {
      previewRef = { uri: framesUri('timeline', id, frames), frames, status: 'pending' };
      if (preview === 'inline') {
        try {
          const image = await timelineImage(rt, owner, id, doc, frames);
          content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/webp' });
          previewRef.status = 'ready';
        } catch (error) {
          fail(error);
        }
      }
    }
  }
  const structured = {
    timeline_id: id,
    parent: baseId,
    changed: diff(base, doc),
    ...(outcome.clip_id ? { clip_id: outcome.clip_id } : {}),
    ...(outcome.clip_ids ? { clip_ids: outcome.clip_ids } : {}),
    ...(outcome.track_id ? { track_id: outcome.track_id } : {}),
    preview: previewRef,
    warnings,
    ...extra,
    ...(batch ? { results } : {}),
  };
  return ok(structured, content);
}
