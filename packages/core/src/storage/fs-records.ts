import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import {
  isMissing,
  listDir,
  nameUnder,
  ownerKey,
  readJson,
  sweepDir,
  touch,
  under,
  writeJson,
} from './fs-util.ts';
import type {
  Collection,
  CollectionScope,
  CollectionSpec,
  RecordChange,
  RecordEntry,
  RecordLog,
  Records,
} from './records.ts';

/** The home every account has on a filesystem deployment: the one data root. */
export const FS_HOME = 'local';

/**
 * Records as JSON files under the data root, where they always were: a record's last use is its
 * file's mtime, insertOnce is an exclusive create, and update and compare-and-set are one write
 * at a time within this process (servers sharing a data root never write the same record, as
 * before).
 */
export class FsRecords implements Records {
  readonly root: string;
  /** One read-modify-write of a record file at a time. */
  readonly #queues = new Map<string, Promise<unknown>>();

  /** The root as blob fields' paths are written from it: as configured, relative or not. */
  readonly #pathsFrom: string;

  constructor(root: string, options: { pathsFrom?: string } = {}) {
    this.root = resolve(root);
    this.#pathsFrom = options.pathsFrom ?? this.root;
  }

  collection<T>(spec: CollectionSpec<T>, scope: CollectionScope = {}): Collection<T> {
    return new FsCollection<T>(
      { root: this.root, pathsFrom: this.#pathsFrom },
      this.#dir(spec, scope),
      spec,
      (file, work) => this.#oneAtATime(file, work),
    );
  }

  log<T>(spec: CollectionSpec<T>, scope: CollectionScope & { part?: string }): RecordLog<T> {
    return new FsLog<T>(this.#dir(spec, scope), spec.fs.ext ?? '.jsonl', scope.part ?? 'log');
  }

  async parents<T>(
    spec: CollectionSpec<T>,
    scope: Pick<CollectionScope, 'owner'> = {},
  ): Promise<string[]> {
    const dir = this.#parents(spec, scope);
    if (!dir) return [];
    // Only folders with a name a parent can have: a stray file is nobody's group.
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    return entries.filter((e) => e.isDirectory() && named(e.name)).map((e) => e.name);
  }

  async expireParents<T>(
    spec: CollectionSpec<T>,
    scope: Pick<CollectionScope, 'owner'>,
    ttlMs: number,
  ): Promise<string[]> {
    const dir = this.#parents(spec, scope);
    return dir ? sweepDir(dir, ttlMs) : [];
  }

  /** The folder the parents are entries of: the layout up to where the parent's name goes. */
  #parents<T>(spec: CollectionSpec<T>, scope: Pick<CollectionScope, 'owner'>): string | undefined {
    if (typeof spec.fs.dir !== 'function') return undefined;
    const mark = '\0parent\0';
    const parts = spec.fs.dir(mark).split('/');
    const at = parts.indexOf(mark);
    if (at < 0) return undefined;
    return join(this.#base(spec, scope), ...parts.slice(0, at));
  }

  /** The owner's folder goes whole: its records, and with them the files kept beside them. */
  async forget(owner: string): Promise<void> {
    await rm(join(this.root, 'owners', ownerKey(owner)), { recursive: true, force: true });
  }

  async owners(): Promise<string[]> {
    // A stray file among the owners' folders (`.DS_Store`) is not an owner.
    return (await listDir(join(this.root, 'owners'))).filter((n) =>
      /^[A-Za-z0-9_-]{1,64}$/.test(n),
    );
  }

  async home(_owner: string): Promise<string> {
    return FS_HOME;
  }

  /** Servers sharing a data root each do their own periodic work, as they always did. */
  async leader(_name: string): Promise<boolean> {
    return true;
  }

  async ready(): Promise<void> {}

  async close(): Promise<void> {}

  /**
   * Writes a record as it was, with its last use (its file's mtime): for moving a data root's
   * records in (the migration), as the MongoDB store's `restore` does.
   */
  async restore<T>(
    spec: CollectionSpec<T>,
    scope: CollectionScope,
    id: string,
    value: T,
    usedAt: Date,
  ): Promise<void> {
    await new FsCollection<T>(
      { root: this.root, pathsFrom: this.#pathsFrom },
      this.#dir(spec, scope),
      spec,
      (file, work) => this.#oneAtATime(file, work),
    ).restore(id, value, usedAt);
  }

  /**
   * Writes one part of a log whole, as it was, with its last write (the part's file's mtime):
   * for the migration. What the part held before is replaced.
   */
  async restoreLog<T>(
    spec: CollectionSpec<T>,
    scope: CollectionScope & { part: string },
    entries: readonly { entry: T }[],
    usedAt: Date,
  ): Promise<void> {
    const file = join(this.#dir(spec, scope), `${safe(scope.part)}${spec.fs.ext ?? '.jsonl'}`);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.restore.tmp`;
    const text = entries.map(({ entry }) => `${JSON.stringify(entry)}\n`).join('');
    await writeFile(temp, text, { mode: 0o600 });
    await utimes(temp, usedAt, usedAt);
    await rename(temp, file);
  }

  #base<T>(spec: CollectionSpec<T>, scope: Pick<CollectionScope, 'owner'>): string {
    if (spec.scope === 'global') return this.root;
    if (!scope.owner) throw new Error(`Collection ${spec.name} is kept per owner`);
    return join(this.root, 'owners', ownerKey(scope.owner));
  }

  #dir<T>(spec: CollectionSpec<T>, scope: CollectionScope): string {
    let dir: string;
    if (typeof spec.fs.dir === 'function') {
      if (!scope.parent) throw new Error(`Collection ${spec.name} is kept under a parent`);
      safe(scope.parent);
      dir = spec.fs.dir(scope.parent);
    } else dir = spec.fs.dir;
    return join(this.#base(spec, scope), ...dir.split('/').filter(Boolean));
  }

  async #oneAtATime<R>(file: string, work: () => Promise<R>): Promise<R> {
    const before = this.#queues.get(file) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.catch(() => undefined);
    this.#queues.set(file, settled);
    try {
      return await run;
    } finally {
      if (this.#queues.get(file) === settled) this.#queues.delete(file);
    }
  }
}

/** An id is one file or folder name: no separators, not hidden. */
function named(id: string): boolean {
  return Boolean(id) && !/[/\\\0]/.test(id) && !id.startsWith('.');
}

/** A caller's id, refused when it is not one. Listings skip such names instead. */
function safe(id: string): string {
  if (!named(id)) throw new Error(`Not a record id: ${id}`);
  return id;
}

class FsCollection<T> implements Collection<T> {
  readonly #dir: string;
  readonly #leaf: string | undefined;
  readonly #ext: string;
  /** Records sit directly in the owner's folder (or the root), among other things. */
  readonly #shared: boolean;
  readonly #locked: <R>(file: string, work: () => Promise<R>) => Promise<R>;

  /** The data root, and the fields kept on disk as file paths under it (see CollectionSpec). */
  readonly #root: string;
  readonly #blobs: readonly string[];

  readonly #pathsFrom: string;
  /** What a path written from a relative data root starts with; undefined for an absolute one. */
  readonly #relative: string | undefined;

  constructor(
    { root, pathsFrom }: { root: string; pathsFrom: string },
    dir: string,
    spec: CollectionSpec<T>,
    locked: <R>(file: string, work: () => Promise<R>) => Promise<R>,
  ) {
    this.#root = root;
    this.#pathsFrom = pathsFrom;
    const given = normalize(pathsFrom);
    this.#relative = isAbsolute(given) || given === '.' ? undefined : `${given}${sep}`;
    this.#blobs = spec.blobs ?? [];
    this.#dir = dir;
    this.#leaf = spec.fs.leaf;
    this.#ext = spec.fs.ext ?? '.json';
    this.#shared = typeof spec.fs.dir === 'string' && spec.fs.dir === '';
    this.#locked = locked;
  }

  #file(id: string): string {
    return this.#leaf
      ? join(this.#dir, safe(id), this.#leaf)
      : join(this.#dir, `${safe(id)}${this.#ext}`);
  }

  /** A record as callers see it: a blob field's file path under the root is the blob's key. */
  #read<V>(stored: V): V {
    if (!this.#blobs.length || !stored || typeof stored !== 'object') return stored;
    const value = stored as Record<string, unknown>;
    for (const field of this.#blobs) {
      const ref = value[field];
      if (typeof ref !== 'string' || !ref) continue;
      // A path: absolute, or, written from a relative data root, starting with that root.
      const key = isAbsolute(ref)
        ? nameUnder(this.#root, ref)
        : this.#relative && ref.startsWith(this.#relative)
          ? nameUnder(this.#root, resolve(ref))
          : undefined;
      if (key) value[field] = key;
    }
    return stored;
  }

  /** A record as the data root holds it: a blob field's key is the blob's file path. */
  #stored<V>(value: V): V {
    if (!this.#blobs.length || !value || typeof value !== 'object') return value;
    const out = { ...value } as Record<string, unknown>;
    for (const field of this.#blobs) {
      const ref = out[field];
      if (typeof ref === 'string' && ref && !isAbsolute(ref)) {
        out[field] = under(this.#pathsFrom, ref);
      }
    }
    return out as V;
  }

  async #load(file: string, options: { touch?: boolean } = {}): Promise<T | undefined> {
    return this.#read(await readJson<T>(file, options));
  }

  get(id: string, options: { touch?: boolean } = {}): Promise<T | undefined> {
    return this.#load(this.#file(id), options);
  }

  has(id: string): Promise<boolean> {
    return stat(this.#file(id)).then(
      () => true,
      () => false,
    );
  }

  async put(id: string, value: T): Promise<void> {
    await writeJson(this.#file(id), this.#stored(value));
  }

  insertOnce(id: string, value: T): Promise<boolean> {
    return writeJson(this.#file(id), this.#stored(value), { exclusive: true });
  }

  /** The record as it was, its file's mtime the last use given (see FsRecords.restore). */
  async restore(id: string, value: T, usedAt: Date): Promise<void> {
    const file = this.#file(id);
    await writeJson(file, this.#stored(value));
    await utimes(file, usedAt, usedAt);
  }

  update(id: string, change: RecordChange<T>): Promise<T | undefined> {
    const file = this.#file(id);
    return this.#locked(file, async () => {
      const current = await this.#load(file);
      if (current === undefined) return undefined;
      const next = { ...current, ...change.set } as Record<string, unknown>;
      for (const [field, by] of Object.entries(change.inc ?? {})) {
        next[field] = (typeof next[field] === 'number' ? next[field] : 0) + (by as number);
      }
      await writeJson(file, this.#stored(next));
      return next as T;
    });
  }

  compareAndSet(id: string, expected: Partial<T>, set: Partial<T>): Promise<boolean> {
    const file = this.#file(id);
    return this.#locked(file, async () => {
      const current = await this.#load(file);
      if (current === undefined || !matches(current, expected)) return false;
      await writeJson(file, this.#stored({ ...current, ...set }));
      return true;
    });
  }

  async delete(id: string): Promise<void> {
    await rm(this.#file(id), { force: true });
  }

  async clear(): Promise<void> {
    // Among an owner's other things only the records go; a folder of its own goes whole.
    if (this.#shared) for (const id of await this.ids()) await this.delete(id);
    else await rm(this.#dir, { recursive: true, force: true });
  }

  async ids(): Promise<string[]> {
    const names = await listDir(this.#dir);
    if (this.#leaf) return names.filter(named);
    return names
      .filter((n) => n.endsWith(this.#ext))
      .map((n) => n.slice(0, -this.#ext.length))
      .filter(named);
  }

  async find(where?: Partial<T>): Promise<RecordEntry<T>[]> {
    const out: RecordEntry<T>[] = [];
    for (const id of await this.ids()) {
      const file = this.#file(id);
      const [value, used] = await Promise.all([
        this.#load(file),
        stat(file).then(
          (s) => s.mtime,
          () => undefined,
        ),
      ]);
      if (value === undefined || used === undefined) continue;
      if (where && !matches(value, where)) continue;
      out.push({ id, value, usedAt: used });
    }
    return out;
  }

  touch(id: string): Promise<void> {
    return touch(this.#file(id));
  }

  usedAt(id: string): Promise<Date | undefined> {
    return stat(this.#file(id)).then(
      (s) => s.mtime,
      () => undefined,
    );
  }

  async expire(
    ttlMs: number,
    keep?: (id: string) => boolean,
    removed?: (id: string) => Promise<void>,
  ): Promise<string[]> {
    if (this.#leaf) {
      // A record's folder is as old as its record's last use; one without a record goes too.
      const gone: string[] = [];
      for (const id of await listDir(this.#dir)) {
        if (keep?.(id)) continue;
        const used = await stat(join(this.#dir, id, this.#leaf)).then(
          (s) => s.mtimeMs,
          () => undefined,
        );
        if (used !== undefined && used >= Date.now() - ttlMs) continue;
        await rm(join(this.#dir, id), { recursive: true, force: true });
        if (used === undefined) continue;
        gone.push(id);
        await removed?.(id);
      }
      return gone;
    }
    const record = (name: string) => name.endsWith(this.#ext);
    const id = (name: string) => (record(name) ? name.slice(0, -this.#ext.length) : name);
    const gone = await sweepDir(
      this.#dir,
      ttlMs,
      (name) =>
        // Among an owner's other things, only the records are this collection's to remove.
        record(name) ? Boolean(keep?.(id(name))) : this.#shared,
      removed && ((name) => removed(id(name))),
    );
    return gone.map(id);
  }
}

function matches<T>(value: T, expected: Partial<T>): boolean {
  return Object.entries(expected).every(
    ([field, want]) =>
      JSON.stringify((value as Record<string, unknown>)[field]) === JSON.stringify(want),
  );
}

class FsLog<T> implements RecordLog<T> {
  readonly #dir: string;
  readonly #ext: string;
  readonly #part: string;

  constructor(dir: string, ext: string, part: string) {
    this.#dir = dir;
    this.#ext = ext;
    this.#part = safe(part);
  }

  async append(entry: T): Promise<void> {
    const file = join(this.#dir, `${this.#part}${this.#ext}`);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async read(): Promise<T[]> {
    const entries: T[] = [];
    for (const name of (await listDir(this.#dir)).filter((n) => n.endsWith(this.#ext))) {
      const text = await readFile(join(this.#dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line) as T);
        } catch {}
      }
    }
    return entries;
  }

  async expire(ttlMs: number): Promise<void> {
    await sweepDir(this.#dir, ttlMs);
  }
}
