import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The data root (`/data` in the image). Everything durable is a file with a TTL; nothing here
 * is a project the user keeps. Layout:
 *
 *   owners/{owner}/timelines/{timeline_id}.json   24 h after last use
 *   owners/{owner}/media/{media_id}/…             7 d after last use
 *   owners/{owner}/jobs/{job_id}.json             7 d after finishing
 *   owners/{owner}/outputs/{job_id}/…             7 d
 *   cache/…                                       derived, disposable
 *
 * Hosted mode swaps the filesystem for object storage behind the same keys.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  /** Directory for one owner's data. Owner strings are hashed unless already safe. */
  ownerDir(owner: string, ...parts: string[]): string {
    return this.path('owners', ownerKey(owner), ...parts);
  }

  async readJson<T>(file: string, options: { touch?: boolean } = {}): Promise<T | undefined> {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (options.touch) await touch(file);
    return JSON.parse(text) as T;
  }

  /**
   * Crash-safe write: temp file, fsync, rename. With `exclusive`, an existing file is left alone
   * and the call returns false.
   */
  async writeJson(
    file: string,
    value: unknown,
    options: { exclusive?: boolean } = {},
  ): Promise<boolean> {
    await mkdir(dirname(file), { recursive: true });
    const body = `${JSON.stringify(value, null, 2)}\n`;
    if (options.exclusive) {
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    return true;
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async owners(): Promise<string[]> {
    return this.list(this.path('owners'));
  }

  /** Deletes entries of `dir` whose mtime is older than `ttlMs`. Returns how many went. */
  async sweep(dir: string, ttlMs: number, keep?: (name: string) => boolean): Promise<number> {
    const cutoff = Date.now() - ttlMs;
    let removed = 0;
    for (const name of await this.list(dir)) {
      if (keep?.(name)) continue;
      const full = join(dir, name);
      try {
        const s = await stat(full);
        if (s.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force: true });
          removed += 1;
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return removed;
  }
}

export async function touch(path: string): Promise<void> {
  const now = new Date();
  try {
    await utimes(path, now, now);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function ownerKey(owner: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(owner)) return owner;
  return `h_${createHash('sha256').update(owner).digest('hex').slice(0, 32)}`;
}
