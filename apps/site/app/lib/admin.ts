import 'server-only';
import type {
  AdminAccount,
  AdminAccountList,
  AdminAdjustment,
  AdminLedger,
  AdminSort,
} from '@cuttingfloor/schema';
import { server } from './files.ts';

// The admin pages' reads and the one write, on the hosted server's admin API (/admin/v1). The site
// calls it with its own account key and the signed-in person's WorkOS id; the server lets the call
// through only when its rights table makes that person an admin, the same check an admin key
// meets. Nothing here reaches the browser: the pages render on the server, and the adjustment
// form posts to /api/admin/adjust, which calls this.

export type { AdminAccount, AdminAccountList, AdminAdjustment, AdminLedger, AdminSort };

export type Answer<T> = { ok: true; body: T } | { ok: false; status: number; message: string };

async function call<T>(
  staff: string,
  path: string,
  init: { body?: unknown; timeout?: number } = {},
): Promise<Answer<T>> {
  const s = server();
  if (!s) return { ok: false, status: 503, message: 'CUTTINGFLOOR_ACCOUNT_KEY is not set' };
  try {
    const res = await fetch(`${s.base}/admin/v1${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${s.key}`,
        'x-cuttingfloor-admin': staff,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(init.timeout ?? 30_000),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        message: body.error?.message ?? `HTTP ${res.status}`,
      };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, status: 503, message: (error as Error).message };
  }
}

/**
 * Whether the signed-in person is staff: an admin in the server's rights table. Undefined when
 * the server can't say.
 */
export async function isStaff(userId: string): Promise<boolean | undefined> {
  const s = server();
  if (!s) return undefined;
  try {
    const res = await fetch(`${s.base}/account/admin-keys?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${s.key}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    return ((await res.json()) as { admin?: boolean }).admin === true;
  } catch {
    return undefined;
  }
}

export function listAccounts(
  staff: string,
  query: { q?: string; sort: AdminSort; page: number; limit?: number },
): Promise<Answer<AdminAccountList>> {
  const params = new URLSearchParams({
    limit: String(query.limit ?? 50),
    page: String(query.page),
    sort: query.sort,
    ...(query.q ? { q: query.q } : {}),
  });
  // Sorting by credits or exports reads every account the first time: give it longer.
  return call(staff, `/accounts?${params}`, { timeout: 60_000 });
}

export const getAccount = (staff: string, id: string) =>
  call<AdminAccount>(staff, `/accounts/${encodeURIComponent(id)}`);

export const getLedger = (staff: string, id: string) =>
  call<AdminLedger>(staff, `/accounts/${encodeURIComponent(id)}/ledger`);

export const adjustCredits = (
  staff: string,
  id: string,
  body: { id: string; credits: number; reason: string },
) => call<AdminAdjustment>(staff, `/accounts/${encodeURIComponent(id)}/adjustments`, { body });

/** The app names the server records, as people say them. */
export function clientLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('kazi')) return 'Kazi';
  if (n.includes('openai') || n.includes('chatgpt')) return 'ChatGPT';
  if (n.includes('claude')) return 'Claude';
  if (n.includes('cursor')) return 'Cursor';
  if (n.includes('codex')) return 'Codex';
  if (n.includes('gemini')) return 'Gemini';
  if (n === 'rest') return 'REST';
  return name;
}

/** Each client the account used, by name, most recent first; the first client when none yet. */
export function clients(a: AdminAccount): string[] {
  const names = a.apps.map((app) => clientLabel(app.name));
  if (!names.length && a.first_client) names.push(clientLabel(a.first_client));
  return [...new Set(names)];
}

/**
 * What cuttingfloor knows of the person in Kazi, from its own records: Kazi made the account, or
 * the account's calls came from Kazi. Kazi's own user list is not read.
 */
export function kaziFact(a: AdminAccount): string | null {
  if (a.made_by?.toLowerCase().includes('kazi')) return 'Made by Kazi';
  if (clients(a).includes('Kazi')) return 'Uses Kazi';
  return null;
}

/** Video exports that ran, since the account began (the meter). */
export const exportsOf = (a: AdminAccount) =>
  a.spend.find((s) => s.tool === 'export.video')?.jobs ?? 0;
