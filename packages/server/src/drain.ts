import { stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CfError } from '@cuttingfloor/schema';

// Draining: the server takes no new work while what it runs ends, so its data can be copied one
// last time and traffic moved (the storage cutover). Reads, downloads, watch pages, job.get and
// media.list keep working; tool calls that write or start jobs, uploads and the account page's
// new uploads answer 503 with Retry-After. Turned on by CUTTINGFLOOR_DRAIN=1 at start, or with no
// restart by a file named `drain` in the data root (`touch /var/lib/cuttingfloor/drain`), and
// off again by removing it. While draining the server keeps a marker beside it, `draining`,
// with how many jobs still run.

/** The file in the data root that turns draining on while it exists. */
export const DRAIN_SWITCH = 'drain';
/** The marker a draining server keeps in the data root, rewritten every few seconds. */
export const DRAIN_MARKER = 'draining';
/** How long a refused caller is told to wait. */
export const DRAIN_RETRY_SECONDS = 120;
const CHECK_MS = 5_000;

export interface DrainMarker {
  since: string;
  at: string;
  node: string;
  jobs_running: number;
}

export class Drain {
  readonly #dir: string;
  readonly #forced: boolean;
  readonly #running: () => Promise<number>;
  readonly #node: string;
  #on: boolean;
  #since: string | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    dataDir: string;
    /** CUTTINGFLOOR_DRAIN=1: draining from the start, whatever the switch file says. */
    forced: boolean;
    node: string;
    /** Jobs still running on this server. */
    running: () => Promise<number>;
  }) {
    this.#dir = options.dataDir;
    this.#forced = options.forced;
    this.#running = options.running;
    this.#node = options.node;
    this.#on = options.forced;
  }

  /** Whether the server takes no new work now. */
  get active(): boolean {
    return this.#on;
  }

  /** Watches the switch file and keeps the marker. */
  start(): void {
    void this.check().catch(() => undefined);
    this.#timer = setInterval(() => void this.check().catch(() => undefined), CHECK_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Reads the switch and writes (or removes) the marker now. */
  async check(): Promise<void> {
    const switched = await stat(join(this.#dir, DRAIN_SWITCH)).then(
      () => true,
      () => false,
    );
    this.#on = this.#forced || switched;
    const marker = join(this.#dir, DRAIN_MARKER);
    if (!this.#on) {
      this.#since = undefined;
      await unlink(marker).catch(() => undefined);
      return;
    }
    this.#since ??= new Date().toISOString();
    const status: DrainMarker = {
      since: this.#since,
      at: new Date().toISOString(),
      node: this.#node,
      jobs_running: await this.#running(),
    };
    await writeFile(marker, `${JSON.stringify(status)}\n`).catch(() => undefined);
  }

  /** Where the server stands, for the status route. */
  async status(): Promise<{ draining: boolean; jobs_running: number; since?: string }> {
    return {
      draining: this.#on,
      jobs_running: await this.#running(),
      ...(this.#since ? { since: this.#since } : {}),
    };
  }
}

/** The refusal a draining server gives a call that writes: an outage, said plainly. */
export function drainingError(): CfError {
  return new CfError(
    'service_unavailable',
    'This server is being moved and takes no new work for a few minutes',
    {
      hint: `Reading, job.get and media.list still work; call again in ${DRAIN_RETRY_SECONDS / 60} minutes`,
      detail: { retry: true, retry_after_seconds: DRAIN_RETRY_SECONDS },
    },
  );
}
