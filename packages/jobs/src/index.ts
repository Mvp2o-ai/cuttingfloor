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
  /** The server running it. With `lastUpdatedAt` as its heartbeat, any server can tell it died. */
  node?: string;
  /** When it left the queue and started its work. */
  startedAt?: string;
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

  /**
   * A cancel asked of a job another server runs. Its own file, written once and never rewritten,
   * so the running server's next write can't erase it the way it can a status in the record.
   */
  #cancelFile(owner: string, id: string): string {
    return this.#file(owner, id).replace(/\.json$/, '.cancel');
  }

  async requestCancel(owner: string, id: string): Promise<void> {
    await this.#ws.writeJson(
      this.#cancelFile(owner, id),
      { at: new Date().toISOString() },
      {
        exclusive: true,
      },
    );
  }

  async cancelRequested(owner: string, id: string): Promise<boolean> {
    return (await this.#ws.readJson(this.#cancelFile(owner, id))) !== undefined;
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
   * it ended interrupted, busy, failed or cancelled, in which case the caller starts a fresh job.
   */
  async findIdempotent(owner: string, tool: string, key: string): Promise<Job | undefined> {
    const index = await this.#ws.readJson<{ job_id: string }>(this.#idemFile(owner, tool, key));
    if (!index) return undefined;
    const job = await this.get(index.job_id, owner);
    if (!job || job.status === 'failed' || job.status === 'cancelled') return undefined;
    const code = (job.result?.structuredContent as { code?: string } | undefined)?.code;
    if (
      job.result?.isError &&
      (code === 'interrupted' || code === 'cancelled' || code === 'server_busy')
    )
      return undefined;
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
          await this.#ws.remove(join(dir, `${job.id}.cancel`));
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
  /** Says what the job is doing or waiting for, leaving its progress as it is. */
  status(message: string): void;
}

export type JobWork = (ctx: JobContext) => Promise<JobResult>;

/**
 * Which queue a job waits in. engine: work this server does itself (renders, imports, analysis),
 * at most `concurrency` at once. sandbox: work the sandbox does (create.motion, create.still),
 * which queues there instead, so it never holds a slot engine work could use. heavy:
 * a model that holds half the CPUs for minutes (create.cutout), in its own slots so a voiceover
 * or an import never waits behind one.
 */
export type JobLane = 'engine' | 'sandbox' | 'heavy';

/** Sandbox jobs this server follows at once; the sandbox itself runs them one at a time. */
const SANDBOX_LANE = 16;

interface Lane {
  limit: number;
  /** What a queued job waits for, in words. */
  slot: string;
  /** Jobs holding a slot: id → tool. */
  running: Map<string, string>;
  queue: Array<{
    id: string;
    tool: string;
    take: () => void;
    save: (patch: Partial<Job>) => Promise<unknown>;
  }>;
}

export interface RunnerOptions {
  /** This server's name in job records. Default `local`. */
  node?: string;
  /** How often a running job's record is rewritten to show it is alive. */
  heartbeatMs?: number;
  /** A working job not written for this long has lost its server. */
  staleMs?: number;
  /** Heavy-lane jobs at once. Default 1. */
  heavy?: number;
  /** Wraps every job's work, e.g. to report what it waits for from deep inside. */
  around?: (ctx: JobContext, work: () => Promise<JobResult>) => Promise<JobResult>;
  /** Told each job this server ran once it ends, as last written (metering). */
  onEnd?: (job: Job) => void;
}

export interface StartOptions {
  lane?: JobLane;
  /**
   * Jobs of this job's owner that may run at once on this server, across lanes; more wait their
   * turn, before they wait for a lane's slot. Absent: no limit of the owner's own.
   */
  ownerLimit?: number;
}

/** An owner's jobs holding a slot of theirs, and the ones waiting for one. */
interface OwnerSlots {
  running: number;
  queue: Array<{ take: () => void }>;
}

/**
 * Runs jobs in this process, at most `concurrency` at a time; the rest wait as "queued".
 * A domain error ends the job `completed` with `isError: true`; cancelling ends it `cancelled`.
 * Several servers can share one data root: each running job carries its server's name and a
 * heartbeat, a cancel written by another server stops it at its next write, and any server
 * ends a job whose heartbeat has stopped.
 */
export class JobRunner {
  readonly store: FileJobStore;
  readonly node: string;
  readonly #concurrency: number;
  readonly #heartbeatMs: number;
  readonly #staleMs: number;
  readonly #around: RunnerOptions['around'];
  readonly #onEnd: RunnerOptions['onEnd'];
  readonly #owners = new Map<string, OwnerSlots>();
  readonly #running = new Map<string, AbortController>();
  readonly #lanes: Record<JobLane, Lane>;
  readonly #done = new Map<string, Promise<void>>();

  constructor(store: FileJobStore, concurrency = 2, options: RunnerOptions = {}) {
    this.store = store;
    this.#concurrency = Math.max(1, concurrency);
    this.node = options.node ?? 'local';
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#staleMs = options.staleMs ?? 120_000;
    this.#around = options.around;
    this.#onEnd = options.onEnd;
    this.#lanes = {
      engine: { limit: this.#concurrency, slot: 'a free job slot', running: new Map(), queue: [] },
      sandbox: { limit: SANDBOX_LANE, slot: 'a free job slot', running: new Map(), queue: [] },
      heavy: {
        limit: Math.max(1, options.heavy ?? 1),
        slot: 'a free slot for heavy model work',
        running: new Map(),
        queue: [],
      },
    };
  }

  /** Starts `work` for a job already written with `store.create`. */
  start(job: Job, work: JobWork, options: StartOptions = {}): void {
    const controller = new AbortController();
    this.#running.set(job.id, controller);
    const lane = this.#lanes[options.lane ?? 'engine'];
    const done = this.#run(job, work, controller, lane, options.ownerLimit).finally(() => {
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
    // Running on another server (or nowhere): it sees this at its next write and stops.
    await this.store.requestCancel(owner, id);
    return this.store.update(job, { status: 'cancelled', statusMessage: 'cancelled' });
  }

  /**
   * Ends `interrupted` the working jobs no server is running: this server's own from before a
   * restart (`startup`), and any whose heartbeat stopped. Safe to run on every server at once.
   */
  async recover(options: { startup?: boolean } = { startup: true }): Promise<number> {
    const cutoff = Date.now() - this.#staleMs;
    const stale = (await this.store.working()).filter(
      (j) =>
        !this.#running.has(j.id) &&
        ((options.startup && (j.node ?? this.node) === this.node) ||
          Date.parse(j.lastUpdatedAt) < cutoff),
    );
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

  /**
   * Where a job stands in its lane's queue, for job.get: undefined once it runs (or for a job
   * this server isn't running).
   */
  queuePosition(id: string): { ahead: number; limit: number; running: string[] } | undefined {
    for (const lane of Object.values(this.#lanes)) {
      const at = lane.queue.findIndex((q) => q.id === id);
      if (at >= 0) return { ahead: at, limit: lane.limit, running: [...lane.running.values()] };
    }
    return undefined;
  }

  /** Tells every job waiting in a lane where it now stands. */
  #announce(lane: Lane): void {
    const running = [...lane.running.values()];
    const counts = new Map<string, number>();
    for (const tool of running) counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const now = [...counts].map(([tool, n]) => (n > 1 ? `${n} ${tool}` : tool)).join(', ');
    lane.queue.forEach((q, i) => {
      void q
        .save({
          statusMessage: `queued: ${i === 0 ? 'next in line' : `${i} ahead`}, waiting for ${lane.slot} (${lane.limit} run at once on this server${now ? `; running now: ${now}` : ''})`,
        })
        .catch(() => undefined);
    });
  }

  async #run(
    job: Job,
    work: JobWork,
    controller: AbortController,
    lane: Lane,
    ownerLimit: number | undefined,
  ): Promise<void> {
    let current: Job = job;
    let pending: Promise<unknown> = Promise.resolve();
    // Every write while working goes through here, one at a time: a record another server has
    // ended (cancelled, or interrupted for a stopped heartbeat) stops the job instead.
    const save = (patch: Partial<Job>) => {
      // One failed write must not end the chain: every later heartbeat (and so a remote cancel)
      // would be skipped.
      pending = pending
        .catch(() => undefined)
        .then(async () => {
          if (controller.signal.aborted) return;
          const disk = await this.store.get(current.id, current.owner);
          // The marker too: this server's own write may have landed over a remote cancel's.
          if (
            (disk && disk.status !== 'working') ||
            (await this.store.cancelRequested(current.owner, current.id))
          ) {
            controller.abort();
            return;
          }
          current = await this.store.update(current, { ...patch, node: this.node });
        });
      return pending;
    };
    void save({}).catch(() => undefined);
    const heartbeat = setInterval(() => void save({}).catch(() => undefined), this.#heartbeatMs);
    heartbeat.unref();
    const slots = ownerLimit === undefined ? undefined : this.#ownerSlots(job.owner);
    try {
      if (
        slots &&
        ownerLimit !== undefined &&
        !(await this.#takeOwnerSlot(slots, ownerLimit, controller, save))
      ) {
        await pending.catch(() => undefined);
        await this.#end(current, { status: 'cancelled', statusMessage: 'cancelled' });
        return;
      }
      try {
        await this.#work(
          job,
          work,
          controller,
          lane,
          save,
          () => current,
          () => pending,
        );
      } finally {
        if (slots) this.#releaseOwnerSlot(job.owner, slots);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  #ownerSlots(owner: string): OwnerSlots {
    let slots = this.#owners.get(owner);
    if (!slots) {
      slots = { running: 0, queue: [] };
      this.#owners.set(owner, slots);
    }
    return slots;
  }

  /** Waits for one of the owner's own slots; false if the job was cancelled while it waited. */
  async #takeOwnerSlot(
    slots: OwnerSlots,
    limit: number,
    controller: AbortController,
    save: (patch: Partial<Job>) => Promise<unknown>,
  ): Promise<boolean> {
    if (slots.running < Math.max(1, limit) && slots.queue.length === 0) {
      slots.running += 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const entry = {
        take: () => {
          slots.running += 1;
          resolve(true);
        },
      };
      slots.queue.push(entry);
      const ahead = slots.queue.length - 1;
      void save({
        statusMessage: `queued: waiting for one of your own jobs to finish (${limit} at once on your plan${ahead ? `; ${ahead} of yours ahead` : ''})`,
      }).catch(() => undefined);
      controller.signal.addEventListener(
        'abort',
        () => {
          const at = slots.queue.indexOf(entry);
          if (at >= 0) {
            slots.queue.splice(at, 1);
            resolve(false);
          }
        },
        { once: true },
      );
    });
  }

  #releaseOwnerSlot(owner: string, slots: OwnerSlots): void {
    slots.running -= 1;
    const next = slots.queue.shift();
    if (next) next.take();
    else if (slots.running <= 0) this.#owners.delete(owner);
  }

  async #work(
    job: Job,
    work: JobWork,
    controller: AbortController,
    lane: Lane,
    save: (patch: Partial<Job>) => Promise<unknown>,
    latest: () => Job,
    writes: () => Promise<unknown>,
  ): Promise<void> {
    if (lane.running.size >= lane.limit) {
      // Wait for a slot; a job cancelled while queued leaves without ever taking one.
      const granted = await new Promise<boolean>((resolve) => {
        const entry = { id: job.id, tool: job.tool, take: () => resolve(true), save };
        lane.queue.push(entry);
        this.#announce(lane);
        controller.signal.addEventListener(
          'abort',
          () => {
            const at = lane.queue.indexOf(entry);
            if (at >= 0) {
              lane.queue.splice(at, 1);
              this.#announce(lane);
              resolve(false);
            }
          },
          { once: true },
        );
      });
      if (!granted) {
        await writes().catch(() => undefined);
        await this.#end(latest(), { status: 'cancelled', statusMessage: 'cancelled' });
        return;
      }
    }
    lane.running.set(job.id, job.tool);
    void save({ startedAt: new Date().toISOString() }).catch(() => undefined);
    let lastWrite = 0;
    // An update inside the second is held, not dropped: the latest one is written when the
    // second is up, so a quick "running" after "fetching inputs" still shows.
    let held: { fraction: number; message: string } | undefined;
    let fraction = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = (f: number, message: string) => {
      lastWrite = Date.now();
      fraction = Math.max(0, Math.min(1, f));
      void save({ progress: fraction, statusMessage: message });
    };
    const progress = (fraction: number, message: string) => {
      const wait = lastWrite + 1000 - Date.now();
      if (wait <= 0 || fraction >= 1) {
        held = undefined;
        write(fraction, message);
        return;
      }
      held = { fraction, message };
      timer ??= setTimeout(() => {
        timer = undefined;
        if (held) write(held.fraction, held.message);
        held = undefined;
      }, wait);
    };
    const settle = () => {
      clearTimeout(timer);
      held = undefined;
    };
    try {
      if (controller.signal.aborted) throw new CfError('cancelled', 'Cancelled');
      const ctx: JobContext = {
        signal: controller.signal,
        progress,
        status: (message) => progress(held?.fraction ?? fraction, message),
      };
      const result = await (this.#around ? this.#around(ctx, () => work(ctx)) : work(ctx));
      settle();
      await writes();
      await this.#end(latest(), {
        status: 'completed',
        progress: 1,
        statusMessage: result.isError ? 'failed' : 'done',
        result,
      });
    } catch (error) {
      settle();
      await writes().catch(() => undefined);
      if (controller.signal.aborted) {
        await this.#end(latest(), { status: 'cancelled', statusMessage: 'cancelled' });
      } else {
        const cf =
          error instanceof CfError
            ? error
            : new CfError('engine_error', error instanceof Error ? error.message : String(error));
        await this.#end(latest(), {
          status: 'completed',
          statusMessage: 'failed',
          result: errorResult(cf),
        });
      }
    } finally {
      lane.running.delete(job.id);
      const next = lane.queue.shift();
      if (next) {
        // Its slot is taken before anything else can see a free one.
        lane.running.set(next.id, next.tool);
        next.take();
        this.#announce(lane);
      }
    }
  }

  /** The final write. A job another server already ended (cancelled, interrupted) stays so. */
  async #end(job: Job, patch: Partial<Job>): Promise<void> {
    const disk = await this.store.get(job.id, job.owner);
    if (disk && disk.status !== 'working') return;
    const ended = await this.store.update(job, { ...patch, node: this.node });
    try {
      this.#onEnd?.(ended);
    } catch {
      // A listener's failure never changes how the job ended.
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
