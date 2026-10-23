import { join } from 'node:path';
import type { Workspace } from '@cuttingfloor/core';
import type { Job, StartOptions } from '@cuttingfloor/jobs';
import type { CfError } from '@cuttingfloor/schema';

// Render time: how long each job ran, from leaving the queue to its end. One file per job under
// the owner's month (`owners/{owner}/meter/{yyyy-mm}/{job_id}.json`), so jobs ending together on
// any server never lose a count, and a month is its files' sum. Kept 13 months.

export const METER_TTL_MS = 400 * 24 * 3_600_000;

export interface MeterEntry {
  job_id: string;
  tool: string;
  started_at: string;
  ended_at: string;
  seconds: number;
}

const month = (iso: string) => iso.slice(0, 7);

/** Records a job's running time once it ends; jobs that never started a run record nothing. */
export async function meterJob(ws: Workspace, job: Job): Promise<MeterEntry | undefined> {
  if (!job.startedAt || job.status === 'working') return undefined;
  const ms = Date.parse(job.lastUpdatedAt) - Date.parse(job.startedAt);
  if (!(ms > 0)) return undefined;
  const entry: MeterEntry = {
    job_id: job.id,
    tool: job.tool,
    started_at: job.startedAt,
    ended_at: job.lastUpdatedAt,
    seconds: Math.round(ms) / 1000,
  };
  await ws.writeJson(
    ws.ownerDir(job.owner, 'meter', month(job.lastUpdatedAt), `${job.id}.json`),
    entry,
    { exclusive: true },
  );
  return entry;
}

/** Seconds of jobs that ended at or after `since`. */
export async function meteredSeconds(ws: Workspace, owner: string, since: Date): Promise<number> {
  const from = since.toISOString();
  let total = 0;
  for (const name of await ws.list(ws.ownerDir(owner, 'meter'))) {
    if (name < month(from)) continue;
    const dir = ws.ownerDir(owner, 'meter', name);
    for (const file of await ws.list(dir)) {
      const entry = await ws.readJson<MeterEntry>(join(dir, file));
      if (entry && entry.ended_at >= from) total += entry.seconds;
    }
  }
  return Math.round(total * 1000) / 1000;
}

/**
 * The owner's plan, as limits on the work they start (hosted). The numbers are the deployment's,
 * never a tool's: a plan's jobs at once, its largest export, its judgments a day.
 */
export interface OwnerLimits {
  /** The owner's jobs that run at once; more wait their turn. */
  jobs?: number;
  /** Largest export's short side in pixels. */
  shortSide?: number;
  /** Judgments a day on the server's key (judge.ask, media.analyze look). */
  judgmentsPerDay?: number;
  /** Bytes the owner may keep on the server at once (uploads, media, exports). */
  storageBytes?: number;
  /** Where the owner moves to a bigger plan, for refusals that a bigger plan lifts. */
  account?: string;
  /** Why no new job may start now (the plan's render minutes are used up). */
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
