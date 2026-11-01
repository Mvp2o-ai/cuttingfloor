import {
  errorResult,
  type FileJobStore,
  type Job,
  type JobEstimate,
  type JobResult,
} from '@cuttingfloor/jobs';
import { CfError, RESULT_SUMMARY_ITEMS } from '@cuttingfloor/schema';
import { TASKS_EXTENSION_ID_V2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import type { CallToolResult } from '@modelcontextprotocol/server';

export const POLL_INTERVAL_MS = 1000;

/** A successful tool result: structured content plus the same JSON as text for older clients. */
export function ok(structured: object, extra: CallToolResult['content'] = []): CallToolResult {
  return {
    content: [...extra, { type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured as Record<string, unknown>,
  };
}

/** Domain errors become `isError` results; anything else is an engine error. */
export function toErrorResult(error: unknown): CallToolResult {
  const cf =
    error instanceof CfError
      ? error
      : new CfError('engine_error', error instanceof Error ? error.message : String(error));
  return errorResult(cf) as CallToolResult;
}

export function guard<A, C>(
  handler: (args: A, ctx: C) => Promise<CallToolResult>,
): (args: A, ctx: C) => Promise<CallToolResult> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (error) {
      return toErrorResult(error);
    }
  };
}

interface RequestCtx {
  mcpReq: { envelope?: Record<string, unknown> };
}

/**
 * True when this request is on the 2026-07-28 protocol and the client declared the Tasks
 * extension in its per-request capabilities, so a long call may answer with a task.
 */
export function wantsTask(ctx: unknown): boolean {
  const envelope = (ctx as RequestCtx).mcpReq?.envelope;
  if (!envelope?.['io.modelcontextprotocol/protocolVersion']) return false;
  const caps = envelope['io.modelcontextprotocol/clientCapabilities'] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return Boolean(caps?.extensions?.[TASKS_EXTENSION_ID_V2]);
}

/** The task wire shape (io.modelcontextprotocol/tasks) for a job. */
export function toTask(job: Job) {
  return {
    taskId: job.id,
    status: job.status,
    ...(job.statusMessage ? { statusMessage: job.statusMessage } : {}),
    createdAt: job.createdAt,
    lastUpdatedAt: job.lastUpdatedAt,
    ttlMs: job.ttlMs,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

/** How a long-running tool answers: a task when the client opted in, otherwise a job handle. */
export function jobReply(job: Job, ctx: unknown): CallToolResult {
  if (wantsTask(ctx)) {
    return { ...toTask(job), resultType: 'task' } as unknown as CallToolResult;
  }
  if (job.status === 'completed' && job.result) return job.result as CallToolResult;
  return ok({
    job_id: job.id,
    status: job.status,
    status_uri: `video://jobs/${job.id}`,
    ...(job.meta?.media_id ? { media_id: job.meta.media_id } : {}),
    hint: 'Long-running: job.get {job_id, wait_seconds: 30} answers when it moves; the result comes with it once completed',
  });
}

/** How much of a finished job's result a view carries. */
export type ResultMode = 'full' | 'summary' | 'none';

/** What a job is for, from the ids it was started with. */
export function jobFor(job: Job) {
  const m = job.meta ?? {};
  const media = m.media_id ?? m.media;
  const made = Object.entries(m)
    .filter(([k]) => k.startsWith('stem_'))
    .map(([, v]) => v);
  const inputs = m.inputs ? m.inputs.split(',').filter(Boolean) : [];
  const out = {
    ...(media ? { media_id: media } : {}),
    ...(made.length ? { media_ids: made } : {}),
    ...(inputs.length ? { inputs } : {}),
    ...(m.timeline_id ? { timeline_id: m.timeline_id } : {}),
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.preset ? { preset: m.preset } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** Text in a result summary longer than this is cut. */
const SUMMARY_TEXT = 500;

/**
 * A result in brief: every list cut to its first items and long text cut short, with the path
 * and full length of each cut, so a status check stays small and says what it left out.
 */
export function summarize(value: unknown): { value: unknown; cut: Record<string, number> } {
  const cut: Record<string, number> = {};
  const at = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) {
      if (v.length > RESULT_SUMMARY_ITEMS) cut[path || '.'] = v.length;
      return v.slice(0, RESULT_SUMMARY_ITEMS).map((x, i) => walk(x, at(path, i)));
    }
    if (typeof v === 'string' && v.length > SUMMARY_TEXT) {
      cut[path || '.'] = v.length;
      return `${v.slice(0, SUMMARY_TEXT)}…`;
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, at(path, k))]));
    }
    return v;
  };
  return { value: walk(value, ''), cut };
}

export function jobView(
  job: Job,
  options: { result?: ResultMode; estimate?: JobEstimate | undefined } = {},
) {
  const result = job.result as JobResult | undefined;
  const mode = options.result ?? 'full';
  const done = result && !result.isError && result.structuredContent;
  const what = jobFor(job);
  const estimate = job.status === 'working' ? options.estimate : undefined;
  return {
    job_id: job.id,
    tool: job.tool,
    // A tool error completes the MCP task, but to anyone reading a job it failed.
    status: result?.isError && job.status === 'completed' ? 'failed' : job.status,
    ...(job.statusMessage ? { status_message: job.statusMessage } : {}),
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    ...(what ? { for: what } : {}),
    ...(estimate?.secondsLeft !== undefined ? { seconds_left: estimate.secondsLeft } : {}),
    ...(estimate?.startsIn !== undefined ? { starts_in_seconds: estimate.startsIn } : {}),
    created_at: job.createdAt,
    updated_at: job.lastUpdatedAt,
    ...(done && mode === 'full' ? { result: result.structuredContent } : {}),
    ...(done && mode === 'summary' ? { result_summary: summarize(result.structuredContent) } : {}),
    ...(result?.isError ? { error: result.structuredContent } : {}),
  };
}

/** What a wait watches: a change in any of these is an answer. */
const stateOf = (job: Job | undefined) =>
  job ? `${job.status}|${job.progress ?? ''}|${job.statusMessage ?? ''}` : '';

/** How often a wait rereads the job files, for jobs another server runs. */
const WAIT_POLL_MS = 1000;

/**
 * Waits up to `seconds` for any of the jobs to change status, progress or status message, and
 * returns at once if none is working (a finished job will not change). Hears this server's own
 * writes as they happen, and rereads the files for jobs other servers run.
 */
export async function waitForChange(
  store: FileJobStore,
  owner: string,
  ids: string[],
  seconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!(seconds > 0)) return;
  const first = await Promise.all(ids.map((id) => store.get(id, owner)));
  if (!first.some((j) => j?.status === 'working')) return;
  const before = new Map(ids.map((id, i) => [id, stateOf(first[i])]));
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      off();
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const off = store.onChange((job) => {
      if (job.owner === owner && before.has(job.id) && stateOf(job) !== before.get(job.id))
        finish();
    });
    const timer = setTimeout(finish, seconds * 1000);
    const poll = setInterval(() => {
      void Promise.all(ids.map((id) => store.get(id, owner))).then(
        (now) => {
          if (now.some((j, i) => stateOf(j) !== before.get(ids[i] as string))) finish();
        },
        () => undefined,
      );
    }, WAIT_POLL_MS);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
