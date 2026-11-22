import { randomBytes } from 'node:crypto';
import type { Db, Document, Filter, MongoClient, Collection as MongoCollection } from 'mongodb';
import { ownerKey } from './fs-util.ts';
import {
  type Collection,
  type CollectionScope,
  type CollectionSpec,
  definedCollections,
  type RecordChange,
  type RecordEntry,
  type RecordLog,
  type Records,
} from './records.ts';

// Records in MongoDB, for deployments of more than one server. The driver is loaded on the first
// connection, so a server on the filesystem store never loads it.
//
// One database collection per spec name. A record is one document:
//
//   _id      "{kind/}{owner/}{parent/}{id}"   unique, so insertOnce is an insert
//   id       the record's id
//   owner    the owner's key (collections kept per owner)
//   parent   the group it sits under (grouped collections)
//   kind     the spec's kind (collections two kinds of record share)
//   used_at  when it was last written or touched: the clock its expiry runs on
//   v        the record itself, as callers wrote it (blob fields hold keys)
//
// A log entry is `{ _id: ObjectId, owner, part, at, v }`. `locks` holds the leases:
// `{ _id: name, holder, node, until }`.

export interface MongoRecordsOptions {
  /** A `mongodb://` or `mongodb+srv://` connection string. Never logged or put in an error. */
  uri: string;
  /** The database. Default `cuttingfloor`. */
  db?: string;
  /** The home every account has until accounts carry their own. Default `fsn1`. */
  home?: string;
  /**
   * A read that counts as a use writes the record's last use only when the one stored is older
   * than this, so reads don't become writes. A record may therefore expire up to this much
   * sooner than its last read alone would have it. Default one hour.
   */
  touchEveryMs?: number;
  /** How long a lease lasts when its holder stops renewing it. Default 60 s. */
  leaseMs?: number;
  /** This server's name, kept with the leases it holds. */
  node?: string;
  /** How long to look for the database before giving up. Default 10 s. */
  connectTimeoutMs?: number;
}

export const MONGO_HOME = 'fsn1';
const LOCKS = 'locks';
const DAY_S = 86_400;

interface Stored {
  _id: string;
  id: string;
  owner?: string;
  parent?: string;
  kind?: string;
  used_at: Date;
  v: unknown;
}

interface Place {
  /** The fields every record of this collection in this scope has. */
  scope: { owner?: string; parent?: string; kind?: string };
  /** What a record's `_id` starts with. */
  prefix: string;
}

/**
 * A connection string from its parts: `host` alone is a cluster's SRV name
 * (`cluster.x.mongodb.net`); with a port or several hosts it is taken as plain hosts.
 */
export function mongoUri(parts: { host: string; user?: string; password?: string }): string {
  const given = /^(mongodb(?:\+srv)?):\/\/(.*)$/.exec(parts.host.trim());
  const host = (given?.[2] ?? parts.host.trim()).replace(/\/+$/, '');
  const scheme = given?.[1] ?? (/[:,]/.test(host) ? 'mongodb' : 'mongodb+srv');
  const login = parts.user
    ? `${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password ?? '')}@`
    : '';
  return `${scheme}://${login}${host}/?retryWrites=true&w=majority`;
}

/** An error's message with no sign-in in it, whatever the driver put there. */
function scrub(message: string, uri: string): string {
  let out = message.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/g, '$1');
  const login = /^mongodb(?:\+srv)?:\/\/([^@/]*)@/.exec(uri)?.[1];
  if (login) {
    const [user = '', password = ''] = login.split(':');
    for (const secret of [password, safeDecode(password), user, safeDecode(user)]) {
      if (secret.length >= 3) out = out.split(secret).join('***');
    }
  }
  return out;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function duplicate(error: unknown): boolean {
  return (error as { code?: number } | undefined)?.code === 11000;
}

/** An id is one name: no separators, not hidden (the same ids the filesystem store takes). */
function safe(id: string): string {
  if (!id || /[/\\\0]/.test(id) || id.startsWith('.')) throw new Error(`Not a record id: ${id}`);
  return id;
}

