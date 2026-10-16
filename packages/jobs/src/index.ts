import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { randomId, type Workspace } from '@cuttingfloor/core';
import { CfError, type ToolError } from '@cuttingfloor/schema';

/**
 * The durable job store. One record serves two surfaces: MCP Tasks
 * (`io.modelcontextprotocol/tasks`) and the job.get/list/cancel tools; job id = task id.
 * Records are files, `owners/{owner}/jobs/{job_id}.json`, written and fsynced before the job id
 * is returned. No database, no queue.
 */
export type JobStatus = 'working' | 'completed' | 'failed' | 'cancelled';

/** A tool result as MCP returns it. */
export interface JobResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Job {
  id: string;
  owner: string;
  tool: string;
  status: JobStatus;
  statusMessage?: string;
  progress?: number;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  idempotencyKey?: string;
  /** Set once `completed`. Domain failures complete with `isError: true`. */
  result?: JobResult;
  /** Set once `failed` (protocol-level failures only). */
  error?: { code: number; message: string };
  /** Ids known when the job starts, e.g. `media_id` for imports. */
  meta?: Record<string, string>;
}

export const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class FileJobStore {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    this.#ws = ws;
  }

  #file(owner: string, id: string): string {
    if (!/^j_[0-9a-z]{26}$/.test(id)) throw new CfError('bad_request', `Not a job id: ${id}`);
    return this.#ws.ownerDir(owner, 'jobs', `${id}.json`);
  }

  #idemFile(owner: string, tool: string, key: string): string {
    const h = createHash('sha256').update(`${tool}\0${key}`).digest('hex').slice(0, 40);
    return this.#ws.ownerDir(owner, 'jobs-idem', `${h}.json`);
  }

  async create(input: {
    owner: string;
    tool: string;
    ttlMs?: number;
    idempotencyKey?: string;
    meta?: Record<string, string>;
    statusMessage?: string;
  }): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomId('j_'),
      owner: input.owner,
      tool: input.tool,
      status: 'working',
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: input.ttlMs ?? JOB_TTL_MS,
      ...(input.statusMessage ? { statusMessage: input.statusMessage } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    await this.#ws.writeJson(this.#file(job.owner, job.id), job);
    if (input.idempotencyKey) {
      await this.#ws.writeJson(this.#idemFile(job.owner, job.tool, input.idempotencyKey), {
        job_id: job.id,
      });
    }
    return job;
  }

  /**
   * The job a repeat call with the same idempotency key should return: the earlier one, unless
   * it ended interrupted, failed or cancelled, in which case the caller starts a fresh job.
   */
  async findIdempotent(owner: string, tool: string, key: string): Promise<Job | undefined> {
    const index = await this.#ws.readJson<{ job_id: string }>(this.#idemFile(owner, tool, key));
    if (!index) return undefined;
    const job = await this.get(index.job_id, owner);
    if (!job || job.status === 'failed' || job.status === 'cancelled') return undefined;
    const code = (job.result?.structuredContent as { code?: string } | undefined)?.code;
    if (job.result?.isError && (code === 'interrupted' || code === 'cancelled')) return undefined;
    return job;
  }

  async get(id: string, owner: string): Promise<Job | undefined> {
    const job = await this.#ws.readJson<Job>(this.#file(owner, id));
    return job?.owner === owner ? job : undefined;
  }

  async update(job: Job, patch: Partial<Omit<Job, 'id' | 'owner'>>): Promise<Job> {
    const next: Job = { ...job, ...patch, lastUpdatedAt: new Date().toISOString() };
    await this.#ws.writeJson(this.#file(job.owner, job.id), next);
    return next;
  }

  async list(owner: string, filter: { status?: JobStatus; limit?: number } = {}): Promise<Job[]> {
    const dir = this.#ws.ownerDir(owner, 'jobs');
    const jobs: Job[] = [];
    for (const name of await this.#ws.list(dir)) {
      if (!name.endsWith('.json')) continue;
      const job = await this.#ws.readJson<Job>(join(dir, name));
      if (job && job.owner === owner && (!filter.status || job.status === filter.status))
        jobs.push(job);
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return jobs.slice(0, filter.limit ?? 50);
  }

  /** Every owner's jobs still marked working (startup recovery). */
  async working(): Promise<Job[]> {
    const out: Job[] = [];
    for (const key of await this.#ws.owners()) {
      const dir = this.#ws.path('owners', key, 'jobs');
      for (const name of await this.#ws.list(dir)) {
        const job = name.endsWith('.json')
          ? await this.#ws.readJson<Job>(join(dir, name))
          : undefined;
        if (job?.status === 'working') out.push(job);
      }
    }
    return out;
  }

  /** Deletes finished jobs past their TTL, and their outputs. */
  async sweep(): Promise<number> {
    let n = 0;
    for (const key of await this.#ws.owners()) {
      const dir = this.#ws.path('owners', key, 'jobs');
      for (const name of await this.#ws.list(dir)) {
        const job = name.endsWith('.json')
          ? await this.#ws.readJson<Job>(join(dir, name))
          : undefined;
        if (!job || job.status === 'working') continue;
        if (Date.parse(job.lastUpdatedAt) + job.ttlMs < Date.now()) {
          await this.#ws.remove(join(dir, name));
          await this.#ws.remove(this.#ws.path('owners', key, 'outputs', job.id));
          n += 1;
        }
      }
      await this.#ws.sweep(this.#ws.path('owners', key, 'jobs-idem'), JOB_TTL_MS);
    }
    return n;
  }
}

