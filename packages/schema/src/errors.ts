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
 * A media a tool needs ready is not: still importing or processing (edits and render.frames
 * take it already), or failed. `needs` names the tool that reads the finished file.
 */
export function mediaNotReady(id: string, status: string, needs: string): CfError {
  if (status === 'failed') {
    return new CfError('bad_request', `Media ${id} failed to import`, {
      hint: 'media.get shows why; import the file again',
      detail: { media_id: id, status },
    });
  }
  return new CfError(
    'media_not_ready',
    `Media ${id} is still ${status === 'importing' ? 'importing' : 'processing'}; ${needs} needs it ready`,
    {
      hint: 'Edits and render.frames take it already. Call again once media.get says ready (when the media.import or create.* job making it completes)',
      detail: { media_id: id, status },
    },
  );
}
