// The account's files on the hosted server: what the drop zone on the account page shows and
// sends. The site asks with its account key for the signed-in user; the browser then sends each
// file straight to the server's signed upload URL, so no file passes through the site.

export type Files = {
  media: Array<{
    media_id: string;
    name: string;
    status: string;
    kind: string | null;
    from: 'upload' | 'url' | 'path' | 'render' | 'created';
    bytes: number | null;
    expires_at: string;
  }>;
  media_count: number;
  uploads: Array<{
    upload_id: string;
    name: string;
    received_bytes: number;
    bytes: number | null;
    complete: boolean;
    expires_at: string;
  }>;
  upload_count: number;
  storage: { used_bytes: number; max_bytes: number | null };
};

export type Started = { upload_id: string; url: string; expires_at: string; max_bytes: number };

export function server(): { key: string; base: string } | undefined {
  const key = process.env.CUTTINGFLOOR_ACCOUNT_KEY;
  if (!key) return undefined;
  return { key, base: process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai' };
}

/** The user's files and storage; undefined when the server can't say or the account is closed. */
export async function filesOf(userId: string): Promise<Files | undefined> {
  const s = server();
  if (!s) return undefined;
  try {
    const res = await fetch(`${s.base}/account/media?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${s.key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Files & { allowed: boolean };
    return body.allowed ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Starts an upload for the user: the server's answer as it is, with its status. */
export async function startUpload(
  userId: string,
  name: string,
  bytes: number,
): Promise<{ status: number; body: Started | { error: string; hint?: string } }> {
  const s = server();
  if (!s) return { status: 503, body: { error: 'Uploads are not available just now' } };
  try {
    const res = await fetch(`${s.base}/account/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ user: userId, name, bytes }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: 503, body: { error: 'The server could not be reached; try again' } };
  }
}
