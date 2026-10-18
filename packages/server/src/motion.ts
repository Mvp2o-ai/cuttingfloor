import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CfError, type MotionEvent, type MotionRequest, serverBusy } from '@cuttingfloor/schema';

// The main server's side of the motion sandbox: send a render to the worker, follow its progress,
// then fetch the file. The worker never sees the data volume; bytes come back over HTTP.

export async function renderInSandbox(
  base: string | null,
  request: MotionRequest,
  dest: string,
  progress: (fraction: number, message: string) => void,
  signal: AbortSignal,
): Promise<{ type: string }> {
  if (!base) {
    throw new CfError('engine_error', 'No motion sandbox is configured on this server', {
      hint: 'Run the motion service (docker compose up, which starts it) and set CUTTINGFLOOR_MOTION_URL; create.matte needs no sandbox',
    });
  }
  let res: Response;
  try {
    res = await fetch(`${base}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    throw serverBusy(
      `The motion sandbox is not reachable (${(error as Error).message}); it may be restarting`,
      'check the motion service is running (docker compose ps)',
    );
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: MotionEvent & object };
    throw sandboxError(
      (body.error as never) ?? {
        code: 'engine_error',
        message: `Motion sandbox: HTTP ${res.status}`,
      },
    );
  }
  let done: Extract<MotionEvent, { done: unknown }>['done'] | undefined;
  let pending = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as MotionEvent;
        if ('progress' in event) progress(event.progress, event.message);
        else if ('done' in event) done = event.done;
        else throw sandboxError(event.error);
      }
    }
  } catch (error) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    if (error instanceof CfError) throw error;
    // The connection broke mid-render ("terminated"): the sandbox restarted, most often because
    // it ran out of memory.
    throw serverBusy(`The motion sandbox stopped mid-render (${(error as Error).message})`);
  }
  if (!done) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    throw serverBusy('The motion sandbox stopped without an answer; it may have restarted');
  }
  try {
    const file = await fetch(`${base}/jobs/${done.id}`, { signal });
    if (!file.ok || !file.body) throw new Error(`HTTP ${file.status}`);
    await pipeline(Readable.fromWeb(file.body as never), createWriteStream(dest));
  } catch (error) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    throw serverBusy(
      `Could not fetch the render from the motion sandbox (${(error as Error).message}); it may have restarted`,
    );
  }
  return { type: done.type };
}

function sandboxError(e: {
  code: string;
  message: string;
  hint?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}): CfError {
  return new CfError(e.code as CfError['code'], e.message, {
    ...(e.hint ? { hint: e.hint } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
  });
}
