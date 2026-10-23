import type { CredentialStore } from '@cuttingfloor/credentials';
import { McpServer } from '@modelcontextprotocol/server';
import { registerCatalogs } from './catalog.ts';
import type { OwnerLimits } from './meter.ts';
import { registerPlayer } from './player.ts';
import { registerResources } from './resources.ts';
import { toErrorResult } from './result.ts';
import type { Runtime } from './runtime.ts';
import { registerTasks } from './tasks.ts';
import { registerCreateTools } from './tools/create.ts';
import { registerInterchangeTools } from './tools/interchange.ts';
import { registerJudgeTools } from './tools/judge.ts';
import { registerListenTools } from './tools/listen.ts';
import { registerMediaTools } from './tools/media.ts';
import { registerRenderTools } from './tools/render.ts';
import { registerSeekTools } from './tools/seek.ts';
import { registerSkillTools } from './tools/skills.ts';
import { registerTimelineTools } from './tools/timeline.ts';
import { SERVER_NAME, SERVER_VERSION } from './version.ts';

export interface ServerDeps {
  runtime: Runtime;
  credentials: CredentialStore;
  /** Identity that owns timelines, media and jobs: `local` in local mode, the token's `sub` hosted. */
  owner: () => string;
  /**
   * Hosted: whether the owner may work right now (trial, plan). Throws a CfError, which every
   * tool call returns instead of running. Absent locally.
   */
  access?: () => Promise<void>;
  /**
   * Hosted: the owner's plan as limits on the work they start (jobs at once, largest export,
   * judgments a day), and a refusal when no job may start. Absent locally: no limits.
   */
  limits?: () => Promise<OwnerLimits>;
}

const INSTRUCTIONS = `cuttingfloor is a headless video editor. It makes video two ways, often both at once:
- Make new: create.motion (animated HTML), create.still, create.matte and create.voiceover build media from nothing. An image, mockup or page the user shows you is a reference for you to look at and rebuild in HTML, not a file to import.
- Edit what the user has: media.import their footage, music or logo (a path under the media roots, a URL, a file on the user's machine sent with media.upload or dropped on its page, a file the user dropped on their account page (media.list shows those by name), or a small file as a data: URI; to try it, /samples/sample.mp4 and /samples/card.png where available).
The tools are granular primitives that do exactly what their arguments say; you compose them. edit.batch applies a planned sequence as one change.
Typical flow:
1. Get media: create.* for new material, media.import for the user's own files (both long-running: a task, or a job_id whose status job.get reads). Use the media_id once status is processing or ready.
2. timeline.create with a sequence ({width, height, fps:{num,den}}), then edit: clip.add, clip.trim, clip.split, clip.move, clip.remove, track.* — or edit.batch for many edits at once.
3. Every edit returns a NEW timeline_id; keep using the latest one. Older ids stay valid, so going back is just using an older id. An edit result is {timeline_id, parent, changed: [{id, type, change, track_id?, start?, end?}] (clips say where they now sit), clip_id?, clip_ids?, track_id?, preview: {uri, frames, status} | null, warnings}.
   Timing: clip.set_speed (rate, ramp curve, reverse), clip.freeze, clip.roll / slip / slide, clip.replace, range.lift / range.extract (cut a span out of every track at once). Nest a timeline of the same shape as one clip with clip.add {nested_timeline_id}; to reuse a finished edit of another shape (or bake one), export.video it and media.import {source: {job_id}}.
   Transitions: transition.add at the cut after a clip (dissolve, dips, wipes, slides, pushes, zooms, iris, spin; linked audio crossfades).
   Text: title.add and caption.add (segments, SRT or VTT; word timings drive highlights) on a video track; text.set restyles many at once.
   Audio: audio.set_gain (keyframes for rides), audio.set_pan, audio.fade, audio.set_master (gain and limiter on the mix). Audio edits preview as a waveform with measured loudness.
   Effects: filter.add on a clip, a track or the whole timeline (video://catalog/effects: colour, LUTs, blur, vignette, chroma key, glitch; EQ, compressor, denoise, pitch); adjustment.add for effects over everything below for a stretch.
   Analysis: media.analyze {kind: transcript | beats | faces | track | look | silence | scenes} turns media into data: cut by words (clip.add source {words}), caption from transcript times (caption.add in_clip), cut on beats, reframe on face boxes, pin a title to a tracked object.
   Judgment: judge.ask answers your typed questions (yes/no, choice, score, box) about text, JSON and pictures you name (a still, a video frame, a transcript passage) in one fast call; media.analyze {kind: look} asks them of frames sampled across a video. To find moments without watching, media.seek takes what you are looking for in plain words (a shot too dark, black frames, where the demo starts) and returns where it holds in a video or a rendered edit.
   Overlays and picture-in-picture: put a clip on a higher video track, then clip.set_transform, clip.set_mask, clip.set_blend and clip.set_animation. Catalogues of accepted names are resources at video://catalog/{name}.
   Create: create.motion (any animated HTML, rendered frame-exactly with alpha in a sandbox), create.still (HTML to a PNG), create.matte (solid or gradient), create.voiceover (speech with timed words), create.cutout (a subject without its background) and create.stabilized (shaky video steadied) make new media to place with clip.add.
4. Look at the result with preview: "inline" on an edit, or render.frames (stills). To watch it play, with motion, timing and sound, when you or your client take video in: export.video a range with preset review_h264; its result links the file (video://jobs/{job_id}/output) and gives a signed url, fps and duration.
5. qa.check, then export.video (long-running) for a signed download URL and a page_url to give the user, which plays it in any browser: presets for web, masters, 9:16 social, AV1, GIF and audio, with size/fps/bitrate overrides (video://catalog/presets). export.timeline hands the edit to another editor (FCPXML, OTIO, EDL) or writes captions (SRT, VTT).
Skills: step-by-step instructions for common jobs, such as cutting the pauses and ums out of a talking video. Before composing one yourself, skills.search in the user's words, then skills.get and follow its steps.
Time is integer frames at the sequence rate; ranges are end-exclusive. Keeping work: the server keeps nothing for long. Timelines expire 24 h after last use; media and exports 7 days after last use. You keep what lasts: for work longer than a day, save the timeline.get document of the latest timeline on your side and timeline.load it to carry on; save the files you want to keep from their download url (media.get, export.video) and bring them back with media.import. media.delete removes a media you no longer want, so an old version stops turning up.`;

