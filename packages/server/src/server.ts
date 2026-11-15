import type { CredentialStore } from '@cuttingfloor/credentials';
import { FREE_CREDITS } from '@cuttingfloor/plans';
import { type AccountGetResult, KEEPING, span } from '@cuttingfloor/schema';
import { McpServer } from '@modelcontextprotocol/server';
import { logToolCalls } from './calls.ts';
import { registerCatalogs } from './catalog.ts';
import { registerEditor } from './editor.ts';
import { registerLibrary } from './library.ts';
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
   * Hosted: whether the owner may work right now (its plan). Throws a CfError, which every
   * tool call returns instead of running. Absent locally.
   */
  access?: () => Promise<void>;
  /**
   * Hosted: the owner's plan as limits on the work they start (jobs at once, largest export,
   * storage), and a refusal when no job or judgment may start. Absent locally: no limits.
   */
  limits?: () => Promise<OwnerLimits>;
  /** Hosted: the owner's plan and credits, for account.get. Absent locally: no plan. */
  account?: () => Promise<AccountGetResult>;
}

/**
 * The server's instructions, from its own config: path imports and the samples only where this
 * server has media roots, credits only on the hosted service (numbers from the plans).
 */
function instructions(config: Runtime['config']): string {
  const roots = config.mediaRoots;
  const hosted = config.mode === 'hosted';
  const samples = roots.includes('/samples')
    ? '; to try it, /samples/sample.mp4 and /samples/card.png'
    : '';
  const credits = hosted
    ? `
Credits: a job (export, import, analysis, create.*) spends one a minute; editing and previews are free; new accounts start with ${FREE_CREDITS}. At 0 jobs are refused (quota_exceeded): tell the user jobs wait for credits, while editing and previews still work.`
    : '';
  return `cuttingfloor is a headless video editor. The cutting floor is its workspace, like an edit suite's: media is imported onto it before editing, cut and finished there, and leaves as a download. Work, not storage: ${KEEPING}; links work ${span(config.outputUrlTtlMs)} (re-reading gives fresh ones). Download finished or approved work, or have the user do it; when they count on keeping something, say it is temporary. To go on later, save timeline.get's document (timeline.load) and files from their url (media.import again). media.delete drops unwanted media.
Two ways in, often both:
- Make new: create.motion (animated HTML, frame-exact, alpha, sandboxed), .still (HTML to PNG), .matte (solid, gradient), .voiceover (speech, timed words); a picture the user shows is a reference to rebuild in HTML, not to import. Remake: create.cutout, .stabilized, .upscaled, .lipsync (user's provider key). No music or sound effects are made: they are the user's files.
- Edit theirs: media.import a URL${roots.length ? `, a path under ${roots.join(', ')}` : ''}, an upload_id or a small data: URI${samples}. A file on their device, or attached but not handed to you: media.upload, a link they open to pick it${config.uploadPage ? `, or they drop it on their upload page, ${config.uploadPage}` : ''}. Sent files: media.list.
${INSTRUCTIONS_BODY}${credits}`;
}

const INSTRUCTIONS_BODY = `Tools are granular primitives that do exactly what their arguments say; you compose them.
1. create.* and media.import run long (a task, or a job_id for job.get, which can wait). Edits, previews and render.frames take an imported media_id once processing, a created one once complete; analysis, judge.ask and create.* need it ready; export waits for ready.
2. timeline.create {width, height, fps:{num,den}}, then clip.*, track.*, or edit.batch, a pipeline of edits in one call. Each edit returns a NEW timeline_id: use the latest; older ones stay valid (undo).
   Timing: set_speed (ramp, reverse), freeze, roll, slip, slide, replace; range.lift / extract cut a span from all tracks. Nest a same-shape timeline (clip.add nested_timeline_id); otherwise export and import its job.
   transition.add at a cut: dissolve, dip, wipe, slide, push, zoom, iris, spin (linked audio crossfades).
   Text on a video track: title.add, caption.add (segments, SRT, VTT; word timings drive highlights), text.set restyles many.
   Audio: set_gain (keyframes), set_pan, fade, set_master (gain, limiter); inline previews measure loudness.
   filter.add on a clip, track or timeline: colour, LUT, blur, vignette, key, glitch, denoise; EQ, compressor, noise reduction, voice cleanup, pitch. adjustment.add covers all below for a stretch.
   Overlays: a higher video track, then set_transform, set_mask, set_blend, set_animation. Names: video://catalog/{name}; a wrong one is refused with the list.
   Facts: media.analyze (transcript, beats, faces, track, look, silence, scenes…) to cut by words (clip.add source {words}), caption (caption.add in_clip), cut on beats, reframe, pin to a tracked object; judge.ask answers typed questions (yes/no, choice, score, box) on text, JSON and pictures, and look asks them across sampled frames; media.seek finds a moment from plain words, in a video or a rendered edit.
3. Look: preview "inline", render.frames; to watch motion and sound, export a range with review_h264.
4. qa.check, then export.video: a download url and a page_url that plays in a browser, for the user (presets: web, master, 9:16, AV1, GIF, audio; overrides). export.timeline: FCPXML, OTIO, EDL, SRT, VTT.
Skills: methods for common jobs; skills.search in the user's words first, then skills.get.
Time is frames at the sequence rate; ranges end-exclusive.`;

/** Builds one MCP server instance over the shared runtime. Transports live in apps/. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(deps.runtime.config) },
  );
  logToolCalls(server, (entry) => deps.runtime.logCall(deps.owner(), entry));
  compactSchemas(server);
  allowTaskReplies(server);
  if (deps.access) gateTools(server, deps.access);
  registerTasks(server, deps);
  registerResources(server, deps);
  registerCatalogs(server);
  registerPlayer(server, deps);
  registerEditor(server, deps);
  registerLibrary(server, deps);
  registerTimelineTools(server, deps);
  registerMediaTools(server, deps);
  registerSeekTools(server, deps);
  registerListenTools(server, deps);
  registerJudgeTools(server, deps);
  registerCreateTools(server, deps);
  registerRenderTools(server, deps);
  registerInterchangeTools(server, deps);
  registerSkillTools(server);
  // account.get (tools/account.ts) stays unregistered while ChatGPT reviews the plugin: the
  // review scanned the tools without it, and it describes buying credits.
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
