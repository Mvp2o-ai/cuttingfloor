import { randomUUID } from 'node:crypto';
import type { CallEntry } from '@cuttingfloor/server';
import { type ActivityCall, type Ledger, LedgerMissing, LedgerRefused } from './ledger.ts';
import { clientName } from './lifecycle.ts';
import { isUser } from './rights.ts';

// Every tool call a signed-in account makes, free or billed, told to Kazi, which shows it on its
// admin page beside its own (activity contract v1, `POST /api/credits/activity`). A call is the
// tool, the app it came from, whether it worked (an error's code, never its message, which can
// echo what the user sent), when and how long. Calls wait in memory per account and go in batches:
// at 100, every 30 seconds, and on shutdown. A batch Kazi can't take is tried twice more and then
// dropped; losing a few to a crash is fine (this is activity, not money), holding up a call is not.

const BATCH = 100;
const FLUSH_MS = 30_000;
const RETRY_MS = [2_000, 10_000];
/** Batches waiting their turn at most; past it, during a long outage, new ones are dropped. */
const MAX_PENDING = 50;

export interface ActivityOptions {
  ledger: Pick<Ledger, 'activity'>;
  /** The owner's ledger account, when it is already known here without asking (given plans have none). */
  accountOf?: (owner: string) => string | undefined;
  flushMs?: number;
  retryMs?: number[];
  maxPending?: number;
}

export class Activity {
  readonly #o: ActivityOptions;
  readonly #waiting = new Map<string, ActivityCall[]>();
  /** The app each owner's latest request said it was. */
  readonly #clients = new Map<string, { name: string; from: 'client_info' | 'user_agent' }>();
  #sending: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: ActivityOptions) {
    this.#o = options;
  }

  start(): void {
    this.#timer = setInterval(() => void this.flush(), this.#o.flushMs ?? FLUSH_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /**
   * A signed-in owner's request came from `app`: their next calls are counted as its. A name the
   * app gave (MCP clientInfo) stands over one guessed from a User-Agent, which a 2025 client's
   * later requests fall back to.
   */
  usedFrom(owner: string, app: string, from: 'client_info' | 'user_agent' = 'client_info'): void {
    const name = clientName(app);
    if (!name) return;
    const known = this.#clients.get(owner);
    if (from === 'user_agent' && known?.from === 'client_info') return;
    this.#clients.set(owner, { name, from });
  }

  /** A tool call ended (a call-log line with its duration; job ends have none). */
  called(owner: string, entry: CallEntry): void {
    if (!isUser(owner) || entry.ms === undefined) return;
    const client = this.#clients.get(owner)?.name;
    const call: ActivityCall = {
      id: randomUUID(),
      tool: entry.tool,
      ...(client ? { client } : {}),
      ok: entry.ok,
      at: entry.at,
      duration_ms: entry.ms,
      ...(entry.error ? { error: entry.error.code.slice(0, 64) } : {}),
    };
    const calls = this.#waiting.get(owner) ?? [];
    calls.push(call);
    this.#waiting.set(owner, calls);
    if (calls.length >= BATCH) this.#send(owner);
  }

  /** Sends everything waiting, and answers once every batch has gone or been given up. */
  flush(): Promise<void> {
    for (const owner of [...this.#waiting.keys()]) this.#send(owner);
    return this.#sending.then(() => undefined);
  }

  #send(owner: string): void {
    const calls = this.#waiting.get(owner)?.splice(0, BATCH) ?? [];
    if (!this.#waiting.get(owner)?.length) this.#waiting.delete(owner);
    if (!calls.length) return;
    const account_id = this.#o.accountOf?.(owner);
    const body = { workos_user_id: owner, ...(account_id ? { account_id } : {}), calls };
    if (this.#pending >= (this.#o.maxPending ?? MAX_PENDING)) {
      process.stderr.write(`activity: ${owner}: ${calls.length} calls dropped: Kazi is behind\n`);
      return;
    }
    // One batch at a time, so a slow Kazi never has many requests open.
    this.#pending++;
    this.#sending = this.#sending
      .then(() => this.#post(owner, body))
      .finally(() => this.#pending--);
  }

  async #post(owner: string, body: Parameters<Ledger['activity']>[0]): Promise<void> {
    const waits = this.#o.retryMs ?? RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#o.ledger.activity(body);
        return;
      } catch (error) {
        const last =
          error instanceof LedgerMissing ||
          error instanceof LedgerRefused ||
          attempt >= waits.length;
        if (last) {
          process.stderr.write(
            `activity: ${owner}: ${body.calls.length} calls dropped: ${(error as Error).message}\n`,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
      }
    }
  }
}
