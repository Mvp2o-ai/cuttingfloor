import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CfError,
  type CodeDone,
  type CodeEvent,
  type CodeReply,
  type CodeRequest,
  type ToolError,
} from '@cuttingfloor/schema';

// The main server's side of code.run: start the script in the sandbox, answer its tool calls and
// file requests as they stream up (as the job's owner), then fetch what it wrote to out/. The
// sandbox never connects to this server; everything travels over requests this side makes.

export interface CodeHandlers {
  /** A tool call from the script: the MCP result. */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** A file the script asked for: a path on disk or bytes, and the name to give it. */
  file(ref: { media_id?: string; timeline_id?: string }): Promise<{
    name: string;
    path?: string;
    data?: Buffer;
  }>;
  /** Where to put an out/ file the script wrote. */
  output(name: string): Promise<string>;
  /** Where to put a file the script imports while it runs. */
  scratch(name: string): Promise<string>;
  /** A file the script imports while it runs, fetched to `scratch(name)`: the media it became. */
  upload(name: string, path: string): Promise<unknown>;
}

export interface CodeRun extends CodeDone {
  /**
   * out/ files: fetched to the paths `output` gave, or the reason one could not be fetched (the
   * others are still there).
   */
  files: Array<{ name: string; path: string } | { name: string; error: ToolError }>;
}

const errorOf = (error: unknown): ToolError =>
  error instanceof CfError
    ? error.toJSON()
    : { code: 'engine_error', message: (error as Error).message ?? String(error) };

export async function runCodeInSandbox(
  base: string | null,
  request: CodeRequest,
  handlers: CodeHandlers,
  progress: (fraction: number, message: string) => void,
  signal: AbortSignal,
): Promise<CodeRun> {
  if (!base) {
    throw new CfError('engine_error', 'No sandbox is configured on this server', {
      hint: 'Run the motion service (docker compose up starts it) and set CUTTINGFLOOR_MOTION_URL',
    });
  }
  let res: Response;
  try {
    res = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    throw new CfError('engine_error', `The sandbox is not reachable: ${(error as Error).message}`, {
      hint: 'Check the motion service is running (docker compose ps)',
    });
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: ToolError };
    throw fromWire(body.error ?? { code: 'engine_error', message: `Sandbox: HTTP ${res.status}` });
  }

  let job: { id: string; secret: string } | undefined;
  const headers = () => ({ 'x-cf-secret': job?.secret ?? '' });
  const url = (path: string) => `${base}/jobs/${job?.id}${path}`;
  const reply = async (rid: string, body: CodeReply) => {
    await fetch(url(`/reply/${rid}`), {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  };
  const answer = async (event: CodeEvent) => {
    if ('call' in event) {
      const { rid, tool, args } = event.call;
      let body: CodeReply;
      try {
        body = { result: await handlers.call(tool, args) };
      } catch (error) {
        body = { error: errorOf(error) };
      }
      await reply(rid, body);
    } else if ('upload' in event) {
      const { rid, name } = event.upload;
      let body: CodeReply;
      try {
        const r = await fetch(url(`/upload/${rid}`), { headers: headers(), signal });
        if (!r.ok || !r.body) throw new CfError('engine_error', `Could not fetch ${name}`);
        const dest = await handlers.scratch(`upload-${rid}-${name}`);
        await pipeline(Readable.fromWeb(r.body as never), createWriteStream(dest));
        body = { result: await handlers.upload(name, dest) };
      } catch (error) {
        body = { error: errorOf(error) };
      }
      await reply(rid, body);
    } else if ('file' in event) {
      const { rid, ...ref } = event.file;
      try {
        const f = await handlers.file(ref);
        const size = f.data ? f.data.length : (await stat(f.path as string)).size;
        const put = await fetch(url(`/files/${rid}`), {
          method: 'PUT',
          headers: {
            ...headers(),
            'x-cf-name': f.name,
            'content-type': 'application/octet-stream',
            'content-length': String(size),
          },
          body: f.data ?? (Readable.toWeb(createReadStream(f.path as string)) as never),
          duplex: 'half',
          signal,
        } as RequestInit);
        if (!put.ok)
          throw new CfError('engine_error', `Sandbox refused the file: HTTP ${put.status}`);
      } catch (error) {
        await reply(rid, { error: errorOf(error) });
      }
    }
  };

  let done: CodeDone | undefined;
  const answering = new Set<Promise<void>>();
  let pending = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as CodeEvent;
        if ('job' in event) job = event.job;
        else if ('progress' in event) progress(event.progress, event.message);
        else if ('done' in event) done = event.done;
        else if ('error' in event) throw fromWire(event.error);
        else {
          // Answered alongside the stream: a script may wait on several at once.
          const p = answer(event).catch(() => undefined);
          answering.add(p);
          void p.finally(() => answering.delete(p));
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    throw error;
  }
  await Promise.all(answering);
  if (!done || !job) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    throw new CfError('engine_error', 'The sandbox stopped without an answer', {
      hint: 'It may have restarted mid-run; try again',
    });
  }
  try {
    const files: CodeRun['files'] = [];
    if (done.exit_code === 0) {
      for (const o of done.outputs) {
        // One file that can't be fetched is that file's failure, not the run's.
        try {
          const r = await fetch(url(`/out/${encodeURIComponent(o.name)}`), {
            headers: headers(),
            signal,
          });
          if (!r.ok || !r.body) {
            throw new CfError(
              'engine_error',
              `Could not fetch out/${o.name} from the sandbox: HTTP ${r.status}${r.status === 404 ? ' (the sandbox no longer has it)' : ''}`,
              { hint: 'Run the script again to make this file; the other outputs were kept' },
            );
          }
          const dest = await handlers.output(o.name);
          await pipeline(Readable.fromWeb(r.body as never), createWriteStream(dest));
          files.push({ name: o.name, path: dest });
        } catch (error) {
          if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
          const e = errorOf(error);
          files.push({
            name: o.name,
            error:
              error instanceof CfError
                ? e
                : {
                    ...e,
                    message: `Could not fetch out/${o.name} from the sandbox: ${e.message}`,
                    hint: 'Run the script again to make this file; the other outputs were kept',
                  },
          });
        }
      }
    }
    return { ...done, files };
  } finally {
    await fetch(url(''), { method: 'DELETE', headers: headers() }).catch(() => undefined);
  }
}

function fromWire(e: ToolError): CfError {
  return new CfError(e.code, e.message, {
    ...(e.hint ? { hint: e.hint } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
  });
}
