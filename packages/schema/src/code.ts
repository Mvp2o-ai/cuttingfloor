import * as z from 'zod/v4';
import type { ToolError } from './errors.ts';

// code.run: what the main server sends the sandbox worker, and the events it streams back. The
// script never reaches the main server: its tool calls and file requests travel back up this
// stream, and the main server answers them as the job's owner.

export const CODE_LIMITS = {
  maxScriptBytes: 256 * 1024,
  defaultTimeoutSeconds: 300,
  maxTimeoutSeconds: 1800,
  maxInputs: 32,
  maxOutputs: 32,
  /** Bytes of stdout and of stderr kept for the result. */
  logTail: 16 * 1024,
} as const;

export const CodeLanguage = z.enum(['node', 'python', 'bash']);
export type CodeLanguage = z.infer<typeof CodeLanguage>;

/** Tools a script can't call: they would start sandbox work inside the sandbox. */
export const CODE_DENIED_TOOLS = ['code.run', 'create.motion', 'create.still'] as const;

export const CodeInputRef = z.union([
  z.object({ media_id: z.string() }),
  z.object({ timeline_id: z.string() }),
]);

export const CodeRequest = z.object({
  language: CodeLanguage,
  script: z.string().min(1).max(CODE_LIMITS.maxScriptBytes),
  timeout_seconds: z.int().min(1).max(CODE_LIMITS.maxTimeoutSeconds),
  /** Fetched into in/ before the script starts. */
  inputs: z.array(CodeInputRef).max(CODE_LIMITS.maxInputs),
});
export type CodeRequest = z.infer<typeof CodeRequest>;

export interface CodeOutput {
  name: string;
  bytes: number;
}

export interface CodeDone {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outputs: CodeOutput[];
  seconds: number;
}

/** One NDJSON line of the worker's answer to POST /run. */
export type CodeEvent =
  /** First line: the job's id and the secret its replies and downloads must carry. */
  | { job: { id: string; secret: string } }
  | { progress: number; message: string }
  /** The script calls a tool; answer with POST /jobs/{id}/reply/{rid}. */
  | { call: { rid: string; tool: string; args: Record<string, unknown> } }
  /** The script wants a file; answer with PUT /jobs/{id}/files/{rid} (or a reply with an error). */
  | { file: { rid: string; media_id?: string; timeline_id?: string } }
  /** The script imports a file from its folder now; fetch it from GET /jobs/{id}/upload/{rid}. */
  | { upload: { rid: string; name: string; bytes: number } }
  | { done: CodeDone }
  | { error: ToolError };

/**
 * The main server's answer to a call or file request. `extend_ms`: time the script's calls spent
 * queued behind other work, added to its time limit (queue time doesn't count against it).
 */
export type CodeReply = ({ result: unknown } | { error: ToolError }) & { extend_ms?: number };
