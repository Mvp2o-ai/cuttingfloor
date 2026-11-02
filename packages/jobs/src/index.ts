import { AsyncLocalStorage } from 'node:async_hooks';
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
  readonly #listeners = new Set<(job: Job) => void>();

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
      (code === 'interrupted' ||
        code === 'cancelled' ||
        code === 'server_busy' ||
        code === 'stalled')
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
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch {
        // A listener's failure never fails the write.
      }
    }
    return next;
  }

  /**
   * Tells `listener` about every job this process writes, as written (job.get's wait hears a
   * change at once; jobs other servers write it reads from their files).
   */
  onChange(listener: (job: Job) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async list(
    owner: string,
    filter: { status?: JobStatus; limit?: number; where?: (job: Job) => boolean } = {},
  ): Promise<Job[]> {
    const dir = this.#ws.ownerDir(owner, 'jobs');
    const jobs: Job[] = [];
    for (const name of await this.#ws.list(dir)) {
      if (!name.endsWith('.json')) continue;
      const job = await this.#ws.readJson<Job>(join(dir, name));
      if (
        job &&
        job.owner === owner &&
        (!filter.status || job.status === filter.status) &&
        (!filter.where || filter.where(job))
      )
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
  /**
   * Says the job is still moving though its progress has not changed (a service it waits on
   * answered), so it is not taken for stalled.
   */
  alive(): void;
  /**
   * While on, the job waits for something outside it (a render slot): its stall clock stops, as
   * it does while the job waits in a queue.
   */
  waiting(on: boolean): void;
  /**
   * Runs `wait` (another job's work this one needs) with this job out of its slot: the slot
   * goes to the next job in line and the stall clock stops; when `wait` ends the job takes the
   * next free slot again, ahead of jobs that have not started, and goes on.
   */
  aside<T>(wait: Promise<T>): Promise<T>;
}

export type JobWork = (ctx: JobContext) => Promise<JobResult>;

/** A context for job work run inline in a call (a short one answered at once): reports go nowhere. */
export function inlineJobContext(signal: AbortSignal): JobContext {
  const none = () => undefined;
  return {
    signal,
    progress: none,
    status: none,
    alive: none,
    waiting: none,
    aside: (wait) => wait,
  };
}

const currentJob = new AsyncLocalStorage<JobContext>();

/**
 * Tells the job this code runs inside, if any, that it is still moving (a heartbeat from deep in
 * its work, e.g. each reply from a service it streams from).
 */
export function jobAlive(): void {
  currentJob.getStore()?.alive();
}

/**
 * Which queue a job waits in, by the resource its work holds. engine: CPU work this server does
 * itself (renders, encodes, imports, analysis, vid.stab), at most `concurrency` at once, plus
 * slots only short jobs take. heavy: a model that holds half the CPUs for minutes (create.cutout,
 * create.stems), in its own slots so engine work never waits behind one. sandbox: work the motion
 * sandbox does (create.motion, create.still), which queues there instead. remote: work that
 * mostly waits on another service (a lip-sync provider, judgment calls), which holds no CPU here.
 */
export type JobLane = 'engine' | 'sandbox' | 'heavy' | 'remote';

/** Sandbox jobs this server follows at once; the sandbox itself runs them one at a time. */
const SANDBOX_LANE = 16;
/** Remote jobs at once: each holds a connection and a little memory, no CPU. */
const REMOTE_LANE = 8;
/** Default stall limit: a job whose progress has not moved for this long is ended. */
export const STALL_MS = 5 * 60_000;
/**
 * The stall limit grows with the work: this many seconds without a change are allowed per second
 * of media the job reads, for steps that report nothing until they finish on long media.
 */
export const STALL_PER_WORK_SECOND = 0.25;
/** How long a cancel waits for the work to stop before it ends the record and frees the slot. */
const CANCEL_GRACE_MS = 5000;
/** Jobs reading at most this many seconds of media count as short. */
export const SHORT_JOB_SECONDS = 60;
/** Progress samples kept for the rate behind an estimate. */
const RATE_WINDOW_MS = 120_000;
/** An estimate needs progress that moved over at least this long, and recently. */
const RATE_MIN_SPAN_MS = 10_000;
const RATE_FRESH_MS = 30_000;

interface Waiter {
  id: string;
  tool: string;
  short: boolean;
  take: (reserved: boolean) => void;
  save: (patch: Partial<Job>) => Promise<unknown>;
}

interface Lane {
  limit: number;
  /** Slots beyond `limit` only short jobs take, so they never wait behind long running ones. */
  reserved: number;
  /** What a queued job waits for, in words. */
  slot: string;
  /** Jobs holding a slot: id → tool and whether it holds a reserved one. */
  running: Map<string, { tool: string; reserved: boolean }>;
  queue: Waiter[];
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
  /**
   * The least time a running job may go without its progress or status changing (or a heartbeat
   * from its work) before it is ended as stalled; long work gets more (STALL_PER_WORK_SECOND).
   * Default 5 minutes.
   */
  stallMs?: number;
  /** Engine slots only short jobs take. Default 1. */
  shortSlots?: number;
  /** Jobs reading at most this many seconds of media are short. Default 60. */
  shortSeconds?: number;
  /** How long a cancel or a stall waits for the work to stop before freeing its slot anyway. */
  cancelGraceMs?: number;
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
  /**
   * Seconds of media (or timeline) the job reads, when known before it starts: short work may
   * take a slot kept for short jobs, and the stall limit grows with it.
   */
  work?: number;
  /** This job's own stall limit, instead of the one derived from the server's and its work. */
  stallMs?: number;
  /** What a new call keeps from this one if it is stopped as stalled, said in its error's hint. */
  kept?: string;
}

/** An owner's jobs holding a slot of theirs, and the ones waiting for one. */
interface OwnerSlots {
  running: number;
  queue: Array<{ take: () => void }>;
}

/** What this server knows of a job it runs, beyond its record. */
interface Active {
  job: Job;
  controller: AbortController;
  /** Why it was stopped from outside its work. */
  stop?: 'cancelled' | 'stalled';
  kept?: string;
  /** Its record was ended and its slot freed while its work had not stopped yet. */
  detached: boolean;
  done: Promise<void>;
  latest: () => Job;
  writes: () => Promise<unknown>;
  /** Frees its lane slot and owner slot, once. */
  free: Array<() => void>;
  heartbeat?: ReturnType<typeof setInterval>;
  lane: Lane;
  short: boolean;
  stallMs: number;
  /** While its work runs: when its progress last moved, and whether it waits outside itself. */
  running: boolean;
  lastMove: number;
  waiting: boolean;
  fraction: number;
  message: string;
  /** Progress samples in the current step, for the rate behind an estimate. */
  samples: Array<{ t: number; f: number }>;
  step: string;
}

/** A job's estimate, when one can honestly be made. */
export interface JobEstimate {
  /** Running: seconds left at the rate its progress has moved over the last minute or two. */
  secondsLeft?: number;
  /** Queued next in line: seconds until the first slot it can take frees, from their estimates. */
  startsIn?: number;
}

/** A span of time in words: "45 s", "12 min". */
function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * Runs jobs in this process, at most `concurrency` at a time; the rest wait as "queued".
 * A domain error ends the job `completed` with `isError: true`; cancelling ends it `cancelled`;
 * a job whose progress stops moving is ended with a `stalled` error and its slot freed.
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
  readonly #stallMs: number;
  readonly #shortSeconds: number;
  readonly #graceMs: number;
  readonly #around: RunnerOptions['around'];
  readonly #onEnd: RunnerOptions['onEnd'];
  readonly #owners = new Map<string, OwnerSlots>();
  readonly #active = new Map<string, Active>();
  readonly #lanes: Record<JobLane, Lane>;

  constructor(store: FileJobStore, concurrency = 2, options: RunnerOptions = {}) {
    this.store = store;
    this.#concurrency = Math.max(1, concurrency);
    this.node = options.node ?? 'local';
    this.#heartbeatMs = options.heartbeatMs ?? 30_000;
    this.#staleMs = options.staleMs ?? 120_000;
    this.#stallMs = Math.max(1, options.stallMs ?? STALL_MS);
    this.#shortSeconds = options.shortSeconds ?? SHORT_JOB_SECONDS;
    this.#graceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.#around = options.around;
    this.#onEnd = options.onEnd;
    const lane = (limit: number, slot: string, reserved = 0): Lane => ({
      limit,
      reserved,
      slot,
      running: new Map(),
      queue: [],
    });
    this.#lanes = {
      engine: lane(
        this.#concurrency,
        'a free job slot',
        Math.max(0, Math.floor(options.shortSlots ?? 1)),
      ),
      sandbox: lane(SANDBOX_LANE, 'a free job slot'),
      heavy: lane(Math.max(1, options.heavy ?? 1), 'a free slot for heavy model work'),
      remote: lane(REMOTE_LANE, 'a free slot for work waiting on another service'),
    };
  }

  /** Starts `work` for a job already written with `store.create`. */
  start(job: Job, work: JobWork, options: StartOptions = {}): void {
    const lane = this.#lanes[options.lane ?? 'engine'];
    const workMs = (options.work ?? 0) * 1000;
    const active: Active = {
      job,
      controller: new AbortController(),
      detached: false,
      done: Promise.resolve(),
      latest: () => job,
      writes: () => Promise.resolve(),
      free: [],
      lane,
      short: options.work !== undefined && options.work <= this.#shortSeconds,
      stallMs: options.stallMs ?? Math.max(this.#stallMs, workMs * STALL_PER_WORK_SECOND),
      ...(options.kept ? { kept: options.kept } : {}),
      running: false,
      lastMove: Date.now(),
      waiting: false,
      fraction: job.progress ?? 0,
      message: job.statusMessage ?? '',
      samples: [],
      step: '',
    };
    this.#active.set(job.id, active);
    active.done = this.#run(active, work, options.ownerLimit).finally(() => {
      if (this.#active.get(job.id) === active) this.#active.delete(job.id);
    });
  }

  /** Resolves when the job settles (tests, graceful shutdown). */
  async settled(id: string): Promise<void> {
    await this.#active.get(id)?.done;
  }

  /**
   * Stops a job and returns its record. A running job's work is aborted (its subprocesses are
   * killed); if it has not stopped within a few seconds its record is ended anyway and its slot
   * freed, so a cancel always answers in seconds.
   */
  async cancel(id: string, owner: string): Promise<Job | undefined> {
    const job = await this.store.get(id, owner);
    if (!job) return undefined;
    if (job.status !== 'working') return job;
    const active = this.#active.get(id);
    if (active && active.job.owner === owner) {
      await this.#stop(active, 'cancelled');
      return this.store.get(id, owner);
    }
    // Running on another server (or nowhere): it sees this at its next write and stops.
    await this.store.requestCancel(owner, id);
    return this.store.update(job, { status: 'cancelled', statusMessage: 'cancelled' });
  }

  /** Aborts a job's work; ends its record and frees its slot itself if the work won't stop. */
  async #stop(active: Active, reason: 'cancelled' | 'stalled'): Promise<void> {
    active.stop ??= reason;
    active.controller.abort();
    const within = <T>(work: Promise<T>, ms: number) =>
      Promise.race([
        work.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), ms).unref()),
      ]);
    if (await within(active.done, this.#graceMs)) return;
    if (active.detached) return;
    // The work ignored the abort (a process that won't die, a call that never returns): end the
    // record now and give its slot to the next job. Whatever the work does later is discarded.
    active.detached = true;
    if (active.heartbeat) clearInterval(active.heartbeat);
    await within(
      active.writes().catch(() => undefined),
      2000,
    );
    await this.#end(active.latest(), this.#stopPatch(active));
    for (const free of active.free) free();
    if (this.#active.get(active.job.id) === active) this.#active.delete(active.job.id);
  }

  /** How a job stopped from outside its work ends. */
  #stopPatch(active: Active): Partial<Job> {
    if (active.stop !== 'stalled') return { status: 'cancelled', statusMessage: 'cancelled' };
    const quiet = Date.now() - active.lastMove;
    const pct = Math.round(active.fraction * 1000) / 10;
    const at = `${pct}%${active.message ? `, ${active.message}` : ''}`;
    return {
      status: 'completed',
      statusMessage: `stalled: no progress for ${minutes(quiet)} (stuck at ${at}); stopped and its slot freed`,
      result: errorResult(
        new CfError(
          'stalled',
          `${active.job.tool} stopped making progress: nothing moved for ${minutes(quiet)} (stuck at ${at})`,
          {
            hint: `It was stopped and its slot freed. Call the tool again; with the same idempotency_key it starts a fresh job${active.kept ? `. ${active.kept}` : ''}`,
            detail: {
              progress: active.fraction,
              ...(active.message ? { status_message: active.message } : {}),
              quiet_seconds: Math.round(quiet / 1000),
              limit_seconds: Math.round(active.stallMs / 1000),
              retry: true,
            },
          },
        ),
      ),
    };
  }

  /**
   * Ends `interrupted` the working jobs no server is running: this server's own from before a
   * restart (`startup`), and any whose heartbeat stopped. Safe to run on every server at once.
   */
  async recover(options: { startup?: boolean } = { startup: true }): Promise<number> {
    const cutoff = Date.now() - this.#staleMs;
    const stale = (await this.store.working()).filter(
      (j) =>
        !this.#active.has(j.id) &&
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
      if (at >= 0)
        return {
          ahead: at,
          limit: lane.limit,
          running: [...lane.running.values()].map((r) => r.tool),
        };
    }
    return undefined;
  }

  /**
   * An estimate for a job this server runs, only where one can honestly be made: a running job
   * whose progress has moved steadily of late (at that rate), and a queued job next in line
   * whose every slot holder has such an estimate.
   */
  estimate(id: string): JobEstimate | undefined {
    const active = this.#active.get(id);
    if (!active || active.detached) return undefined;
    if (active.running) {
      const left = this.#secondsLeft(active);
      return left === undefined ? undefined : { secondsLeft: left };
    }
    const lane = active.lane;
    const at = lane.queue.findIndex((q) => q.id === id);
    if (at < 0) return undefined;
    // Next in line for a slot it can take: the head of the queue, or the first short job for a
    // slot kept for short jobs.
    const shortAhead = lane.queue.slice(0, at).some((q) => q.short);
    const general = at === 0;
    const reserved = active.short && lane.reserved > 0 && !shortAhead;
    if (!general && !reserved) return undefined;
    const holders = [...lane.running].filter(
      ([, r]) => (general && !r.reserved) || (reserved && r.reserved),
    );
    if (!holders.length) return undefined;
    let soonest = Number.POSITIVE_INFINITY;
    for (const [holder] of holders) {
      const h = this.#active.get(holder);
      const left = h ? this.#secondsLeft(h) : undefined;
      if (left === undefined) return undefined;
      soonest = Math.min(soonest, left);
    }
    return { startsIn: soonest };
  }

  #secondsLeft(active: Active): number | undefined {
    const now = Date.now();
    const s = active.samples;
    const first = s[0];
    const last = s.at(-1);
    if (!first || !last || active.waiting || s.length < 3) return undefined;
    if (last.t - first.t < RATE_MIN_SPAN_MS || now - last.t > RATE_FRESH_MS) return undefined;
    const rate = (last.f - first.f) / (last.t - first.t);
    if (!(rate > 0)) return undefined;
    return Math.max(0, Math.round(((1 - last.f) / rate - (now - last.t)) / 1000));
  }

  /** Tells every job waiting in a lane where it now stands. */
  #announce(lane: Lane): void {
    const counts = new Map<string, number>();
    for (const { tool } of lane.running.values()) counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const now = [...counts].map(([tool, n]) => (n > 1 ? `${n} ${tool}` : tool)).join(', ');
    lane.queue.forEach((q, i) => {
      const kept =
        q.short && lane.reserved ? `, plus ${lane.reserved} kept for short jobs like this one` : '';
      void q
        .save({
          statusMessage: `queued: ${i === 0 ? 'next in line' : `${i} ahead`}, waiting for ${lane.slot} (${lane.limit} run at once on this server${kept}${now ? `; running now: ${now}` : ''})`,
        })
        .catch(() => undefined);
    });
  }

  /**
   * Hands free slots to waiting jobs: a general slot to the head of the queue, a slot kept for
   * short jobs to the first short job. FIFO otherwise, so long jobs are never passed over for
   * a general slot.
   */
  #grant(lane: Lane): boolean {
    let moved = false;
    const count = (reserved: boolean) =>
      [...lane.running.values()].filter((r) => r.reserved === reserved).length;
    while (lane.queue.length && count(false) < lane.limit) {
      const next = lane.queue.shift() as Waiter;
      lane.running.set(next.id, { tool: next.tool, reserved: false });
      next.take(false);
      moved = true;
    }
    while (count(true) < lane.reserved) {
      const at = lane.queue.findIndex((q) => q.short);
      if (at < 0) break;
      const [next] = lane.queue.splice(at, 1) as [Waiter];
      lane.running.set(next.id, { tool: next.tool, reserved: true });
      next.take(true);
      moved = true;
    }
    return moved;
  }

  async #run(active: Active, work: JobWork, ownerLimit: number | undefined): Promise<void> {
    const { job, controller } = active;
    let current: Job = job;
    let pending: Promise<unknown> = Promise.resolve();
    active.latest = () => current;
    active.writes = () => pending;
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
          if (controller.signal.aborted) return;
          current = await this.store.update(current, { ...patch, node: this.node });
        });
      return pending;
    };
    void save({}).catch(() => undefined);
    active.heartbeat = setInterval(() => void save({}).catch(() => undefined), this.#heartbeatMs);
    active.heartbeat.unref();
    const slots = ownerLimit === undefined ? undefined : this.#ownerSlots(job.owner);
    try {
      if (slots && ownerLimit !== undefined) {
        if (!(await this.#takeOwnerSlot(slots, ownerLimit, controller, save))) {
          await pending.catch(() => undefined);
          await this.#end(current, { status: 'cancelled', statusMessage: 'cancelled' });
          return;
        }
        let freed = false;
        active.free.push(() => {
          if (freed) return;
          freed = true;
          this.#releaseOwnerSlot(job.owner, slots);
        });
      }
      await this.#work(active, work, save);
    } finally {
      if (active.heartbeat) clearInterval(active.heartbeat);
      for (const free of active.free) free();
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
    active: Active,
    work: JobWork,
    save: (patch: Partial<Job>) => Promise<unknown>,
  ): Promise<void> {
    const { job, controller, lane } = active;
    // Wait for a slot; a job cancelled while queued leaves without ever taking one.
    const granted = await new Promise<boolean>((resolve) => {
      const entry: Waiter = {
        id: job.id,
        tool: job.tool,
        short: active.short,
        take: () => resolve(true),
        save,
      };
      lane.queue.push(entry);
      this.#grant(lane);
      if (!lane.running.has(job.id)) this.#announce(lane);
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
      await active.writes().catch(() => undefined);
      await this.#end(active.latest(), { status: 'cancelled', statusMessage: 'cancelled' });
      return;
    }
    let laneFreed = false;
    active.free.push(() => {
      if (laneFreed) return;
      laneFreed = true;
      lane.running.delete(job.id);
      if (this.#grant(lane)) this.#announce(lane);
    });
    /** Out of its slot while it waits on other work, then back in line at the front. */
    const aside = async <T>(wait: Promise<T>): Promise<T> => {
      lane.running.delete(job.id);
      if (this.#grant(lane)) this.#announce(lane);
      active.waiting = true;
      try {
        return await wait;
      } finally {
        await new Promise<void>((resolve) => {
          const entry: Waiter = {
            id: job.id,
            tool: job.tool,
            short: active.short,
            take: () => resolve(),
            save,
          };
          if (controller.signal.aborted) return resolve();
          lane.queue.unshift(entry);
          this.#grant(lane);
          controller.signal.addEventListener(
            'abort',
            () => {
              const at = lane.queue.indexOf(entry);
              if (at >= 0) lane.queue.splice(at, 1);
              resolve();
            },
            { once: true },
          );
        });
        active.waiting = false;
        active.lastMove = Date.now();
      }
    };
    void save({ startedAt: new Date().toISOString() }).catch(() => undefined);
    active.running = true;
    active.lastMove = Date.now();
    let lastWrite = 0;
    // An update inside the second is held, not dropped: the latest one is written when the
    // second is up, so a quick "running" after "fetching inputs" still shows.
    let held: { fraction: number; message: string } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = (f: number, message: string) => {
      lastWrite = Date.now();
      void save({ progress: f, statusMessage: message });
    };
    const progress = (f: number, message: string) => {
      const fraction = Math.max(0, Math.min(1, f));
      const now = Date.now();
      if (fraction !== active.fraction || message !== active.message) active.lastMove = now;
      // The rate behind an estimate is measured within one step (numbers aside).
      const step = message.replace(/[\d.]+/g, '#');
      if (step !== active.step || fraction < active.fraction) {
        active.step = step;
        active.samples = [];
      }
      if (fraction !== active.samples.at(-1)?.f) active.samples.push({ t: now, f: fraction });
      while (active.samples.length > 2 && now - (active.samples[0]?.t ?? now) > RATE_WINDOW_MS)
        active.samples.shift();
      active.fraction = fraction;
      active.message = message;
      const wait = lastWrite + 1000 - now;
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
    // The stall watch: a job whose progress, status and heartbeats have all stopped for its
    // limit is ended and its slot freed. Time spent waiting for a render slot doesn't count.
    const watch = setInterval(
      () => {
        if (active.waiting || active.stop) return;
        if (Date.now() - active.lastMove >= active.stallMs) void this.#stop(active, 'stalled');
      },
      Math.max(20, Math.min(5000, active.stallMs / 4)),
    );
    watch.unref();
    try {
      if (controller.signal.aborted) throw new CfError('cancelled', 'Cancelled');
      const ctx: JobContext = {
        signal: controller.signal,
        progress,
        status: (message) => progress(held?.fraction ?? active.fraction, message),
        alive: () => {
          active.lastMove = Date.now();
        },
        waiting: (on) => {
          active.waiting = on;
          active.lastMove = Date.now();
        },
        aside,
      };
      const result = await currentJob.run(ctx, () =>
        this.#around ? this.#around(ctx, () => work(ctx)) : work(ctx),
      );
      settle();
      await active.writes();
      // Ended and freed already, for work that took too long to stop: its result is discarded.
      if (active.detached) return;
      await this.#end(active.latest(), {
        status: 'completed',
        progress: 1,
        statusMessage: result.isError ? 'failed' : 'done',
        result,
      });
    } catch (error) {
      settle();
      await active.writes().catch(() => undefined);
      if (active.detached) return;
      if (controller.signal.aborted) {
        await this.#end(active.latest(), this.#stopPatch(active));
      } else {
        const cf =
          error instanceof CfError
            ? error
            : new CfError('engine_error', error instanceof Error ? error.message : String(error));
        await this.#end(active.latest(), {
          status: 'completed',
          statusMessage: 'failed',
          result: errorResult(cf),
        });
      }
    } finally {
      clearInterval(watch);
      active.running = false;
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
