import { type BatchOp, diff, fromView, newTimeline, runEdits, toView } from '@cuttingfloor/core';
import {
  BatchInput,
  CfError,
  EDIT_TOOLS,
  type EditTool,
  editInput,
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
  framesUri,
  mediaIdsIn,
  mediaResolver,
  nestedIdsIn,
  previewFrames,
  timelineImage,
  timelineResolver,
} from '../render.ts';
import { guard, ok } from '../result.ts';
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

async function applyAndReply(
  deps: ServerDeps,
  baseId: string,
  preview: 'inline' | 'link' | 'none',
  ops: BatchOp[],
  record: { tool: string; args: unknown },
  batch = false,
): Promise<CallToolResult> {
  const rt = deps.runtime;
  const owner = deps.owner();
  const base = await rt.timelines.get(owner, baseId);
  const media = await mediaResolver(rt, owner, mediaIdsIn(ops));
  const nestable = await timelineResolver(rt, owner, nestedIdsIn(ops));
  const { doc, outcome, results } = runEdits(
    base,
    baseId,
    ops,
    (id) => media.get(id),
    record,
    (id) => nestable.get(id),
  );
  const id = await rt.timelines.put(owner, doc);
  const warnings = [...outcome.warnings];
  const frames = previewFrames(doc, outcome.focus, outcome.temporal);
  const content: CallToolResult['content'] = [];
  let previewRef: { uri: string; frames: number[]; status: 'ready' | 'pending' } | null = null;
  if (preview !== 'none' && frames.length) {
    previewRef = { uri: framesUri('timeline', id, frames), frames, status: 'pending' };
    if (preview === 'inline') {
      try {
        const image = await timelineImage(rt, owner, id, doc, frames);
        content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/webp' });
        previewRef.status = 'ready';
      } catch (error) {
        warnings.push(
          `Preview not rendered: ${error instanceof CfError ? error.message : String(error)}`,
        );
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
    ...(batch ? { results } : {}),
  };
  return ok(structured, content);
}
