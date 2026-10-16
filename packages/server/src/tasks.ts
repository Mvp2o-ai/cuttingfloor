import type { Job } from '@cuttingfloor/jobs';
import {
  CancelTaskRequestV2Schema,
  GetTaskRequestV2Schema,
  TASKS_EXTENSION_ID_V2,
  UpdateTaskRequestV2Schema,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { type McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { toTask } from './result.ts';
import type { ServerDeps } from './server.ts';

/**
 * MCP Tasks (io.modelcontextprotocol/tasks, 2026-07-28) on top of the job store.
 * Wire shapes come from the official @modelcontextprotocol/ext-tasks schemas; the SDK
 * has no server-side Tasks runtime yet, so this adapter maps tasks/* onto the job files.
 * Replace it with the SDK's own support when that ships; the store stays.
 */
export function registerTasks(server: McpServer, deps: ServerDeps): void {
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID_V2]: {} } });
  const store = deps.runtime.jobs.store;

  server.server.setRequestHandler(
    'tasks/get',
    { params: GetTaskRequestV2Schema.shape.params },
    async ({ taskId }) => detailed(await mustFind(deps, taskId)),
  );

  server.server.setRequestHandler(
    'tasks/cancel',
    { params: CancelTaskRequestV2Schema.shape.params },
    async ({ taskId }) => {
      const job = await deps.runtime.jobs.cancel(taskId, deps.owner());
      if (!job) throw notFound(taskId);
      return detailed(job);
    },
  );

  // No job asks for input (keys never travel through tools), so an update just reports state.
  server.server.setRequestHandler(
    'tasks/update',
    { params: UpdateTaskRequestV2Schema.shape.params },
    async ({ taskId }) => detailed(await mustFind(deps, taskId)),
  );

  async function mustFind(d: ServerDeps, taskId: string): Promise<Job> {
    const job = /^j_[0-9a-z]{26}$/.test(taskId) ? await store.get(taskId, d.owner()) : undefined;
    if (!job) throw notFound(taskId);
    return job;
  }
}

function notFound(taskId: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
}

/** A task with its result (completed) or error (failed), per the 2026-07-28 Tasks schema. */
function detailed(job: Job) {
  return {
    ...toTask(job),
    resultType: 'complete',
    ...(job.status === 'completed' && job.result
      ? { result: { ...job.result, resultType: 'complete' } }
      : {}),
    ...(job.status === 'failed'
      ? { error: job.error ?? { code: -32603, message: 'Task failed' } }
      : {}),
  };
}
