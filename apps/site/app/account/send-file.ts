// Sends one file to an upload link: as numbered parts, six at once, where the server takes them,
// else in order with PUT and Content-Range. Kept apart from the page so it can be tested against
// servers of any age: the site deploys before the server does, so a server that has no parts
// endpoints yet must still get the file.

/** Bytes per in-order PUT. */
export const PART = 16 * 1024 * 1024;

/** The server refused the file (too big, no room, link gone): sending again won't help. */
export class Final extends Error {}

export interface SendHooks {
  /** Bytes the server has. */
  sent(bytes: number): void;
  /** A passing state ('' clears it). */
  note(text: string): void;
  /** Requests in flight, which the page cuts off when it comes back from the background. */
  inFlight: Set<AbortController>;
  /** Tests: the wait before a retry. */
  pause?: (ms: number) => Promise<void>;
}

const wait = (hooks: SendHooks, ms: number) =>
  (hooks.pause ?? ((t) => new Promise<void>((r) => setTimeout(r, t))))(ms);

/** Where the upload stands, from HEAD on its link. */
export async function uploadOffset(url: string): Promise<{ at: number; complete: boolean }> {
  const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!r.ok) throw new Final('The upload link stopped working. Drop the file again.');
  return {
    at: Number(r.headers.get('upload-offset') || 0),
    complete: r.headers.get('upload-complete') === 'true',
  };
}

/**
 * Sends the file as numbered parts of one size, six at once; a part that drops is sent again
 * by itself, and a file begun earlier (a reload, another device) sends only what is missing.
 * False when the parts were not taken: the server takes a file whole, or predates parts (its
 * link check answers 403 for a path it does not know), or this upload was begun in order. The
 * caller then sends it with PUT, which says what is really wrong if anything is. Only a clear
 * "too big" ends it here.
 */
export async function sendParts(file: Blob, url: string, hooks: SendHooks): Promise<boolean> {
  const u = new URL(url);
  const sub = (more: string, query = '') => `${u.origin}${u.pathname}${more}${u.search}${query}`;
  const begun = await fetch(sub('/parts', `&bytes=${file.size}`), { cache: 'no-store' }).catch(
    () => undefined,
  );
  if (!begun) return false;
  const plan = (await begun.json().catch(() => ({}))) as {
    part_bytes?: number;
    parts?: Array<{ part: number; bytes: number }>;
    complete?: boolean;
    error?: string;
  };
  if (begun.status === 413) throw new Final(plan.error || 'The server refused the file.');
  if (!begun.ok || !plan.part_bytes) return false;
  if (plan.complete) return true;
  const size = plan.part_bytes;
  const count = Math.max(1, Math.ceil(file.size / size));
  const have = new Set((plan.parts ?? []).map((p) => p.part));
  const todo: number[] = [];
  for (let n = 1; n <= count; n++) if (!have.has(n)) todo.push(n);
  let done = (plan.parts ?? []).reduce((sum, p) => sum + p.bytes, 0);
  hooks.sent(done);
  hooks.note('');
  const one = async (n: number) => {
    const body = file.slice((n - 1) * size, Math.min(n * size, file.size));
    for (let tries = 0; ; ) {
      const cut = new AbortController();
      hooks.inFlight.add(cut);
      try {
        const r = await fetch(sub(`/parts/${n}`), { method: 'PUT', body, signal: cut.signal });
        if (r.status === 413 || r.status === 403 || r.status === 404) {
          throw new Final('The upload link stopped working. Drop the file again.');
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        done += body.size;
        hooks.sent(done);
        hooks.note('');
        return;
      } catch (error) {
        // A part cut off because the page came back from the background is not a failure.
        if (error instanceof Final || (!cut.signal.aborted && ++tries > 5)) throw error;
        hooks.note('Connection dropped; sending that part again…');
        if (!cut.signal.aborted) await wait(hooks, 1000 * tries);
      } finally {
        hooks.inFlight.delete(cut);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(6, todo.length) }, async () => {
      for (let n = todo.shift(); n !== undefined; n = todo.shift()) await one(n);
    }),
  );
  for (let tries = 0; ; ) {
    const r = await fetch(sub('/complete'), { method: 'POST' });
    if (r.ok) return true;
    const reply = (await r.json().catch(() => ({}))) as { missing?: number[]; error?: string };
    if (r.status === 403 || r.status === 404) {
      throw new Final('The upload link stopped working. Drop the file again.');
    }
    if (++tries > 3) throw new Error(reply.error || `HTTP ${r.status}`);
    // Parts the server does not have after all are sent again.
    if (r.status === 409 && reply.missing?.length) for (const n of reply.missing) await one(n);
    else await wait(hooks, 1000 * tries);
  }
}

/**
 * Sends the file to the upload link from where it stands (`from`): in parts where the server
 * takes them, else in order with Content-Range, picking up where a dropped part stopped.
 */
export async function sendFile(
  file: Blob,
  url: string,
  hooks: SendHooks,
  from: { at: number; complete: boolean } = { at: 0, complete: false },
): Promise<void> {
  let { at, complete } = from;
  if (!complete && (await sendParts(file, url, hooks))) complete = true;
  for (let tries = 0; !complete; ) {
    const end = Math.min(at + PART, file.size);
    hooks.sent(at);
    hooks.note('');
    const cut = new AbortController();
    hooks.inFlight.add(cut);
    try {
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${at}-${end - 1}/${file.size}` },
        body: file.slice(at, end),
        signal: cut.signal,
      });
      const reply = (await r.json().catch(() => ({}))) as { error?: string };
      if (r.status === 413 || r.status === 403 || r.status === 404)
        throw new Final(reply.error || 'The server refused the file.');
      if (!r.ok && r.status !== 409) throw new Error(reply.error || `HTTP ${r.status}`);
      const next = Number(r.headers.get('upload-offset') || end);
      // "Send from N" with the N we just sent from moves nothing on (an upload begun in parts
      // refuses bytes in order): a try used up, so it ends after a few instead of going round.
      if (r.status === 409 && next === at) {
        throw new Error(reply.error || 'The server did not take this part of the file.');
      }
      at = next;
      complete = r.headers.get('upload-complete') === 'true';
      tries = 0;
    } catch (error) {
      // A part cut off because the page came back from the background is not a failure.
      if (error instanceof Final || (!cut.signal.aborted && ++tries > 5)) throw error;
      hooks.note('Connection dropped; picking up where it stopped…');
      if (!cut.signal.aborted) await wait(hooks, 1000 * tries);
      ({ at, complete } = await uploadOffset(url));
    } finally {
      hooks.inFlight.delete(cut);
    }
  }
}
