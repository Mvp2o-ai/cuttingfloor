import * as z from 'zod/v4';

/** Domain error codes returned as tool execution errors (`isError: true`). */
export const ErrorCode = z.enum([
  'bad_request',
  'not_found',
  'invalid_filter',
  'revision_conflict',
  'media_not_ready',
  'media_offline',
  'engine_error',
  'render_failed',
  'interrupted',
  'credential_required',
  'credential_invalid',
  'qa_unavailable',
  'output_exists',
  'path_not_allowed',
  'limit_exceeded',
  'quota_exceeded',
  'sync_conflict',
  'schema_migration_failed',
  'not_implemented',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ToolError = z.object({
  code: ErrorCode,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
  /** Always actionable: nearest valid ids, the current head, the setup step for a missing key. */
  hint: z.string().optional(),
});
export type ToolError = z.infer<typeof ToolError>;
