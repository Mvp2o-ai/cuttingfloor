import * as z from 'zod/v4';

/** Domain error codes returned as tool execution errors (`isError: true`). */
export const ErrorCode = z.enum([
  'bad_request',
  'no_audio',
  'not_found',
  'expired',
  'media_not_ready',
  'media_offline',
  'engine_error',
  'render_failed',
  'interrupted',
  'stalled',
  'cancelled',
  'credential_required',
  'credential_invalid',
  'output_exists',
  'path_not_allowed',
  'limit_exceeded',
  'quota_exceeded',
  'subscription_required',
  'email_unverified',
  'service_unavailable',
  'server_busy',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ToolError = z.object({
  code: ErrorCode,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
  /** Always actionable: nearest valid ids, the allowed values, the next call to make. */
  hint: z.string().optional(),
});
export type ToolError = z.infer<typeof ToolError>;

/** A typed domain error. Tool handlers turn it into `isError: true` plus `structuredContent`. */
export class CfError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'CfError';
    this.code = code;
    this.hint = options.hint;
    this.detail = options.detail;
  }

  toJSON(): ToolError {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

/**
 * The server has no room for this work right now (memory, processes, the sandbox restarting): a
 * retryable error. Locally (CUTTINGFLOOR_MODE is not hosted) the hint also says what to change.
 */
export function serverBusy(message: string, local?: string): CfError {
  const hosted = process.env.CUTTINGFLOOR_MODE === 'hosted';
  return new CfError('server_busy', message, {
    hint: `The server is busy with other work; call the tool again in about a minute (with the same idempotency_key it starts a fresh job)${!hosted && local ? `. If it keeps happening: ${local}` : ''}`,
    detail: { retry: true, retry_after_seconds: 60 },
  });
}

/**
 * A media a tool needs is not there yet: still importing or processing (edits and render.frames
 * take it once it is processing), or failed. `needs` names what reads it; `job` is the
 * media.import or create.* job making it, which the hint names so the caller can wait on it.
 * With `needs` null, the caller only needs it probed (status processing).
 */
export function mediaNotReady(
  id: string,
  status: string,
  needs: string | null,
  job?: { tool: string; job_id?: string | undefined },
): CfError {
  if (status === 'failed') {
    return new CfError('bad_request', `Media ${id} failed to import`, {
      hint: 'media.get shows why; import the file again',
      detail: { media_id: id, status },
    });
  }
  const importing = status === 'importing';
  const maker = job
    ? job.job_id
      ? `${job.tool} job ${job.job_id}`
      : `its ${job.tool} job`
    : 'the media.import or create.* job making it';
  const state = importing
    ? job && job.tool !== 'media.import'
      ? 'is still being made'
      : 'is still importing'
    : 'is still processing';
  const wait = needs === null ? 'reports processing or ready' : 'completes';
  return new CfError(
    'media_not_ready',
    `Media ${id} ${state} (${maker})${needs === null ? '' : `; ${needs} needs it ready`}`,
    {
      hint: `${importing ? 'Edits and render.frames take it once it is processing' : 'Edits and render.frames take it already'}. Wait until ${maker} ${wait}${job?.job_id ? ` (job.get {job_id: "${job.job_id}"})` : ' (media.get says its status)'}, then call again`,
      detail: {
        media_id: id,
        status,
        ...(job ? { tool: job.tool } : {}),
        ...(job?.job_id ? { job_id: job.job_id } : {}),
      },
    },
  );
}
