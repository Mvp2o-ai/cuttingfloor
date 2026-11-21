import type { Workspace } from '@cuttingfloor/core';
import { clientName } from './lifecycle.ts';

// The apps an account's requests came from (ChatGPT, Claude, Kazi, a script…), each with when it
// was first and last seen, in `owners/{owner}/apps.json`. Written at most once a day per account
// and app on each server, so a busy account costs a write a day, not one a request.

export interface AppSeen {
  name: string;
  first_seen_at: string;
  last_seen_at: string;
}

export class AppsSeen {
  readonly #ws: Workspace;
  /** `owner app` → the UTC day this server last wrote it. */
  readonly #written = new Map<string, string>();
  #writes: Promise<unknown> = Promise.resolve();

  constructor(ws: Workspace) {
    this.#ws = ws;
  }

  seen(owner: string, app: string): void {
    const name = clientName(app);
    if (!name) return;
    const now = new Date().toISOString();
    const key = `${owner} ${name}`;
    if (this.#written.get(key) === now.slice(0, 10)) return;
    this.#written.set(key, now.slice(0, 10));
    // One write at a time on this server, so two apps of one account don't lose each other.
    this.#writes = this.#writes
      .then(async () => {
        const all = await this.read(owner);
        const found = all.find((a) => a.name === name);
        if (found) found.last_seen_at = now;
        else all.push({ name, first_seen_at: now, last_seen_at: now });
        await this.#ws.writeJson(this.#file(owner), all);
      })
      .catch((error: Error) => {
        this.#written.delete(key);
        process.stderr.write(`apps: ${owner}: ${error.message}\n`);
      });
  }

  /** The account's apps, most recently seen first. */
  async read(owner: string): Promise<AppSeen[]> {
    const all =
      (await this.#ws.readJson<AppSeen[]>(this.#file(owner)).catch(() => undefined)) ?? [];
    return all.sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  }

  #file(owner: string): string {
    return this.#ws.ownerDir(owner, 'apps.json');
  }
}
