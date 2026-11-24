import { server } from './files.ts';

// Community sounds: the community pack of the sound library on the hosted server. Anyone
// reads it (GET /sounds, public); a signed-in user shares their own files into it and takes
// their sounds down through the site, which asks with its account key.

export type Sound = {
  sound_id: string;
  name: string;
  description: string;
  tags: string[];
  category: string;
  pack: string;
  seconds: number;
  url: string;
  author: string | null;
  uses?: number;
  added_at?: string;
};

export type SoundPage = {
  sounds: Sound[];
  next_offset: number | null;
  total: number | null;
  categories: Array<{ category: string; sounds: number }>;
  note?: string;
};

export type ShareDetails = {
  name: string;
  description: string;
  category: string;
  tags: string[];
  author?: string;
};

/** The pack of shared sounds. */
export const COMMUNITY_PACK = 'community';

/** Categories a shared sound is offered beyond the library's own. */
export const SHARE_CATEGORIES = ['Trending sounds', 'Music', 'Meme and hype', 'Voice and quotes'];

export function soundsBase(): string {
  return process.env.CUTTINGFLOOR_SERVER_URL ?? 'https://api.cuttingfloor.ai';
}

/** A page of community sounds, for the first render; undefined when the server can't say. */
export async function communityPage(
  order: 'popular' | 'newest',
  query?: string,
): Promise<SoundPage | undefined> {
  const q = new URLSearchParams({ pack: COMMUNITY_PACK, limit: '30' });
  if (query) q.set('query', query);
  else q.set('order', order);
  try {
    const res = await fetch(`${soundsBase()}/sounds?${q}`, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? ((await res.json()) as SoundPage) : undefined;
  } catch {
    return undefined;
  }
}

/** One call to the server's /account/sounds for the user: its answer as it is, with its status. */
export async function accountSounds(
  path: '' | '/remove',
  init: { method: 'GET'; user: string } | { method: 'POST'; body: Record<string, unknown> },
): Promise<{ status: number; body: unknown }> {
  const s = server();
  if (!s) return { status: 503, body: { error: 'Sharing is not available just now' } };
  try {
    const res =
      init.method === 'GET'
        ? await fetch(`${s.base}/account/sounds?user=${encodeURIComponent(init.user)}`, {
            headers: { authorization: `Bearer ${s.key}` },
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
          })
        : await fetch(`${s.base}/account/sounds${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' },
            body: JSON.stringify(init.body),
            cache: 'no-store',
            // Sharing measures and embeds the sound: a few seconds.
            signal: AbortSignal.timeout(120_000),
          });
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: 503, body: { error: 'The server could not be reached; try again' } };
  }
}
