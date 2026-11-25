import { server } from './files.ts';

// One watermarked file, for its release page (the QR code on a review copy's cards): the site asks
// the server with its account key for the signed-in user, so only their own file is found.

export type Release = {
  file: string;
  name: string;
  watermarked: boolean;
  release_credits: number | null;
  credits_left: number | null;
  url: string;
  page_url: string;
  spent?: number;
};

export type Answer =
  | { ok: true; release: Release }
  | { ok: false; status: number; price?: number; credits_left?: number };

/** The file as the server sees it for this user; status 404 when it isn't theirs or has gone. */
export async function releaseOf(userId: string, file: string): Promise<Answer> {
  const s = server();
  if (!s) return { ok: false, status: 503 };
  const query = new URLSearchParams({ user: userId, file });
  return answer(() =>
    fetch(`${s.base}/account/release?${query}`, {
      headers: { authorization: `Bearer ${s.key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    }),
  );
}

/** Removes the file's watermark (its price, once); 402 with the price when credits are short. */
export async function release(userId: string, file: string): Promise<Answer> {
  const s = server();
  if (!s) return { ok: false, status: 503 };
  return answer(() =>
    fetch(`${s.base}/account/release`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user: userId, file }),
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    }),
  );
}

async function answer(call: () => Promise<Response>): Promise<Answer> {
  try {
    const res = await call();
    const body = (await res.json().catch(() => ({}))) as Release & {
      price?: number;
      credits_left?: number;
    };
    if (res.ok) return { ok: true, release: body };
    return {
      ok: false,
      status: res.status,
      ...(typeof body.price === 'number' ? { price: body.price } : {}),
      ...(typeof body.credits_left === 'number' ? { credits_left: body.credits_left } : {}),
    };
  } catch {
    return { ok: false, status: 503 };
  }
}

/** A link id the server can name: an export (`j_…`) or a media (`m_…`). */
export const FILE_ID = /^[jm]_[A-Za-z0-9_-]{1,80}$/;
