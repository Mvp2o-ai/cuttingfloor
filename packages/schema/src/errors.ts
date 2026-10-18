import * as z from 'zod/v4';

/** Domain error codes returned as tool execution errors (`isError: true`). */
export const ErrorCode = z.enum([
  'bad_request',
  'not_found',
  'expired',
  'media_not_ready',
  'media_offline',
  'engine_error',
  'render_failed',
  'code_failed',
  'interrupted',
  'cancelled',
  'credential_required',
  'credential_invalid',
  'output_exists',
  'path_not_allowed',
  'limit_exceeded',
  'quota_exceeded',
  'subscription_required',
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