export interface JobContext {
  signal: AbortSignal;
  /** Records progress; written to the job file at most once a second. */
  progress(fraction: number, message: string): void;
}

export type JobWork = (ctx: JobContext) => Promise<JobResult>;

/**
 * Runs jobs in this process, at most `concurrency` at a time; the rest wait as "queued".
 * A domain error ends the job `completed` with `isError: true`; cancelling ends it `cancelled`.
 */
export class JobRunner {
  readonly store: FileJobStore;
  readonly #concurrency: number;
  readonly #running = new Map<string, AbortController>();
  readonly #queue: Array<() => void> = [];
  readonly #done = new Map<string, Promise<void>>();
  #active = 0;

  constructor(store: FileJobStore, concurrency = 2) {
    this.store = store;
    this.#concurrency = Math.max(1, concurrency);
  }

  /** Starts `work` for a job already written with `store.create`. */
  start(job: Job, work: JobWork): void {
    const controller = new AbortController();
    this.#running.set(job.id, controller);
    const done = this.#run(job, work, controller).finally(() => {
      this.#running.delete(job.id);
      this.#done.delete(job.id);
    });
    this.#done.set(job.id, done);
  }

  /** Resolves when the job settles (tests, graceful shutdown). */
  async settled(id: string): Promise<void> {
    await this.#done.get(id);
  }

  async cancel(id: string, owner: string): Promise<Job | undefined> {
    const job = await this.store.get(id, owner);
    if (!job) return undefined;
    if (job.status !== 'working') return job;
    const controller = this.#running.get(id);
    if (controller) {
      controller.abort();
      await this.#done.get(id);
      return this.store.get(id, owner);
    }
    return this.store.update(job, { status: 'cancelled', statusMessage: 'cancelled' });
  }

  /** On startup: jobs left working by a previous process end `interrupted`. */
  async recover(): Promise<number> {
    const stale = (await this.store.working()).filter((j) => !this.#running.has(j.id));
    for (const job of stale) {
      await this.store.update(job, {
        status: 'completed',
        statusMessage: 'interrupted',
        result: errorResult(
          new CfError('interrupted', 'The server restarted while this job was running', {
            hint: 'Call the tool again; with the same idempotency_key it starts a fresh job',
            detail: { resume: true },
          }),
        ),
      });
    }
    return stale.length;
  }

  async #run(job: Job, work: JobWork, controller: AbortController): Promise<void> {
    if (this.#active >= this.#concurrency) {
      await this.store.update(job, { statusMessage: 'queued' });
      // Wait for a slot; a job cancelled while queued leaves without ever taking one.
      const granted = await new Promise<boolean>((resolve) => {
        const take = () => resolve(true);
        this.#queue.push(take);
        controller.signal.addEventListener(
          'abort',
          () => {
            const at = this.#queue.indexOf(take);
            if (at >= 0) {
              this.#queue.splice(at, 1);
              resolve(false);
            }
          },
          { once: true },
        );
      });
      if (!granted) {
        const latest = (await this.store.get(job.id, job.owner)) ?? job;
        await this.store.update(latest, { status: 'cancelled', statusMessage: 'cancelled' });
        return;
      }
    } else {
      this.#active += 1;
    }
    let current = (await this.store.get(job.id, job.owner)) ?? job;
    let lastWrite = 0;
    let pending: Promise<unknown> = Promise.resolve();
    const progress = (fraction: number, message: string) => {
      const now = Date.now();
      if (now - lastWrite < 1000 && fraction < 1) return;
      lastWrite = now;
      pending = pending.then(async () => {
        if (controller.signal.aborted) return;
        current = await this.store.update(current, {
          progress: Math.max(0, Math.min(1, fraction)),
          statusMessage: message,
        });
      });
    };
    try {
      if (controller.signal.aborted) throw new CfError('cancelled', 'Cancelled');
      const result = await work({ signal: controller.signal, progress });
      await pending;
      current = await this.store.update(current, {
        status: 'completed',
        progress: 1,
        statusMessage: result.isError ? 'failed' : 'done',
        result,
      });
    } catch (error) {
      await pending.catch(() => undefined);
      if (controller.signal.aborted) {
        current = await this.store.update(current, {
          status: 'cancelled',
          statusMessage: 'cancelled',
        });
      } else {
        const cf =
          error instanceof CfError
            ? error
            : new CfError('engine_error', error instanceof Error ? error.message : String(error));
        current = await this.store.update(current, {
          status: 'completed',
          statusMessage: 'failed',
          result: errorResult(cf),
        });
      }
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#active -= 1;
    }
  }
}

/** A domain error as an MCP tool result. */
export function errorResult(error: CfError): JobResult {
  const body: ToolError = error.toJSON();
  return {
    content: [
      {
        type: 'text',
        text: `${body.code}: ${body.message}${body.hint ? `\nHint: ${body.hint}` : ''}`,
      },
    ],
    structuredContent: body as unknown as Record<string, unknown>,
    isError: true,
  };
}
