import { errorResult, type Job, type JobResult } from '@cuttingfloor/jobs';
import { CfError } from '@cuttingfloor/schema';
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
    hint: 'Long-running: call job.get with this job_id until status is completed',
  });
}

export function jobView(job: Job) {
  const result = job.result as JobResult | undefined;
  return {
    job_id: job.id,
    tool: job.tool,
    status: job.status,
    ...(job.statusMessage ? { status_message: job.statusMessage } : {}),
    ...(job.progress !== undefined ? { progress: job.progress } : {}),
    created_at: job.createdAt,
    updated_at: job.lastUpdatedAt,
    ...(result && !result.isError && result.structuredContent
      ? { result: result.structuredContent }
      : {}),
    ...(result?.isError ? { error: result.structuredContent } : {}),
  };
}