/** A record's own field, as a path in its document. */
function path(field: string): string {
  if (!field || field.startsWith('$') || /[.\0]/.test(field)) {
    throw new Error(`Not a record field: ${field}`);
  }
  return `v.${field}`;
}

/** A value as a JSON file would hold it: what the filesystem store gives back for the same write. */
function plain<V>(value: V): V {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as V);
}

const grouped = (spec: CollectionSpec<unknown>) => typeof spec.fs.dir === 'function';

export class MongoRecords implements Records {
  readonly #o: Required<Omit<MongoRecordsOptions, 'node'>> & { node: string };
  #db: Promise<Db> | undefined;
  #client: MongoClient | undefined;
  /** Collections whose indexes this process has asked for. */
  readonly #prepared = new Map<string, Promise<void>>();
  /** This process in the leases it holds. */
  readonly #holder: string;
  /** The leases held, each with the timer that renews it. */
  readonly #leases = new Map<string, NodeJS.Timeout>();
  #closed = false;

  constructor(options: MongoRecordsOptions) {
    this.#o = {
      uri: options.uri,
      db: options.db ?? 'cuttingfloor',
      home: options.home ?? MONGO_HOME,
      touchEveryMs: options.touchEveryMs ?? 3_600_000,
      leaseMs: options.leaseMs ?? 60_000,
      node: options.node ?? 'node',
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
    };
    this.#holder = `${this.#o.node}.${randomBytes(6).toString('hex')}`;
  }

  /** The database, connecting on first use. For this store's own code, tests and the migration. */
  database(): Promise<Db> {
    if (this.#closed) return Promise.reject(new Error('The record store is closed'));
    this.#db ??= this.#connect().catch((error: unknown) => {
      this.#db = undefined;
      throw error;
    });
    return this.#db;
  }

  async #connect(): Promise<Db> {
    const { uri, db, connectTimeoutMs } = this.#o;
    try {
      const { MongoClient } = await import('mongodb');
      const client = new MongoClient(uri, {
        appName: 'cuttingfloor',
        ignoreUndefined: true,
        serverSelectionTimeoutMS: connectTimeoutMs,
      });
      await client.connect();
      this.#client = client;
      return client.db(db);
    } catch (error) {
      // Never the driver's own error: its message or fields may carry the connection string.
      throw new Error(`MongoDB: ${scrub((error as Error).message ?? 'cannot connect', uri)}`);
    }
  }

  collection<T>(spec: CollectionSpec<T>, scope: CollectionScope = {}): Collection<T> {
    const place = this.#place(spec, scope, true);
    return new MongoCollectionOf<T>(
      () => this.#handle<Stored>(spec as CollectionSpec<unknown>),
      place,
      this.#o.touchEveryMs,
    );
  }

  log<T>(spec: CollectionSpec<T>, scope: CollectionScope & { part?: string }): RecordLog<T> {
    const { scope: where } = this.#place(spec, scope, false);
    return new MongoLog<T>(() => this.#handle<Document>(spec as CollectionSpec<unknown>, true), {
      ...where,
      part: safe(scope.part ?? 'log'),
    });
  }

  async parents<T>(
    spec: CollectionSpec<T>,
    scope: Pick<CollectionScope, 'owner'> = {},
  ): Promise<string[]> {
    if (!grouped(spec as CollectionSpec<unknown>)) return [];
    const { scope: where } = this.#place(spec, scope, false);
    const col = await this.#handle<Stored>(spec as CollectionSpec<unknown>);
    const names = await col.distinct('parent', where as Filter<Stored>);
    return names.filter((name): name is string => typeof name === 'string');
  }

  async expireParents<T>(
    spec: CollectionSpec<T>,
    scope: Pick<CollectionScope, 'owner'>,
    ttlMs: number,
  ): Promise<string[]> {
    if (!grouped(spec as CollectionSpec<unknown>)) return [];
    const { scope: where } = this.#place(spec, scope, false);
    const col = await this.#handle<Stored>(spec as CollectionSpec<unknown>);
    const cutoff = new Date(Date.now() - ttlMs);
    // A group is as old as its newest record.
    const old = await col
      .aggregate<{ _id: string }>([
        { $match: where },
        { $group: { _id: '$parent', last: { $max: '$used_at' } } },
        { $match: { last: { $lt: cutoff } } },
      ])
      .toArray();
    const gone: string[] = [];
    for (const { _id: parent } of old) {
      if (typeof parent !== 'string') continue;
      // Only what was there when the group was found old: a record written since stays.
      await col.deleteMany({ ...where, parent, used_at: { $lt: cutoff } } as Filter<Stored>);
      gone.push(parent);
    }
    return gone;
  }

  /** Every record with the owner's key goes, in every collection (global ones hold none). */
  async forget(owner: string): Promise<void> {
    const db = await this.database();
    const key = ownerKey(owner);
    for (const name of await this.#collections(db)) {
      await db.collection(name).deleteMany({ owner: key });
    }
  }

  async owners(): Promise<string[]> {
    const db = await this.database();
    const keys = new Set<string>();
    for (const name of await this.#collections(db)) {
      for (const key of await db.collection(name).distinct('owner')) {
        if (typeof key === 'string') keys.add(key);
      }
    }
    return [...keys];
  }

  async #collections(db: Db): Promise<string[]> {
    const all = await db.listCollections({}, { nameOnly: true }).toArray();
    return all.map((c) => c.name).filter((name) => name !== LOCKS && !name.startsWith('system.'));
  }

  async home(_owner: string): Promise<string> {
    return this.#o.home;
  }

  /**
   * Takes the lease `name` when it is free, expired or already this process's, and keeps it
   * renewed. The database's clock decides, so servers' clocks need not agree.
   */
  async leader(name: string): Promise<boolean> {
    const db = await this.database();
    const locks = db.collection<{ _id: string }>(LOCKS);
    const { leaseMs, node } = this.#o;
    try {
      await locks.updateOne(
        {
          _id: safe(name),
          $or: [{ holder: this.#holder }, { $expr: { $lt: ['$until', '$$NOW'] } }],
        },
        [{ $set: { holder: this.#holder, node, until: { $add: ['$$NOW', leaseMs] } } }],
        { upsert: true },
      );
    } catch (error) {
      // Held by another: the upsert found no lease to take and could not make a second.
      if (duplicate(error)) return this.#lost(name);
      throw error;
    }
    if (!this.#leases.has(name) && !this.#closed) {
      const renew = setInterval(
        () => {
          locks
            .updateOne({ _id: name, holder: this.#holder }, [
              { $set: { until: { $add: ['$$NOW', leaseMs] } } },
            ])
            .then(
              (result) => {
                if (result.matchedCount === 0) this.#lost(name);
              },
              // Unreachable for now: the lease runs out by itself if this goes on.
              () => undefined,
            );
        },
        Math.max(1000, Math.floor(leaseMs / 3)),
      );
      renew.unref();
      this.#leases.set(name, renew);
    }
    return true;
  }

  #lost(name: string): false {
    const renew = this.#leases.get(name);
    if (renew) clearInterval(renew);
    this.#leases.delete(name);
    return false;
  }

  /** Connects, and prepares every collection defined so far (the rest as they are first used). */
  async ready(): Promise<void> {
    await this.database();
    await Promise.all(definedCollections().map((spec) => this.#prepare(spec)));
  }

  /** Resolves once the indexes asked for so far are made (or have failed and said so). */
  async idle(): Promise<void> {
    await Promise.allSettled(this.#prepared.values());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const held = [...this.#leases.keys()];
    for (const name of held) this.#lost(name);
    const connected = this.#db;
    if (connected) {
      await Promise.allSettled(this.#prepared.values());
      try {
        const db = await connected;
        // Handed back now, so another server takes the work over without waiting the lease out.
        if (held.length) await db.collection(LOCKS).deleteMany({ holder: this.#holder });
      } catch {
        // Never connected, or gone already: nothing to let go of.
      }
    }
    this.#closed = true;
    await this.#client?.close().catch(() => undefined);
  }

  /**
   * Writes a record as it was, with its last use: for moving a data root's records in (the
   * migration), and for tests that need an old record.
   */
  async restore<T>(
    spec: CollectionSpec<T>,
    scope: CollectionScope,
    id: string,
    value: T,
    usedAt: Date,
  ): Promise<void> {
    const place = this.#place(spec, scope, true);
    const col = await this.#handle<Stored>(spec as CollectionSpec<unknown>);
    const _id = `${place.prefix}${safe(id)}`;
    await col.replaceOne(
      { _id },
      { ...place.scope, id, used_at: usedAt, v: plain(value) },
      { upsert: true },
    );
  }

  /** Where a spec's records are for a scope. `whole` asks for the parent of a grouped one too. */
  #place<T>(spec: CollectionSpec<T>, scope: CollectionScope, whole: boolean): Place {
    const out: Place['scope'] = {};
    const parts: string[] = [];
    if (spec.kind) {
      out.kind = safe(spec.kind);
      parts.push(out.kind);
    }
    if (spec.scope === 'owner') {
      if (!scope.owner) throw new Error(`Collection ${spec.name} is kept per owner`);
      out.owner = ownerKey(scope.owner);
      parts.push(out.owner);
    }
    if (whole && grouped(spec as CollectionSpec<unknown>)) {
      if (!scope.parent) throw new Error(`Collection ${spec.name} is kept under a parent`);
      out.parent = safe(scope.parent);
      parts.push(out.parent);
    }
    return { scope: out, prefix: parts.length ? `${parts.join('/')}/` : '' };
  }

  async #handle<D extends Document>(
    spec: CollectionSpec<unknown>,
    log = false,
  ): Promise<MongoCollection<D>> {
    const db = await this.database();
    // Indexes only make reads cheaper (uniqueness is the `_id`), so nothing waits for them.
    void this.#prepare(spec, log);
    return db.collection<D>(spec.name);
  }

  /** The collection's indexes, asked for once per process; asking again changes nothing. */
  #prepare(spec: CollectionSpec<unknown>, log = false): Promise<void> {
    const name = `${spec.name}\0${spec.kind ?? ''}\0${log ? 'log' : ''}`;
    let done = this.#prepared.get(name);
    if (!done) {
      done = this.#indexes(spec, log || spec.fs.ext === '.jsonl').catch((error: Error) => {
        this.#prepared.delete(name);
        process.stderr.write(
          `records: ${spec.name}: indexes: ${scrub(error.message, this.#o.uri)}\n`,
        );
      });
      this.#prepared.set(name, done);
    }
    return done;
  }

  async #indexes(spec: CollectionSpec<unknown>, log: boolean): Promise<void> {
    const col = (await this.database()).collection(spec.name);
    const owner: Record<string, 1> = spec.scope === 'owner' ? { owner: 1 } : {};
    const clock = log ? 'at' : 'used_at';
    const ttlMs = spec.db?.ttlMs;
    const scope: Record<string, 1> = {
      ...owner,
      ...(grouped(spec) && !log ? { parent: 1 as const } : {}),
      [clock]: 1,
    };
    const wanted: Array<{ key: Record<string, 1>; name: string }> = [];
    // A global collection's scope index is the clock alone, which the backstop's index also is.
    if (!ttlMs || Object.keys(scope).length > 1) wanted.push({ key: scope, name: 'scope' });
    for (const fields of spec.db?.indexes ?? []) {
      wanted.push({
        key: { ...owner, ...Object.fromEntries(fields.map((f) => [path(f), 1])) },
        name: `by_${fields.join('_')}`,
      });
    }
    for (const fields of spec.db?.indexesAcross ?? []) {
      wanted.push({
        key: Object.fromEntries(fields.map((f) => [path(f), 1])),
        name: `across_${fields.join('_')}`,
      });
    }
    if (wanted.length) await col.createIndexes(wanted);
    if (!ttlMs) return;
    // A day behind the sweep, which decides (and tells whoever asked to hear of each record).
    const expireAfterSeconds = Math.ceil(ttlMs / 1000) + DAY_S;
    try {
      await col.createIndex({ [clock]: 1 }, { name: 'ttl', expireAfterSeconds });
    } catch (error) {
      // There already with another life: the life is changed in place.
      const code = (error as { code?: number }).code;
      if (code !== 85 && code !== 86) throw error;
      await (await this.database()).command({
        collMod: spec.name,
        index: { keyPattern: { [clock]: 1 }, expireAfterSeconds },
      });
    }
  }
}

class MongoCollectionOf<T> implements Collection<T> {
  readonly #col: () => Promise<MongoCollection<Stored>>;
  readonly #place: Place;
  readonly #touchEveryMs: number;

  constructor(col: () => Promise<MongoCollection<Stored>>, place: Place, touchEveryMs: number) {
    this.#col = col;
    this.#place = place;
    this.#touchEveryMs = touchEveryMs;
  }

  #key(id: string): string {
    return `${this.#place.prefix}${safe(id)}`;
  }

  get #scope(): Filter<Stored> {
    return this.#place.scope as Filter<Stored>;
  }

  async get(id: string, options: { touch?: boolean } = {}): Promise<T | undefined> {
    const _id = this.#key(id);
    const col = await this.#col();
    const doc = await col.findOne({ _id }, { projection: { v: 1, used_at: 1 } });
    if (!doc) return undefined;
    if (options.touch) await this.#touch(col, _id, doc.used_at);
    return doc.v as T;
  }

  /** Moves the last use to now, unless it was moved within `touchEveryMs` (by any server). */
  async #touch(col: MongoCollection<Stored>, _id: string, usedAt?: Date): Promise<void> {
    const now = Date.now();
    const stale = new Date(now - this.#touchEveryMs);
    if (usedAt && usedAt > stale) return;
    await col.updateOne({ _id, used_at: { $lte: stale } }, { $set: { used_at: new Date(now) } });
  }

  async has(id: string): Promise<boolean> {
    const _id = this.#key(id);
    return (await (await this.#col()).countDocuments({ _id }, { limit: 1 })) > 0;
  }

  async put(id: string, value: T): Promise<void> {
    const _id = this.#key(id);
    const col = await this.#col();
    const doc = { ...this.#place.scope, id, used_at: new Date(), v: plain(value) };
    try {
      await col.replaceOne({ _id }, doc, { upsert: true });
    } catch (error) {
      // Two first writes at once: one inserted, and this one now replaces it.
      if (!duplicate(error)) throw error;
      await col.replaceOne({ _id }, doc, { upsert: true });
    }
  }

  async insertOnce(id: string, value: T): Promise<boolean> {
    const _id = this.#key(id);
    const col = await this.#col();
    try {
      await col.insertOne({ _id, ...this.#place.scope, id, used_at: new Date(), v: plain(value) });
      return true;
    } catch (error) {
      if (duplicate(error)) return false;
      throw error;
    }
  }

  /** One update that sets fields (an undefined one is removed, as a JSON file drops it). */
  #change(set: Partial<T> | undefined, inc?: RecordChange<T>['inc']): Document[] {
    const fields: Record<string, unknown> = { used_at: { $literal: new Date() } };
    const unset: string[] = [];
    const given = (set ?? {}) as Record<string, unknown>;
    const adds = Object.entries((inc ?? {}) as Record<string, number>);
    for (const [field, value] of Object.entries(given)) {
      if (adds.some(([name]) => name === field)) continue;
      if (value === undefined) unset.push(path(field));
      else fields[path(field)] = { $literal: plain(value) };
    }
    for (const [field, by] of adds) {
      // Added to what the same change sets, or to the number there now; anything else counts as 0.
      const from =
        field in given
          ? typeof given[field] === 'number'
            ? given[field]
            : 0
          : { $cond: [{ $isNumber: `$${path(field)}` }, `$${path(field)}`, 0] };
      fields[path(field)] = { $add: [from, by] };
    }
    return [{ $set: fields }, ...(unset.length ? [{ $unset: unset }] : [])];
  }

  async update(id: string, change: RecordChange<T>): Promise<T | undefined> {
    const _id = this.#key(id);
    const doc = await (await this.#col()).findOneAndUpdate(
      { _id },
      this.#change(change.set, change.inc),
      { returnDocument: 'after', projection: { v: 1 } },
    );
    return doc ? (doc.v as T) : undefined;
  }

  async compareAndSet(id: string, expected: Partial<T>, set: Partial<T>): Promise<boolean> {
    const _id = this.#key(id);
    // Exact equality, as the filesystem store compares: a missing field equals only undefined.
    const same = Object.entries(expected as Record<string, unknown>).map(([field, want]) =>
      want === undefined
        ? { $eq: [{ $type: `$${path(field)}` }, 'missing'] }
        : { $eq: [`$${path(field)}`, { $literal: plain(want) }] },
    );
    const result = await (await this.#col()).updateOne(
      { _id, ...(same.length ? { $expr: { $and: same } } : {}) },
      this.#change(set),
    );
    return result.matchedCount === 1;
  }

  async delete(id: string): Promise<void> {
    const _id = this.#key(id);
    await (await this.#col()).deleteOne({ _id });
  }

  async clear(): Promise<void> {
    await (await this.#col()).deleteMany(this.#scope);
  }

  async ids(): Promise<string[]> {
    const docs = await (await this.#col())
      .find(this.#scope, { projection: { _id: 0, id: 1 } })
      .toArray();
    return docs.map((doc) => doc.id);
  }

  async find(where?: Partial<T>): Promise<RecordEntry<T>[]> {
    const wanted = Object.entries((where ?? {}) as Record<string, unknown>);
    const query: Record<string, unknown> = { ...this.#place.scope };
    for (const [field, want] of wanted) {
      query[path(field)] =
        want === undefined
          ? { $exists: false }
          : want === null
            ? { $type: 'null' }
            : { $eq: plain(want) };
    }
    const docs = await (await this.#col()).find(query as Filter<Stored>).toArray();
    return (
      docs
        // The query finds by index; the exact comparison is the filesystem store's own.
        .filter((doc) =>
          wanted.every(
            ([field, want]) =>
              JSON.stringify((doc.v as Record<string, unknown> | null)?.[field]) ===
              JSON.stringify(want),
          ),
        )
        .map((doc) => ({ id: doc.id, value: doc.v as T, usedAt: doc.used_at }))
    );
  }

  async touch(id: string): Promise<void> {
    const _id = this.#key(id);
    await this.#touch(await this.#col(), _id);
  }

  async usedAt(id: string): Promise<Date | undefined> {
    const _id = this.#key(id);
    const doc = await (await this.#col()).findOne({ _id }, { projection: { used_at: 1 } });
    return doc?.used_at;
  }

  async expire(
    ttlMs: number,
    keep?: (id: string) => boolean,
    removed?: (id: string) => Promise<void>,
  ): Promise<string[]> {
    const col = await this.#col();
    const cutoff = new Date(Date.now() - ttlMs);
    const old = await col
      .find({ ...this.#scope, used_at: { $lt: cutoff } }, { projection: { id: 1 } })
      .toArray();
    const gone: string[] = [];
    for (const { _id, id } of old) {
      if (keep?.(id)) continue;
      // Still old: a record another server used since it was found stays.
      const { deletedCount } = await col.deleteOne({ _id, used_at: { $lt: cutoff } });
      if (!deletedCount) continue;
      gone.push(id);
      await removed?.(id);
    }
    return gone;
  }
}

class MongoLog<T> implements RecordLog<T> {
  readonly #col: () => Promise<MongoCollection<Document>>;
  readonly #scope: { owner?: string; kind?: string; part: string };

  constructor(
    col: () => Promise<MongoCollection<Document>>,
    scope: { owner?: string; kind?: string; part: string },
  ) {
    this.#col = col;
    this.#scope = scope;
  }

  async append(entry: T): Promise<void> {
    await (await this.#col()).insertOne({ ...this.#scope, at: new Date(), v: plain(entry) });
  }

  async read(): Promise<T[]> {
    const { part: _part, ...all } = this.#scope;
    const docs = await (await this.#col()).find(all, { projection: { _id: 0, v: 1 } }).toArray();
    return docs.map((doc) => doc.v as T);
  }

  async expire(ttlMs: number): Promise<void> {
    const { part: _part, ...all } = this.#scope;
    await (await this.#col()).deleteMany({ ...all, at: { $lt: new Date(Date.now() - ttlMs) } });
  }
}
