/**
 * One kind of record. `name` and `scope` say where it lives in any store; `fs` is where the
 * filesystem store keeps it, which is the layout existing data roots already have.
 */
export interface CollectionSpec<T> {
  /** The collection's name (a database collection where there is one). */
  readonly name: string;
  /** `owner`: each account has its own records. `global`: one set for the deployment. */
  readonly scope: 'owner' | 'global';
  /**
   * Filesystem layout, under the owner's folder (or the data root for `global`): a record is
   * `{dir}/{id}{ext}`, or `{dir}/{id}/{leaf}` when it has a folder of its own. `dir` takes the
   * collection's parent (a media id, a month) when records are grouped under one.
   */
  readonly fs: {
    dir: string | ((parent: string) => string);
    /** The record's file inside its own folder (`media.json`). */
    leaf?: string;
    /** Default `.json`. */
    ext?: string;
  };
  /** Never read: carries the record's type. */
  readonly type?: T;
}

export function defineCollection<T>(spec: Omit<CollectionSpec<T>, 'type'>): CollectionSpec<T> {
  return spec;
}

/** Which records of a collection: an account's, and a parent's where the collection has one. */
export interface CollectionScope {
  /** An owner, or an owner key. Required for `owner` collections. */
  owner?: string;
  /** The group the records sit under (analyses of one media, a month's meter entries). */
  parent?: string;
}

export interface RecordEntry<T> {
  id: string;
  value: T;
  /** When it was last written or touched: the clock its expiry runs on. */
  usedAt: Date;
}

/** Fields to set, and numbers to add, in one atomic write. */
export interface RecordChange<T> {
  set?: Partial<T>;
  inc?: { [K in keyof T]?: T[K] extends number | undefined ? number : never };
}

export interface Collection<T> {
  /** The record, or undefined. `touch` counts the read as a use. */
  get(id: string, options?: { touch?: boolean }): Promise<T | undefined>;
  /** Whether it exists. Never counts as a use. */
  has(id: string): Promise<boolean>;
  /** Writes the whole record, replacing any other. Counts as a use. */
  put(id: string, value: T): Promise<void>;
  /** Writes the record only when none has this id. Of concurrent callers, exactly one gets true. */
  insertOnce(id: string, value: T): Promise<boolean>;
  /**
   * Sets fields and adds to numbers in one write no other write to the record can interleave
   * with. Returns the record after it, or undefined when there is none.
   */
  update(id: string, change: RecordChange<T>): Promise<T | undefined>;
  /**
   * Sets fields only when every field of `expected` equals the record's now (compare-and-set).
   * False when the record is missing or differs.
   */
  compareAndSet(id: string, expected: Partial<T>, set: Partial<T>): Promise<boolean>;
  /** Removes it. A missing one is not an error. */
  delete(id: string): Promise<void>;
  /** Removes every record of the collection in this scope. */
  clear(): Promise<void>;
  /** Every id, in no order. */
  ids(): Promise<string[]>;
  /** Every record whose top-level fields equal `where`'s; all of them without it. */
  find(where?: Partial<T>): Promise<RecordEntry<T>[]>;
  /** Marks it used now. A missing one is not an error. */
  touch(id: string): Promise<void>;
  /** When it was last written or touched. */
  usedAt(id: string): Promise<Date | undefined>;
  /**
   * Removes records last used more than `ttlMs` ago; `keep` spares ids. Returns the ids removed.
   * On the filesystem a record that has a folder takes the folder with it.
   */
  expire(ttlMs: number, keep?: (id: string) => boolean): Promise<string[]>;
}

/** An append-only list of small entries (the call log). */
export interface RecordLog<T> {
  append(entry: T): Promise<void>;
  /** Every entry of every part, in no order; entries that don't parse are skipped. */
  read(): Promise<T[]>;
  /** Drops entries written more than `ttlMs` ago (the filesystem store: whole day files). */
  expire(ttlMs: number): Promise<void>;
}

/** Every record the server keeps. Callers hold collections, never files. */
export interface Records {
  collection<T>(spec: CollectionSpec<T>, scope?: CollectionScope): Collection<T>;
  /** An append-only log; `part` names the writer's own slice (a day and a node). */
  log<T>(spec: CollectionSpec<T>, scope: CollectionScope & { part?: string }): RecordLog<T>;
  /** The parents a grouped collection has records under (months of the meter). */
  parents<T>(spec: CollectionSpec<T>, scope?: Pick<CollectionScope, 'owner'>): Promise<string[]>;
  /**
   * Drops whole groups of a grouped collection whose last write is more than `ttlMs` ago (a
   * month of the meter, a day of sign-in steps). Returns the parents dropped.
   */
  expireParents<T>(
    spec: CollectionSpec<T>,
    scope: Pick<CollectionScope, 'owner'>,
    ttlMs: number,
  ): Promise<string[]>;
  /** The key of every owner the store holds anything for. */
  owners(): Promise<string[]>;
  /**
   * The account's home, where its files and the nodes that work on them are. One place for a
   * deployment on the filesystem.
   */
  home(owner: string): Promise<string>;
}
