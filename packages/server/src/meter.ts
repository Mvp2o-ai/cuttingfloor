import { defineCollection, type Workspace } from '@cuttingfloor/core';
import type { Job, StartOptions } from '@cuttingfloor/jobs';
import { JUDGMENTS_PER_CREDIT } from '@cuttingfloor/plans';
import type { CfError } from '@cuttingfloor/schema';

// Render time: how long each job ran, from leaving the queue to its end, and the judgments a call
// asked of Jev (billed at JUDGMENTS_PER_CREDIT, as seconds of a credit's minute). One file per job
// or judging call under the owner's month (`owners/{owner}/meter/{yyyy-mm}/{job_id}.json`), so jobs ending together on
// any server never lose a count, and a month is its files' sum. Kept 5 years: bought credits never
// expire, so what used them is counted against them for as long as an account plausibly lasts.

export const METER_TTL_MS = 5 * 366 * 24 * 3_600_000;

/** One entry per job or judging call, grouped by the month it ended (`yyyy-mm`). */
export const METER = defineCollection<MeterEntry>({
  name: 'meter',
  scope: 'owner',
  fs: { dir: (month) => `meter/${month}` },
});

export interface MeterEntry {
  job_id: string;
  tool: string;
  started_at: string;
  ended_at: string;
  /** How long it ran. */
  seconds: number;
  /** Judgments asked of Jev, billed on top of the running time. */
  judgments?: number;
}

/** What an entry costs, as seconds of a credit's minute: its running time plus its judgments. */
export function billedSeconds(entry: MeterEntry): number {
  return entry.seconds + ((entry.judgments ?? 0) * 60) / JUDGMENTS_PER_CREDIT;
}

/** Records judgments asked of Jev, under an id of their own (a judging job's id plus `-judgments`). */
export async function meterJudgments(
  ws: Workspace,
  owner: string,
  id: string,
  tool: string,
  judgments: number,
): Promise<MeterEntry> {
  const now = new Date().toISOString();
  const entry: MeterEntry = {
    job_id: id,
    tool,
    started_at: now,
    ended_at: now,
    seconds: 0,
    judgments,
  };
  await ws.records.collection(METER, { owner, parent: month(now) }).insertOnce(id, entry);
  return entry;
}

const month = (iso: string) => iso.slice(0, 7);

/** Records a job's running time once it ends; jobs that never started a run record nothing. */
export async function meterJob(ws: Workspace, job: Job): Promise<MeterEntry | undefined> {
  if (!job.startedAt || job.status === 'working') return undefined;
  // The server's own work for the account, such as importing the onboarding sample, is free.
  if (job.meta?.unbilled) return undefined;
  const ms = Date.parse(job.lastUpdatedAt) - Date.parse(job.startedAt);
  if (!(ms > 0)) return undefined;
  const entry: MeterEntry = {
    job_id: job.id,
    tool: job.tool,
    started_at: job.startedAt,
    ended_at: job.lastUpdatedAt,
    seconds: Math.round(ms) / 1000,
  };
  await ws.records
    .collection(METER, { owner: job.owner, parent: month(job.lastUpdatedAt) })
    .insertOnce(job.id, entry);
  return entry;
}

/** The owner's meter entries that ended at or after `since`, oldest month first. */
export async function* meterEntries(
  ws: Workspace,
  owner: string,
  since: Date,
): AsyncGenerator<MeterEntry> {
  const from = since.toISOString();
  for (const name of (await ws.records.parents(METER, { owner })).sort()) {
    if (name < month(from)) continue;
    const entries = ws.records.collection(METER, { owner, parent: name });
    for (const id of await entries.ids()) {
      const entry = await entries.get(id);
      if (entry && entry.ended_at >= from) yield entry;
    }
  }
}

/** Billed seconds (billedSeconds) of entries that ended at or after `since`, and before `until`. */
export async function meteredSeconds(
  ws: Workspace,
  owner: string,
  since: Date,
  until?: Date,
): Promise<number> {
  const to = until?.toISOString();
  let total = 0;
  for await (const entry of meterEntries(ws, owner, since))
    if (!to || entry.ended_at < to) total += billedSeconds(entry);
  return Math.round(total * 1000) / 1000;
}

/**
 * The owner's plan, as limits on the work they start (hosted). The numbers are the deployment's,
 * never a tool's: jobs at once, a plan's largest export, its storage.
 */
export interface OwnerLimits {
  /** The owner's jobs that run at once (the server's fairness cap, not a plan's); more wait their turn. */
  jobs?: number;
  /** Largest export's short side in pixels. */
  shortSide?: number;
  /** Bytes the owner may keep on the server at once (uploads, media, exports). */
  storageBytes?: number;
  /** The pricing page (information only), for refusals that a plan's limits cause. */
  account?: string;
  /** Why no new job or judgment may start now (the plan's credits are used up). */
  refuseJobs?: CfError;
}

/** What starting a job needs from the owner's limits: refuses when none may start. */
export async function admitJob(
  limits: (() => Promise<OwnerLimits>) | undefined,
): Promise<Pick<StartOptions, 'ownerLimit'>> {
  const l = await limits?.();
  if (l?.refuseJobs) throw l.refuseJobs;
  return l?.jobs === undefined ? {} : { ownerLimit: l.jobs };
}
