import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

// The filesystem stores' file handling: crash-safe JSON files whose mtime is their last use.

export async function readJson<T>(
  file: string,
  options: { touch?: boolean } = {},
): Promise<T | undefined> {
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
export async function writeJson(
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
  // Unique per write: two writers of one file in the same millisecond (a heartbeat and a
  // cancel) must never share a temp file, or one rename fails.
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
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

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Deletes entries of `dir` whose mtime is older than `ttlMs`. Returns the names that went. */
export async function sweepDir(
  dir: string,
  ttlMs: number,
  keep?: (name: string) => boolean,
  /** Told of each entry as it goes, before the next is looked at. */
  each?: (name: string) => Promise<void>,
): Promise<string[]> {
  const cutoff = Date.now() - ttlMs;
  const removed: string[] = [];
  for (const name of await listDir(dir)) {
    if (keep?.(name)) continue;
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true });
        removed.push(name);
      } else continue;
    } catch (error) {
      if (!isMissing(error)) throw error;
      continue;
    }
    await each?.(name);
  }
  return removed;
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

/** The store name of a file under the root, or undefined for a path outside it. */
export function nameUnder(root: string, path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** The local file of a store name (a blob key, a record's place): its parts under the root. */
export function under(root: string, name: string): string {
  const parts = name.split('/').filter(Boolean);
  if (name.startsWith('/') || parts.some((p) => p === '..' || p === '.' || p.includes('\0'))) {
    throw new Error(`Not a store name: ${name}`);
  }
  return join(root, ...parts);
}
