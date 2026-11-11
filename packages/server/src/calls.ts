import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Workspace } from '@cuttingfloor/core';
import type { Job } from '@cuttingfloor/jobs';
import type { McpServer } from '@modelcontextprotocol/server';

// What each owner's calls did, so a failure can be looked into after a deploy has replaced the
// container and its logs. One line per tool call and per job end, in the owner's day file on this
// server (`owners/{owner}/calls/{yyyy-mm-dd}.{node}.jsonl`), so servers never write the same file.
// A line keeps the tool, the time, how long it took and the outcome (an error's code and
// message), never the arguments or the result. Kept 30 days.

export const CALLS_TTL_MS = 30 * 24 * 3_600_000;

const MESSAGE_CHARS = 500;

export interface CallEntry {
  at: string;
  tool: string;
  /** A tool call: how long the server took to answer. */
  ms?: number;
  /** A long call's job (its reply), or the job this line ends. */
  job_id?: string;
  /** A job's end: completed, failed or cancelled. */
  status?: string;
  ok: boolean;
  error?: { code: string; message: string };
}

export async function recordCall(
  ws: Workspace,
  node: string,
  owner: string,
  entry: CallEntry,
): Promise<void> {
  const file = ws.ownerDir(owner, 'calls', `${entry.at.slice(0, 10)}.${node}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** A tool result's outcome: a CfError's code and message, or the SDK's text for its own refusals. */
function outcome(result: unknown): Pick<CallEntry, 'ok' | 'error' | 'job_id'> {
  const r = (result ?? {}) as {
    isError?: boolean;
    structuredContent?: { code?: unknown; message?: unknown; job_id?: unknown };
    content?: { type: string; text?: string }[];
    taskId?: unknown;
  };
  const sc = r.structuredContent;
  const job = typeof sc?.job_id === 'string' ? sc.job_id : r.taskId;
  if (!r.isError) return { ok: true, ...(typeof job === 'string' ? { job_id: job } : {}) };
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  return {
    ok: false,
    error: {
      code: typeof sc?.code === 'string' ? sc.code : 'invalid_call',
      message: (typeof sc?.message === 'string' ? sc.message : text).slice(0, MESSAGE_CHARS),
    },
  };
}

/**
 * Logs every tools/call this server answers, including the ones the SDK refuses before a tool
 * runs (arguments that fail the schema, an unknown tool). Wraps the request handler the SDK sets
 * when the first tool registers, so it must run before any tool is registered.
 */
export function logToolCalls(server: McpServer, record: (entry: CallEntry) => void): void {
  const protocol = server.server as unknown as {
    setRequestHandler: (method: string, ...rest: unknown[]) => void;
  };
  const set = protocol.setRequestHandler.bind(protocol);
  protocol.setRequestHandler = (method, ...rest) => {
    const handler = rest.pop() as (request: unknown, ctx: unknown) => Promise<unknown>;
    if (method !== 'tools/call') return set(method, ...rest, handler);
    return set(method, ...rest, async (request: unknown, ctx: unknown) => {
      const tool = String((request as { params?: { name?: unknown } }).params?.name ?? '');
      const started = Date.now();
      const at = new Date(started).toISOString();
      try {
        const result = await handler(request, ctx);
        record({ at, tool, ms: Date.now() - started, ...outcome(result) });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        record({
          at,
          tool,
          ms: Date.now() - started,
          ok: false,
          error: { code: 'protocol_error', message: message.slice(0, MESSAGE_CHARS) },
        });
        throw error;
      }
    });
  };
}

/** A job's end as a call-log line. */
export function jobEnd(job: Job): CallEntry {
  const result = job.result as
    | { isError?: boolean; structuredContent?: { code?: unknown; message?: unknown } }
    | undefined;
  const failed = job.status !== 'completed' || result?.isError;
  const sc = result?.structuredContent;
  const error = job.error
    ? { code: 'job_failed', message: job.error.message }
    : result?.isError
      ? { code: String(sc?.code ?? 'error'), message: String(sc?.message ?? '') }
      : job.status === 'cancelled'
        ? { code: 'cancelled', message: job.statusMessage ?? '' }
        : undefined;
  return {
    at: job.lastUpdatedAt,
    tool: job.tool,
    job_id: job.id,
    status: job.status,
    ok: !failed,
    ...(error ? { error: { ...error, message: error.message.slice(0, MESSAGE_CHARS) } } : {}),
  };
}
