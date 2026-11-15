import type { CredentialStore } from '@cuttingfloor/credentials';
import { FREE_CREDITS } from '@cuttingfloor/plans';
import { type AccountGetResult, KEEP_MS, KEEPING, span } from '@cuttingfloor/schema';
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
  const linkHours = Math.round(config.outputUrlTtlMs / 3_600_000);
  const credits = hosted
    ? `
Credits: jobs (exports, imports, analysis, create.*) spend credits, one a minute of running; editing and previews are free. A new account starts with ${FREE_CREDITS} free credits. At 0, new jobs are refused (quota_exceeded): tell the user that jobs won't start until there are credits again, while editing and previews still work.`
    : '';
  return `cuttingfloor is a headless video editor. The cutting floor is where you work, like the cutting room floor of an edit suite: media is imported onto it before any editing, cut and finished there, and the finished piece leaves as a download. ${KEEPING} Download finished or approved work, or have the user do it; links to files work for ${linkHours} ${linkHours === 1 ? 'hour' : 'hours'} (reading the file again gives fresh ones).
Media in: media.import brings the user's footage, music, sounds and logos onto the floor from a URL, an upload_id or a data: URI${roots.length ? `, or a path under ${roots.join(', ')}` : ''}${samples}. A file on the user's phone or computer is staged first: media.upload gives a link they open to pick it${config.uploadPage ? `, or they drop it on their upload page, ${config.uploadPage}` : ''}. A file attached in the chat that the chat app doesn't hand you goes the same way. Files already sent are in media.list. Nothing here makes music or sound effects: those come from the user's files.
Make new: create.motion (animated HTML), create.still, create.matte and create.voiceover make media from nothing; other create.* tools remake media (cutout, stabilized, upscaled, lipsync). An image the user shows you is a reference to rebuild in HTML, not a file to import.
${INSTRUCTIONS_BODY}${credits}`;
}

const INSTRUCTIONS_BODY = `Jobs: imports, analysis, create.* and exports run long and answer with a job_id; job.get reports the job and its result. Edits take a media_id once its job reports processing (a create.* media once complete); analysis needs it ready.
Edit: timeline.create with a sequence ({width, height, fps:{num,den}}), then clip, track, text, audio, transition, filter and range tools, or edit.batch, a pipeline of edits in one call (each runs on the one before's result). Every edit returns a NEW timeline_id: keep using the latest. Older ids stay valid, so going back is using an older id, and two edits from the same id make two separate versions. Time is integer frames at the sequence rate; ranges are end-exclusive. Higher video tracks sit on top.
Facts: media.analyze (transcript, speech, beats, faces, track, look, silence, scenes, sounds), media.listen, media.seek and judge.ask turn media into data and answers.
Check before delivering: preview "inline" on an edit, render.frames, qa.check. export.video gives a download url and a page_url for the user; export.timeline hands the edit to another editor or writes captions.
Skills: skills.search finds step-by-step methods for common jobs; skills.get returns one.
Work longer than ${span(KEEP_MS.timeline)}: save the timeline.get document and timeline.load it to carry on.`;

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
