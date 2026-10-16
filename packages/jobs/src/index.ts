/**
 * The durable job store. One record serves two surfaces: MCP Tasks
 * (`io.modelcontextprotocol/tasks`) and the job.get/list/cancel tools.
 * A job must be written before its CreateTaskResult is returned.
 * Records are files: `jobs/{job_id}.json` inside the project (local disk, or object storage
 * hosted), fsynced before the task id is returned. No database, no queue.
 */
export type JobStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  owner: string;
  tool: string;
  status: JobStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  idempotencyKey?: string;
}

export interface JobStore {
  create(job: Omit<Job, 'createdAt' | 'lastUpdatedAt'>): Promise<Job>;
  get(id: string, owner: string): Promise<Job | undefined>;
  list(owner: string, filter?: { status?: JobStatus }): Promise<Job[]>;
  cancel(id: string, owner: string): Promise<Job | undefined>;
}

/** In-process store for tests and early development. The daemon uses job-record files. */
export class MemoryJobStore implements JobStore {
  #jobs = new Map<string, Job>();

  async create(job: Omit<Job, 'createdAt' | 'lastUpdatedAt'>): Promise<Job> {
    const now = new Date().toISOString();
    const full: Job = { ...job, createdAt: now, lastUpdatedAt: now };
    this.#jobs.set(job.id, full);
    return full;
  }

  async get(id: string, owner: string): Promise<Job | undefined> {
    const job = this.#jobs.get(id);
    return job?.owner === owner ? job : undefined;
  }

  async list(owner: string, filter?: { status?: JobStatus }): Promise<Job[]> {
    return [...this.#jobs.values()].filter(
      (j) => j.owner === owner && (!filter?.status || j.status === filter.status),
    );
  }

  async cancel(id: string, owner: string): Promise<Job | undefined> {
    const job = await this.get(id, owner);
    if (!job) return undefined;
    const cancelled: Job = { ...job, status: 'cancelled', lastUpdatedAt: new Date().toISOString() };
    this.#jobs.set(id, cancelled);
    return cancelled;
  }
}
