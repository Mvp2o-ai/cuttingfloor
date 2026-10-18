import { join } from 'node:path';
import type { Workspace } from '@cuttingfloor/core';
import { CfError } from '@cuttingfloor/schema';

// Per-owner daily counts of paid work done on the server's own keys (hosted look frames). Each
// job writes its own file under the owner's day, and the day's count is their sum, so jobs ending
// together on any server never lose a count. The check before a job is soft: servers can each
// admit a call at the same moment, so a cap can be passed by up to one call per server.

const day = () => new Date().toISOString().slice(0, 10);
const dir = (ws: Workspace, owner: string, what: string) =>
  ws.ownerDir(owner, 'usage', `${what}-${day()}`);

export async function usedToday(ws: Workspace, owner: string, what: string): Promise<number> {
  let used = 0;
  for (const name of await ws.list(dir(ws, owner, what))) {
    used += (await ws.readJson<{ count: number }>(join(dir(ws, owner, what), name)))?.count ?? 0;
  }
  return used;
}

/** Refuses work that would take an owner past a daily limit. */
export async function checkQuota(
  ws: Workspace,
  owner: string,
  what: string,
  adding: number,
  limit: number | undefined,
): Promise<void> {
  if (limit === undefined) return;
  const used = await usedToday(ws, owner, what);
  if (used + adding <= limit) return;
  throw new CfError(
    'quota_exceeded',
    `That is ${adding} ${what} frames; ${used} of today's ${limit} are used`,
    {
      detail: { limit, used, resets: `${day()}T24:00:00Z` },
      hint: `Sample fewer frames (a larger every_seconds, or at_seconds around the moments you need), or wait for the reset at midnight UTC. ${Math.max(0, limit - used)} are left today`,
    },
  );
}

/** Records one job's count. */
export async function addUsage(
  ws: Workspace,
  owner: string,
  what: string,
  jobId: string,
  n: number,
): Promise<void> {
  await ws.writeJson(
    join(dir(ws, owner, what), `${jobId}.json`),
    { count: n },
    { exclusive: true },
  );
}
