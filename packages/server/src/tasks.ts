import type { Job } from '@cuttingfloor/jobs';
import {
  CancelTaskRequestV2Schema,
  GetTaskRequestV2Schema,
  TASKS_EXTENSION_ID_V2,
  UpdateTaskRequestV2Schema,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { type McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { ServerDeps } from './server.ts';

/**
 * MCP Tasks (io.modelcontextprotocol/tasks, 2026-07-28) on top of the job store.
 * Wire shapes come from the official @modelcontextprotocol/ext-tasks schemas; the SDK
 * has no server-side Tasks runtime yet, so this adapter maps tasks/* onto JobStore.
 * Replace it with the SDK's own support when that ships; the store stays.
 */
export function registerTasks(server: McpServer, deps: ServerDeps): void {
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID_V2]: {} } });

  server.server.setRequestHandler(
    'tasks/get',
    { params: GetTaskRequestV2Schema.shape.params },
    async ({ taskId }) => toTask(await mustFind(deps, taskId)),
  );

  server.server.setRequestHandler(
    'tasks/cancel',
    { params: CancelTaskRequestV2Schema.shape.params },
    async ({ taskId }) => {
      const job = await deps.jobs.cancel(taskId, deps.owner());
      if (!job) throw notFound(taskId);
      return toTask(job);
    },
  );

  server.server.setRequestHandler(
    'tasks/update',
    { params: UpdateTaskRequestV2Schema.shape.params },
    async ({ taskId }) => {
      // input_required answers land here (e.g. a URL elicitation for a provider key).
      return toTask(await mustFind(deps, taskId));
    },
  );
}

async function mustFind(deps: ServerDeps, taskId: string): Promise<Job> {
  const job = await deps.jobs.get(taskId, deps.owner());
  if (!job) throw notFound(taskId);
  return job;
}

function notFound(taskId: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
}

function toTask(job: Job) {
  return {
    taskId: job.id,
    status: job.status,
    ...(job.statusMessage ? { statusMessage: job.statusMessage } : {}),
    createdAt: job.createdAt,
    lastUpdatedAt: job.lastUpdatedAt,
    ttlMs: job.ttlMs,
  };
}