/** Builds one MCP server instance over the shared runtime. Transports live in apps/. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  compactSchemas(server);
  allowTaskReplies(server);
  if (deps.access) gateTools(server, deps.access);
  registerTasks(server, deps);
  registerResources(server, deps);
  registerCatalogs(server);
  registerPlayer(server, deps);
  registerTimelineTools(server, deps);
  registerMediaTools(server, deps);
  registerSeekTools(server, deps);
  registerListenTools(server, deps);
  registerJudgeTools(server, deps);
  registerCreateTools(server, deps);
  registerRenderTools(server, deps);
  registerInterchangeTools(server, deps);
  registerSkillTools(server);
  return server;
}

/** Runs the access check before every tool; a refusal is the tool's result. */
function gateTools(server: McpServer, access: () => Promise<void>): void {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, handler: (...a: unknown[]) => unknown) =>
    register(
      name,
      config as never,
      (async (...args: unknown[]) => {
        try {
          await access();
        } catch (error) {
          return toErrorResult(error);
        }
        return handler(...args);
      }) as never,
    )) as typeof server.registerTool;
}

/**
 * Advertises compact schemas. Output schemas drop `additionalProperties: false`: clients cache a
 * tool's output schema when they connect and validate results against it, so with closed schemas
 * a field added in a later release fails every result until the client reconnects. Every schema
 * drops the noise JSON Schema conversion adds (`$schema`, and the safe-integer bounds on every
 * integer), since every connection pays for tools/list in tokens. Arguments and results are
 * still checked against the full zod schemas here.
 */
function compactSchemas(server: McpServer): void {
  const register = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: { inputSchema?: unknown; outputSchema?: unknown },
    handler: unknown,
  ) =>
    register(
      name,
      {
        ...config,
        ...(isStandard(config.inputSchema)
          ? { inputSchema: rewriteJson(config.inputSchema, (j) => compact(j, false)) }
          : {}),
        ...(isStandard(config.outputSchema)
          ? { outputSchema: rewriteJson(config.outputSchema, (j) => compact(j, true)) }
          : {}),
      } as never,
      handler as never,
    )) as typeof server.registerTool;
}

/**
 * A long call answers a Tasks client with a task, which carries no structured content; the SDK
 * would reject that against the tool's output schema. Only the task reply skips the check; the
 * result tasks/result later gives is the one other clients get directly.
 */
function allowTaskReplies(server: McpServer): void {
  const target = server as unknown as {
    validateToolOutput: (tool: unknown, result: { resultType?: string }, name: string) => unknown;
  };
  const validate = target.validateToolOutput.bind(server);
  target.validateToolOutput = async (tool, result, name) =>
    result.resultType === 'task' ? undefined : validate(tool, result, name);
}

interface StandardJson {
  '~standard': {
    jsonSchema: {
      input: (o: unknown) => Record<string, unknown>;
      output: (o: unknown) => Record<string, unknown>;
    };
  };
}

function isStandard(schema: unknown): schema is StandardJson {
  return Boolean((schema as Partial<StandardJson> | undefined)?.['~standard']?.jsonSchema);
}

function rewriteJson<S extends StandardJson>(schema: S, fix: (json: unknown) => unknown): S {
  const std = schema['~standard'];
  const jsonSchema = {
    ...std.jsonSchema,
    input: (options: unknown) => fix(std.jsonSchema.input(options)),
    output: (options: unknown) => fix(std.jsonSchema.output(options)),
  };
  return new Proxy(schema, {
    get: (target, key, receiver) =>
      key === '~standard' ? { ...std, jsonSchema } : Reflect.get(target, key, receiver),
  });
}

const SAFE = Number.MAX_SAFE_INTEGER;

function compact(node: unknown, open: boolean): never {
  if (Array.isArray(node)) return node.map((n) => compact(n, open)) as never;
  if (!node || typeof node !== 'object') return node as never;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    if (open && k === 'additionalProperties' && v === false) continue;
    if ((k === 'minimum' && v === -SAFE) || (k === 'maximum' && v === SAFE)) continue;
    out[k] = compact(v, open);
  }
  return out as never;
}
