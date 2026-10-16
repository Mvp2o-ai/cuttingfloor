import { CfError, type ErrorCode, type ToolError } from '@cuttingfloor/schema';
import type { ToolInputs, ToolName, ToolOutputs } from './tools.generated.ts';

// The SDK: every tool as cf.domain.verb(args). One implementation stays on the server; this is
// a thin typed client over whatever carries tool calls (the sandbox socket in code.run, or any
// function that calls a tool and returns its MCP result). Long-running tools are followed to the
// end through job.get, so cf.media.import(...) resolves with the imported media.

/** A tool result as MCP returns it. */
export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

/** Calls one tool and returns its MCP result. */
export type Transport = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

type DomainOf<T> = T extends `${infer D}.${string}` ? D : never;
type Domain = DomainOf<ToolName>;
type Fn<T extends ToolName> = object extends ToolInputs[T]
  ? (args?: ToolInputs[T]) => Promise<ToolOutputs[T]>
  : (args: ToolInputs[T]) => Promise<ToolOutputs[T]>;

/** cf.domain.verb(args) for every tool, plus call() by name and raw() for the whole result. */
export type Cf = {
  [D in Domain]: { [T in ToolName as T extends `${D}.${infer V}` ? V : never]: Fn<T> };
} & {
  call<T extends ToolName>(tool: T, args?: ToolInputs[T]): Promise<ToolOutputs[T]>;
  /** The tool's whole MCP result (images included), without following jobs. */
  raw(tool: ToolName, args?: Record<string, unknown>): Promise<ToolResult>;
};

export interface ClientOptions {
  /** How often to poll job.get while a long-running tool works. Default 500 ms. */
  pollMs?: number;
}

const toError = (e: Partial<ToolError> | undefined, fallback: string): CfError =>
  new CfError((e?.code ?? 'engine_error') as ErrorCode, e?.message ?? fallback, {
    ...(e?.hint ? { hint: e.hint } : {}),
    ...(e?.detail ? { detail: e.detail } : {}),
  });

function structured(tool: string, result: ToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  // Errors without structured content are the protocol's own (arguments that fail the schema).
  if (result.isError) return { code: 'bad_request', message: text ?? `${tool} failed` };
  if (text) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { text };
    }
  }
  return {};
}

export function createClient(transport: Transport, options: ClientOptions = {}): Cf {
  const pollMs = options.pollMs ?? 500;

  async function call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await transport(tool, args);
    const body = structured(tool, result);
    if (result.isError) throw toError(body as Partial<ToolError>, `${tool} failed`);
    // A long-running tool answered with a job: follow it.
    if (typeof body.job_id === 'string' && body.status === 'working' && tool !== 'job.get') {
      for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        const view = await call('job.get', { job_id: body.job_id });
        const job = view as { status: string; result?: unknown; error?: Partial<ToolError> };
        if (job.status === 'working') continue;
        if (job.status === 'completed' && !job.error) return job.result ?? {};
        throw toError(job.error, `${tool} ${job.status}`);
      }
    }
    return body;
  }

  const domains = new Map<string, object>();
  return new Proxy({} as Cf, {
    get(_, key) {
      if (key === 'call') return call;
      if (key === 'raw')
        return (tool: string, args: Record<string, unknown> = {}) => transport(tool, args);
      if (typeof key !== 'string' || key === 'then') return undefined;
      let domain = domains.get(key);
      if (!domain) {
        domain = new Proxy(
          {},
          {
            get: (__, verb) =>
              typeof verb === 'string' && verb !== 'then'
                ? (args?: Record<string, unknown>) => call(`${key}.${verb}`, args)
                : undefined,
          },
        );
        domains.set(key, domain);
      }
      return domain;
    },
  });
}
