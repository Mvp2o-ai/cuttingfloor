import { existsSync } from 'node:fs';
import type { CredentialStore } from '@cuttingfloor/credentials';
import { type AccountGetResult, KEEPING, span } from '@cuttingfloor/schema';
import { McpServer } from '@modelcontextprotocol/server';
import { logToolCalls } from './calls.ts';
import { registerCatalogs } from './catalog.ts';
import { drainingError } from './drain.ts';
import { registerEditor } from './editor.ts';
import { registerLibrary } from './library.ts';
import type { OwnerLimits } from './meter.ts';
import { registerPlayer } from './player.ts';
import { registerResources } from './resources.ts';
import { toErrorResult } from './result.ts';
import type { Runtime } from './runtime.ts';
import { registerTasks } from './tasks.ts';
import { registerCreateTools } from './tools/create.ts';
import { claimFile, claimSeen, gateUntilClaimed, registerCreditTools } from './tools/credits.ts';
import { registerInterchangeTools } from './tools/interchange.ts';
import { registerJudgeTools } from './tools/judge.ts';
import { registerListenTools } from './tools/listen.ts';
import { registerMediaTools } from './tools/media.ts';
import { registerRenderTools } from './tools/render.ts';
import { registerSearchTools } from './tools/search.ts';
import { registerSeekTools } from './tools/seek.ts';
import { registerSkillTools } from './tools/skills.ts';
import { registerSupportTools } from './tools/support.ts';
import { registerTimelineTools } from './tools/timeline.ts';
import { registerUpload } from './upload.ts';
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
  /**
   * Hosted: false where no assistant can claim (apps on /v1 for their users), so calls there are
   * never refused for the free-credits claim. Default true.
   */
  claimGate?: boolean;
  /**
   * Hosted: whether the account's free credits are claimed, read with `creditsClaimed` before
   * the server is built, since building it cannot wait for a record store that is not the
   * filesystem. Left out, the filesystem store's record is read in place; on another store the
   * account counts as claimed only once this process has seen its claim.
   */
  claimed?: boolean;
}

/**
 * The server's instructions, from its own config: path imports and the samples only where this
 * server has media roots, credits only on the hosted service (numbers from the plans). `welcome`
 * leads with the welcome a signed-in account gets until its free credits are claimed.
 */
function instructions(config: Runtime['config'], welcome = false): string {
  const roots = config.mediaRoots;
  const hosted = config.mode === 'hosted';
  const samples = roots.includes('/samples')
    ? '; to try it, /samples/sample.mp4 and /samples/card.png'
    : '';
  const credits = hosted
    ? `
Credits: making is free (edits, jobs, judgments). Exports, created media and full-size frames download with a cuttingfloor watermark (watermarked: true); when the user wants it clean, tell them release_credits (1 a finished minute) and, with their go-ahead, export.release. Audio, text and their own uploads are never watermarked.`
    : '';
  return `${welcome ? `${WELCOME}\n` : ''}cuttingfloor is a headless video editor: media comes in, is cut and finished, and leaves as a download. Work, not storage: ${KEEPING}; links work ${span(config.outputUrlTtlMs)} (re-read for fresh ones). Download finished or approved work (or have the user); if they count on keeping it, say it's temporary. To go on later, keep timeline.get's document (timeline.load) and the files (media.import again). media.delete drops unwanted media.
Two ways in, often both:
- Make new: create.motion (animated HTML, alpha), .still (HTML to PNG), .matte (solid, gradient), .voiceover (speech, timed words); a picture the user shows is a reference to rebuild in HTML, not import. Remake: create.cutout, .stabilized, .upscaled, .lipsync (user's provider key). Music isn't made (it's the user's files); meme and hype sound effects to import: video://catalog/sound_effects.
- Edit theirs: media.import a URL${roots.length ? `, a path under ${roots.join(', ')}` : ''}, an upload_id or a small data: URI${samples}. A file on their device, or attached but not handed to you: media.upload, an upload box in the chat (or a link)${config.uploadPage ? `, or they drop it on their upload page, ${config.uploadPage}` : ''}. Sent files: media.list.
${INSTRUCTIONS_BODY}${credits}`;
}

const WELCOME = `This is a new connection: welcome to cuttingfloor. Ask the user what they'd like to make, then activate their account with credits.claim and their answer: it personalises their start, puts a sample video that fits it in their library and plays it here, so they can try an edit right away.`;

