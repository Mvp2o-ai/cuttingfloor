import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { CfError, type ErrorCode, SoundShareInput } from '@cuttingfloor/schema';
import type { Runtime } from '@cuttingfloor/server';

// Sharing sounds in the community pack over HTTP (sound-share.ts): from the upload box and the
// upload page (POST <upload link>/share), from the site for its signed-in user (lifecycle.ts),
// and reports from anyone (POST /sounds/<sound_id>/report).

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}

const STATUS: Partial<Record<ErrorCode, number>> = {
  bad_request: 400,
  not_found: 404,
  media_not_ready: 409,
  limit_exceeded: 429,
  service_unavailable: 503,
};

/** A refusal as these routes answer it. */
export function refusal(error: unknown): Answer {
  if (!(error instanceof CfError)) {
    process.stderr.write(`sounds: ${(error as Error).message}\n`);
    return { status: 500, body: { error: 'The sound could not be shared just now; try again' } };
  }
  return {
    status: STATUS[error.code] ?? 400,
    body: { error: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}) },
  };
}

/** Reads a JSON body of at most `limit` bytes; undefined when it isn't JSON. */
export async function jsonBody(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Shares the owner's sent file or media with the details in `body`. */
export async function share(
  runtime: Runtime,
  owner: string,
  from: { upload_id: string } | { media_id: string },
  body: unknown,
  signal: AbortSignal,
): Promise<Answer> {
  const meta = SoundShareInput.safeParse(body ?? {});
  if (!meta.success) {
    return {
      status: 400,
      body: {
        error: `The sound's details: ${meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        code: 'bad_request',
      },
    };
  }
  try {
    return {
      status: 200,
      body: { sound: await runtime.shareSound(owner, from, meta.data, signal) },
    };
  } catch (error) {
    return refusal(error);
  }
}

/** Who reported, without keeping where they are: a hash of the address the request came from. */
export function reporter(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
    req.socket.remoteAddress ||
    'unknown';
  return `ip_${createHash('sha256').update(`cuttingfloor-sound-report:${ip}`).digest('hex').slice(0, 24)}`;
}

/** A report on a shared sound: {reason}. */
export async function report(
  runtime: Runtime,
  req: IncomingMessage,
  soundId: string,
): Promise<Answer> {
  if (!runtime.sharing)
    return { status: 503, body: { error: 'Reports are taken on cuttingfloor.ai' } };
  const body = (await jsonBody(req, 4096)) as { reason?: unknown } | undefined;
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return { status: 400, body: { error: 'Say why: reason' } };
  try {
    const done = await runtime.sharing.report(soundId, reporter(req), reason);
    if (!done.reported) return { status: 404, body: { error: 'No shared sound has that id' } };
    return { status: 200, body: { reported: true } };
  } catch (error) {
    return refusal(error);
  }
}