const INSTRUCTIONS_BODY = `Tools are primitives doing exactly what their arguments say; you compose them.
1. create.* and media.import run long (a task, or a job_id; job.get can wait). Edits, previews and render.frames take a media_id once processing (imported) or complete (created); analysis, judge.ask and create.* need it ready; export waits for it.
2. timeline.create {width, height, fps:{num,den}}, then clip.*, track.*, or edit.batch (many edits, one call). Each edit returns a NEW timeline_id: use the latest; older stay valid (undo).
 Timing: set_speed (ramp, reverse), freeze, roll, slip, slide, replace; range.lift / extract cut a span from all tracks. Nest a same-shape timeline (clip.add nested_timeline_id); else export and import its job.
 transition.add at a cut: dissolve, wipe, push, zoom… (linked audio crossfades).
 Text on a video track: title.add, caption.add (segments, SRT, VTT; word timings highlight), text.set restyles many.
 Audio: set_gain (keyframes), set_pan, fade, set_master (gain, limiter); inline previews measure loudness.
 filter.add on a clip, track or timeline: picture and sound effects (colour, LUT, key, EQ…). adjustment.add covers all below for a stretch.
 Overlays: a higher video track, then set_transform, set_mask, set_blend, set_animation. Names: video://catalog/{name}; a wrong one is refused with the list.
 Facts: media.analyze (transcript, beats, faces, track…) to cut by words (clip.add source {words}) or beats, caption (caption.add in_clip), reframe, pin to a tracked object; judge.ask answers typed questions (yes/no, choice, score, box) on text, JSON and pictures, look across sampled frames; media.seek finds a moment from plain words.
3. Look: preview "inline", render.frames; for motion and sound, export a range with mp4_h264_fast.
4. qa.check, then export.video: a download url and a browser page_url for the user (MP4, ProRes, GIF, WAV, MP3; sequence size unless overridden). export.timeline: FCPXML, OTIO, EDL, SRT, VTT.
Skills: methods for common jobs; skills.search in the user's words, then skills.get.
Time is frames at the sequence rate; ranges end-exclusive.`;

/**
 * A signed-in hosted account (one with an account) whose free credits aren't claimed yet: one
 * stat of credits.claim's record, so it costs a connection next to nothing.
 */
function unclaimed(deps: ServerDeps): boolean {
  if (deps.runtime.config.mode !== 'hosted' || !deps.account) return false;
  if (deps.claimed !== undefined) return !deps.claimed;
  if (deps.runtime.config.records) return !claimSeen(deps.runtime, deps.owner());
  return !existsSync(claimFile(deps, deps.owner()));
}

/** Builds one MCP server instance over the shared runtime. Transports live in apps/. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(deps.runtime.config, unclaimed(deps)) },
  );
  logToolCalls(server, (entry) => deps.runtime.logCall(deps.owner(), entry));
  gateUntilClaimed(server, deps);
  compactSchemas(server);
  allowTaskReplies(server);
  drainTools(server, deps.runtime);
  if (deps.access) gateTools(server, deps.access);
  registerTasks(server, deps);
  registerResources(server, deps);
  registerCatalogs(server);
  registerPlayer(server, deps);
  registerEditor(server, deps);
  registerLibrary(server, deps);
  registerUpload(server, deps);
  registerTimelineTools(server, deps);
  registerMediaTools(server, deps);
  registerSeekTools(server, deps);
  registerSearchTools(server, deps);
  registerListenTools(server, deps);
  registerJudgeTools(server, deps);
  registerCreateTools(server, deps);
  registerRenderTools(server, deps);
  registerInterchangeTools(server, deps);
  registerSkillTools(server);
  // credits.claim and support.contact only on the hosted service: a server you run yourself
  // has no credits and no team reading its messages.
  if (deps.runtime.config.mode === 'hosted') {
    registerCreditTools(server, deps);
    registerSupportTools(server, deps);
  }
  // account.get (tools/account.ts) stays unregistered while ChatGPT reviews the plugin: the
  // review scanned the tools without it, and it describes buying credits.
  return server;
}

/**
 * While the server drains (drain.ts), a tool that is not read-only is refused before it runs, as
 * an outage is: reads, job.get and media.list go on, and jobs already running finish.
 */
function drainTools(server: McpServer, runtime: ServerDeps['runtime']): void {
  const register = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: { annotations?: { readOnlyHint?: boolean } },
    handler: (...a: unknown[]) => unknown,
  ) =>
    register(
      name,
      config as never,
      (async (...args: unknown[]) => {
        if (runtime.drain?.active && config.annotations?.readOnlyHint !== true) {
          return toErrorResult(drainingError());
        }
        return handler(...args);
      }) as never,
    )) as typeof server.registerTool;
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
  // Deprecated values are still accepted but not advertised: a branch marked deprecated goes,
  // and a union left with one branch becomes that branch.
  let source = node as Record<string, unknown>;
  if (Array.isArray(source.anyOf)) {
    const { anyOf, ...rest } = source;
    const kept = (anyOf as Array<{ deprecated?: boolean }>).filter((b) => !b?.deprecated);
    source = kept.length === 1 ? { ...kept[0], ...rest } : { ...rest, anyOf: kept };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (k === '$schema') continue;
    if (open && k === 'additionalProperties' && v === false) continue;
    if ((k === 'minimum' && v === -SAFE) || (k === 'maximum' && v === SAFE)) continue;
    out[k] = compact(v, open);
  }
  return out as never;
}
