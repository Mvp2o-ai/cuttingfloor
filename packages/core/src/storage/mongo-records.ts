import { randomBytes } from 'node:crypto';
import { CfError } from '@cuttingfloor/schema';
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
//   rev      a token every write changes, so a read-then-write can tell it was overtaken
//   v        the record itself, as callers wrote it (blob fields hold keys)
//   esc      true when strings or keys in `v` are escaped (see UNSTORABLE)
//
// A record is a document, so it holds up to the database's 16 MB; a bigger one is refused in
// plain words. What can be that big (a media's analyses) is kept as files, not records.
//
// A log entry is `{ _id: ObjectId, owner, part, at, v, esc }`. `locks` holds the leases:
// `{ _id: name, holder, node, until }`.

export interface MongoRecordsOptions {
  /** A `mongodb://` or `mongodb+srv://` connection string. Its sign-in is never logged or put in an error. */
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
/** The most a record's value may take in its document, under the database's 16 MB for the whole. */
const MAX_VALUE_BYTES = 16 * 1024 ** 2 - 64 * 1024;
/** Values whose JSON is under this are never measured: they cannot be near the limit. */
const MEASURE_FROM_BYTES = 1024 ** 2;

interface Stored {
  _id: string;
  id: string;
  owner?: string;
  parent?: string;
  kind?: string;
  used_at: Date;
  rev?: string;
  v: unknown;
  esc?: boolean;
}

/** A record's value as its document holds it. */
type Body = { v: unknown; esc?: true };

interface Place {
  /** The fields every record of this collection in this scope has. */
  scope: { owner?: string; parent?: string; kind?: string };
  /** What a record's `_id` starts with. */
  prefix: string;
}

/**
 * A connection string from its parts. `host` is taken as an Atlas cluster's SRV name only when
 * it ends in `.mongodb.net` and has no port; any other host (`mongo`, `localhost`,
 * `10.0.0.5:27017`, several with commas) is plain `mongodb://`. A host that starts with
 * `mongodb://` or `mongodb+srv://` says which itself.
 */
export function mongoUri(parts: { host: string; user?: string; password?: string }): string {
  const given = /^(mongodb(?:\+srv)?):\/\/(.*)$/.exec(parts.host.trim());
  const host = (given?.[2] ?? parts.host.trim()).replace(/\/+$/, '');
  const scheme = given?.[1] ?? (/^[^:,/]+\.mongodb\.net$/i.test(host) ? 'mongodb+srv' : 'mongodb');
  const login = parts.user
    ? `${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password ?? '')}@`
    : '';
  return `${scheme}://${login}${host}/?retryWrites=true&w=majority`;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The store could not be reached. Its message is safe to print. */
class StoreDown extends Error {}

/**
 * What went wrong, for the server's log, with no sign-in in it whatever the driver wrote: the
 * error's kind and code, and its message with the connection string's user and password taken
 * out. A password too short to take out of a sentence safely leaves only the kind and code.
 */
function describe(error: unknown, uri: string): string {
  if (error instanceof StoreDown) return error.message;
  const e = error as { name?: string; code?: unknown; codeName?: string; message?: string };
  const kind = [e?.name ?? 'Error', e?.codeName ?? (e?.code !== undefined ? String(e.code) : '')]
    .filter(Boolean)
    .join(' ');
  const login = /^mongodb(?:\+srv)?:\/\/([^@/]*)@/.exec(uri)?.[1];
  let text = String(e?.message ?? '').replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/g, '$1');
  if (login !== undefined) {
    // The password is everything after the first colon, colons and all.
    const colon = login.indexOf(':');
    const user = colon < 0 ? login : login.slice(0, colon);
    const password = colon < 0 ? '' : login.slice(colon + 1);
    const secrets = [password, safeDecode(password)].filter(Boolean);
    if (secrets.some((secret) => secret.length < 4 && text.includes(secret))) return kind;
    for (const secret of [...secrets, user, safeDecode(user)]) {
      if (secret.length >= 3 || secrets.includes(secret)) text = text.split(secret).join('***');
    }
  }
  return text ? `${kind}: ${text}` : kind;
}

/** Whether an error is the database's or the driver's, not the caller's. */
function fromStore(error: unknown): boolean {
  const name = (error as { name?: unknown } | undefined)?.name;
  return error instanceof StoreDown || (typeof name === 'string' && /^(Mongo|BSON)/.test(name));
}

/** Whether the database or the driver refused a document for its size. */
function tooLarge(error: unknown): boolean {
  const e = error as { code?: number; message?: string } | undefined;
  return (
    e?.code === 10334 ||
    e?.code === 17419 ||
    e?.code === 17420 ||
    /larger than the maximum size|too large|exceeds maximum/i.test(e?.message ?? '')
  );
}

function duplicate(error: unknown): boolean {
  return (error as { code?: number } | undefined)?.code === 11000;
}

/** An id is one name: no separators, not hidden (the same ids the filesystem store takes). */
function safe(id: string): string {
  if (!id || /[/\\\0]/.test(id) || id.startsWith('.')) throw new Error(`Not a record id: ${id}`);
  return id;
}

// Strings the database cannot hold as given: a key with U+0000 is refused, and half of a
// surrogate pair on its own comes back as U+FFFD. Such a code unit is kept as U+F8FF and its
// four hex digits (and U+F8FF itself the same way, so reading back is never in doubt), in keys
// and in strings alike.
const ESC = '';
const UNSTORABLE = /|\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const ESCAPED = /([0-9a-f]{4})/g;
/** The same in JSON text, where a lone surrogate and U+0000 are written as `\u` escapes. */
const UNSTORABLE_JSON = /|\\u0000|\\ud[89a-f]/;

const escapeText = (text: string) =>
  text.replace(UNSTORABLE, (unit) => `${ESC}${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
const unescapeText = (text: string) =>
  text.includes(ESC)
    ? text.replace(ESCAPED, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    : text;

function mapStrings(value: unknown, text: (s: string) => string): unknown {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, text));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[text(key)] = mapStrings(item, text);
    return out;
  }
  return value;
}

/**
 * A value as a JSON file would hold it (what the filesystem store gives back for the same
 * write), how big its JSON is, and the form its document holds.
 */
function pack(value: unknown): { plain: unknown; bytes: number; body: Body } {
  const json = JSON.stringify(value) ?? 'null';
  const plain: unknown = JSON.parse(json);
  const esc = UNSTORABLE_JSON.test(json);
  return {
    plain,
    bytes: Buffer.byteLength(json),
    body: esc ? { v: mapStrings(plain, escapeText), esc: true } : { v: plain },
  };
}

const unpack = (doc: { v?: unknown; esc?: boolean }) =>
  doc.esc ? mapStrings(doc.v, unescapeText) : doc.v;

/** A field an update can name as a path in the document; any other is changed by rewriting the record. */
function direct(field: string): boolean {
  return (
    Boolean(field) &&
    !field.startsWith('$') &&
    !field.includes('.') &&
    !UNSTORABLE_JSON.test(JSON.stringify(field))
  );
}

/** A record's own field, as a path in its document. */
function path(field: string): string {
  if (!direct(field)) throw new Error(`Not a record field: ${field}`);
  return `v.${field}`;
}

/** The filesystem store's comparison: a field equals when its JSON does. */
function matches(value: unknown, expected: object): boolean {
  return Object.entries(expected).every(
    ([field, want]) =>
      JSON.stringify((value as Record<string, unknown>)[field]) === JSON.stringify(want),
  );
}

/** The filesystem store's update: fields set, then numbers added (anything else counts as 0). */
function changed(current: unknown, change: RecordChange<unknown>): unknown {
  const next = { ...(current as object), ...(change.set as object) } as Record<string, unknown>;
  for (const [field, by] of Object.entries(change.inc ?? {})) {
    next[field] = (typeof next[field] === 'number' ? next[field] : 0) + (by as number);
  }
  return next;
}

const token = () => randomBytes(9).toString('base64url');
const grouped = (spec: CollectionSpec<unknown>) => typeof spec.fs.dir === 'function';

/** What a collection needs from its store. */
interface Host {
  handle(): Promise<MongoCollection<Stored>>;
  /** Refuses a value its document could not hold; the body to store otherwise. */
  fit(packed: { bytes: number; body: Body }): Body;
  touchEveryMs: number;
}

export class MongoRecords implements Records {
  readonly #o: Required<Omit<MongoRecordsOptions, 'node'>> & { node: string };
  #db: Promise<Db> | undefined;
  #client: MongoClient | undefined;
  /** The driver's measure of a document, there once connected. */
  #sizeOf: ((doc: Document) => number) | undefined;
  /** Collections whose indexes this process has asked for, each with what could not be made. */
  readonly #prepared = new Map<string, Promise<string[]>>();
  /** This process in the leases it holds. */
  readonly #holder: string;
  /** The leases held, each with the timer that renews it. */
  readonly #leases = new Map<string, NodeJS.Timeout>();
  /** Leases being asked for right now, which a close waits out before it hands any back. */
  readonly #asking = new Set<Promise<boolean>>();
  #closing = false;
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
    if (this.#closed) return Promise.reject(new StoreDown('The record store is closed'));
    this.#db ??= this.#connect().catch((error: unknown) => {
      this.#db = undefined;
      throw error;
    });
    return this.#db;
  }

  async #connect(): Promise<Db> {
    const { uri, db, connectTimeoutMs } = this.#o;
    try {
      const { MongoClient, BSON } = await import('mongodb');
      const client = new MongoClient(uri, {
        appName: 'cuttingfloor',
        ignoreUndefined: true,
        serverSelectionTimeoutMS: connectTimeoutMs,
      });
      await client.connect();
      this.#client = client;
      this.#sizeOf = (doc) => BSON.calculateObjectSize(doc);
      return client.db(db);
    } catch (error) {
      // Never the driver's own error: its message or fields may carry the connection string.
      throw new StoreDown(`MongoDB: cannot connect (${describe(error, uri)})`);
    }
  }

  /** The refusal of a record too big to be one, in plain words. */
  #tooBig(collection: string, bytes?: number): CfError {
    const size = bytes === undefined ? '' : ` of ${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return new CfError(
      'limit_exceeded',
      `A record${size} is too big to keep in ${collection}: one holds up to 16 MB`,
      {
        hint: 'Make what is being stored smaller, or store it in parts',
        detail: {
          collection,
          ...(bytes === undefined ? {} : { bytes }),
          max_bytes: 16 * 1024 ** 2,
        },
      },
    );
  }

  /**
   * Runs store work for a caller. A failure of the database or the driver is written to the
   * server's log and reaches the caller as a plain refusal, with nothing of the driver in it.
   */
  async #guard<R>(collection: string, operation: string, work: () => Promise<R>): Promise<R> {
    try {
      return await work();
    } catch (error) {
      if (!fromStore(error)) throw error;
      process.stderr.write(
        `records: ${collection}.${operation}: ${describe(error, this.#o.uri)}\n`,
      );
      if (tooLarge(error)) throw this.#tooBig(collection);
      throw new CfError(
        'service_unavailable',
        'The server could not read or write its records just now',
        { hint: 'Nothing is wrong with the call; make it again in a moment' },
      );
    }
  }

  /** An object whose every method runs under `#guard`. */
  #guarded<O extends object>(collection: string, target: O): O {
    return new Proxy(target, {
      get: (object, property) => {
        const member = Reflect.get(object, property, object) as unknown;
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) =>
          this.#guard(collection, String(property), async () =>
            (member as (...a: unknown[]) => unknown).apply(object, args),
          );
      },
    });
  }

  collection<T>(spec: CollectionSpec<T>, scope: CollectionScope = {}): Collection<T> {
    const place = this.#place(spec, scope, true);
    return this.#guarded(
      spec.name,
      new MongoCollectionOf<T>(
        {
          handle: () => this.#handle<Stored>(spec as CollectionSpec<unknown>),
          fit: (packed) => {
            if (packed.bytes < MEASURE_FROM_BYTES || !this.#sizeOf) return packed.body;
            const bytes = this.#sizeOf(packed.body);
            if (bytes > MAX_VALUE_BYTES) throw this.#tooBig(spec.name, bytes);
            return packed.body;
          },
          touchEveryMs: this.#o.touchEveryMs,
        },
        place,
      ),
    );
  }

  log<T>(spec: CollectionSpec<T>, scope: CollectionScope & { part?: string }): RecordLog<T> {
    const { scope: where } = this.#place(spec, scope, false);
    return this.#guarded(
      spec.name,
      new MongoLog<T>(() => this.#handle<Document>(spec as CollectionSpec<unknown>, true), {
        ...where,
        part: safe(scope.part ?? 'log'),
      }),
    );
  }

  async parents<T>(
    spec: CollectionSpec<T>,
    scope: Pick<CollectionScope, 'owner'> = {},
  ): Promise<string[]> {
    if (!grouped(spec as CollectionSpec<unknown>)) return [];
    const { scope: where } = this.#place(spec, scope, false);
    return this.#guard(spec.name, 'parents', async () => {
      const col = await this.#handle<Stored>(spec as CollectionSpec<unknown>);
      const names = await col.distinct('parent', where as Filter<Stored>);
      return names.filter((name): name is string => typeof name === 'string');
    });
  }

  async expireParents<T>(
    spec: CollectionSpec<T>,
    scope: Pick<CollectionScope, 'owner'>,
    ttlMs: number,
  ): Promise<string[]> {
    if (!grouped(spec as CollectionSpec<unknown>)) return [];
    const { scope: where } = this.#place(spec, scope, false);
    return this.#guard(spec.name, 'expireParents', async () => {
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
    });
  }

  /** Every record with the owner's key goes, in every collection (global ones hold none). */
  async forget(owner: string): Promise<void> {
    await this.#guard('records', 'forget', async () => {
      const db = await this.database();
      const key = ownerKey(owner);
      for (const name of await this.#collections(db)) {
        await db.collection(name).deleteMany({ owner: key });
      }
    });
  }

  async owners(): Promise<string[]> {
    return this.#guard('records', 'owners', async () => {
      const db = await this.database();
      const keys = new Set<string>();
      for (const name of await this.#collections(db)) {
        for (const key of await db.collection(name).distinct('owner')) {
          if (typeof key === 'string') keys.add(key);
        }
      }
      return [...keys];
    });
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
    safe(name);
    // Closing: this server's turns are over, and nothing may take a lease the close hands back.
    if (this.#closing) return false;
    const asked = this.#take(name);
    this.#asking.add(asked);
    return asked.finally(() => this.#asking.delete(asked));
  }

  #take(name: string): Promise<boolean> {
    return this.#guard(LOCKS, name, async () => {
      const db = await this.database();
      const locks = db.collection<{ _id: string }>(LOCKS);
      const { leaseMs, node } = this.#o;
      const take = [{ $set: { holder: this.#holder, node, until: { $add: ['$$NOW', leaseMs] } } }];
      try {
        // Mine already, or nobody's yet: kept, or made (which fails when another holds it).
        await locks.updateOne({ _id: name, holder: this.#holder }, take, { upsert: true });
      } catch (error) {
        if (!duplicate(error)) throw error;
        // Another's: taken only once it has run out, in one write no other taker can share.
        const taken = await locks.updateOne(
          { _id: name, $expr: { $lt: ['$until', '$$NOW'] } },
          take,
        );
        if (taken.matchedCount === 0) return this.#lost(name);
      }
      if (!this.#leases.has(name) && !this.#closing) {
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
                // The database can't be reached just now: the lease runs out if that goes on.
                () => undefined,
              );
          },
          Math.max(1000, Math.floor(leaseMs / 3)),
        );
        renew.unref();
        this.#leases.set(name, renew);
      }
      return true;
    });
  }

  #lost(name: string): false {
    const renew = this.#leases.get(name);
    if (renew) clearInterval(renew);
    this.#leases.delete(name);
    return false;
  }

  /**
   * Connects, and makes the indexes of every collection defined so far (the rest as they are
   * first used). Fails when the database cannot be reached or an index cannot be made, saying
   * which: a server does not start on a store it cannot use as meant.
   */
  async ready(): Promise<void> {
    await this.database();
    const failed = (
      await Promise.all(definedCollections().map((spec) => this.#prepare(spec, false, true)))
    ).flat();
    if (failed.length) {
      throw new Error(
        `MongoDB: cannot make ${failed.join('; ')}. An index of that name or on those fields may be there already with other settings: drop it and start again`,
      );
    }
  }

  /** Resolves once the indexes asked for so far are made (or have failed and said so). */
  async idle(): Promise<void> {
    await Promise.allSettled(this.#prepared.values());
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await Promise.allSettled(this.#asking);
    for (const name of [...this.#leases.keys()]) this.#lost(name);
    const connected = this.#db;
    if (connected) {
      await Promise.allSettled(this.#prepared.values());
      try {
        const db = await connected;
        // Handed back now, so another server takes the work over without waiting the lease out.
        await db.collection(LOCKS).deleteMany({ holder: this.#holder });
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
      { ...place.scope, id, used_at: usedAt, rev: token(), ...pack(value).body },
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

  /**
   * The collection's indexes, asked for once per process, and what could not be made. A
   * collection first used after the start says so in the log, once.
   */
  #prepare(spec: CollectionSpec<unknown>, log = false, quiet = false): Promise<string[]> {
    const name = `${spec.name}\0${spec.kind ?? ''}`;
    let done = this.#prepared.get(name);
    if (!done) {
      done = this.#indexes(spec, log || spec.fs.ext === '.jsonl').then(
        (failed) => {
          if (!quiet) {
            for (const what of failed) process.stderr.write(`records: cannot make ${what}\n`);
          }
          return failed;
        },
        (error: unknown) => {
          const what = `the indexes of ${spec.name} (${describe(error, this.#o.uri)})`;
          if (!quiet) process.stderr.write(`records: cannot make ${what}\n`);
          return [what];
        },
      );
      this.#prepared.set(name, done);
    }
    return done;
  }

  /** Makes each index on its own, so one that cannot be made costs no other. */
  async #indexes(spec: CollectionSpec<unknown>, log: boolean): Promise<string[]> {
    const db = await this.database();
    const col = db.collection(spec.name);
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
    const failed: string[] = [];
    const tell = (index: string, error: unknown) =>
      failed.push(`index ${index} of ${spec.name} (${describe(error, this.#o.uri)})`);
    for (const index of wanted) {
      await col.createIndex(index.key, { name: index.name }).catch((e) => tell(index.name, e));
    }
    if (!ttlMs) return failed;
    // A day behind the sweep, which decides (and tells whoever asked to hear of each record).
    const expireAfterSeconds = Math.ceil(ttlMs / 1000) + DAY_S;
    try {
      await col.createIndex({ [clock]: 1 }, { name: 'ttl', expireAfterSeconds });
    } catch (error) {
      // There already with another life, or with none: the life is set in place.
      const code = (error as { code?: number }).code;
      if (code !== 85 && code !== 86) tell('ttl', error);
      else {
        await db
          .command({
            collMod: spec.name,
            index: { keyPattern: { [clock]: 1 }, expireAfterSeconds },
          })
          .catch((e) => tell('ttl', e));
      }
    }
    return failed;
  }
}

class MongoCollectionOf<T> implements Collection<T> {
  readonly #host: Host;
  readonly #place: Place;

  constructor(host: Host, place: Place) {
    this.#host = host;
    this.#place = place;
  }

  #key(id: string): string {
    return `${this.#place.prefix}${safe(id)}`;
  }

  get #scope(): Filter<Stored> {
    return this.#place.scope as Filter<Stored>;
  }

  async get(id: string, options: { touch?: boolean } = {}): Promise<T | undefined> {
    const _id = this.#key(id);
    const col = await this.#host.handle();
    const doc = await col.findOne({ _id }, { projection: { v: 1, esc: 1, used_at: 1 } });
    if (!doc) return undefined;
    if (options.touch) await this.#touch(col, _id, doc.used_at);
    return unpack(doc) as T;
  }

  /** Moves the last use to now, unless it was moved within `touchEveryMs` (by any server). */
  async #touch(col: MongoCollection<Stored>, _id: string, usedAt?: Date): Promise<void> {
    const now = Date.now();
    const stale = new Date(now - this.#host.touchEveryMs);
    if (usedAt && usedAt > stale) return;
    await col.updateOne({ _id, used_at: { $lte: stale } }, { $set: { used_at: new Date(now) } });
  }

  async has(id: string): Promise<boolean> {
    const _id = this.#key(id);
    return (await (await this.#host.handle()).countDocuments({ _id }, { limit: 1 })) > 0;
  }

  async put(id: string, value: T): Promise<void> {
    const _id = this.#key(id);
    const col = await this.#host.handle();
    const body = this.#host.fit(pack(value));
    const doc = { ...this.#place.scope, id, used_at: new Date(), rev: token(), ...body };
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
    const col = await this.#host.handle();
    const body = this.#host.fit(pack(value));
    try {
      await col.insertOne({
        _id,
        ...this.#place.scope,
        id,
        used_at: new Date(),
        rev: token(),
        ...body,
      });
      return true;
    } catch (error) {
      if (duplicate(error)) return false;
      throw error;
    }
  }

  /**
   * One update that sets fields (an undefined one is removed, as a JSON file drops it) and adds
   * to numbers, for a record that is an object. Undefined when the change names a field a path
   * cannot: the record is then rewritten instead.
   */
  #change(set: object | undefined, inc?: object): Document[] | undefined {
    const given = (set ?? {}) as Record<string, unknown>;
    const adds = Object.entries((inc ?? {}) as Record<string, number>);
    if (![...Object.keys(given), ...adds.map(([field]) => field)].every(direct)) return undefined;
    const fields: Record<string, unknown> = {
      used_at: { $literal: new Date() },
      rev: { $literal: token() },
    };
    const unset: string[] = [];
    for (const [field, value] of Object.entries(given)) {
      if (adds.some(([name]) => name === field)) continue;
      if (value === undefined) unset.push(path(field));
      else {
        const body = this.#host.fit(pack(value));
        fields[path(field)] = { $literal: body.v };
        if (body.esc) fields.esc = { $literal: true };
      }
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

  /** A record a path update can change: one that is an object. */
  #object(_id: string): Document {
    return { _id, $expr: { $eq: [{ $type: '$v' }, 'object'] } };
  }

  /**
   * Changes a record by reading it, working out the next value here and writing it only if no
   * other write came between (else again from the read). For what one update in the database
   * cannot do as a JSON file's rewrite would: a record that is not an object (a list), or a
   * field whose name a path cannot hold (a dot, a leading dollar, an escaped character).
   */
  async #rewrite(
    _id: string,
    step: (current: unknown) => { next: unknown } | undefined,
  ): Promise<{ next: unknown } | 'missing' | undefined> {
    const col = await this.#host.handle();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const doc = await col.findOne({ _id }, { projection: { v: 1, esc: 1, rev: 1 } });
      if (!doc) return 'missing';
      const out = step(unpack(doc));
      if (!out) return undefined;
      const packed = pack(out.next);
      const body = this.#host.fit(packed);
      const { matchedCount } = await col.updateOne(
        { _id, rev: doc.rev ?? null } as Filter<Stored>,
        {
          $set: { used_at: new Date(), rev: token(), ...body },
          ...(body.esc ? {} : { $unset: { esc: '' } }),
        },
      );
      if (matchedCount) return { next: packed.plain };
    }
    throw new Error(`Record ${_id} is being written too often to change`);
  }

  async update(id: string, change: RecordChange<T>): Promise<T | undefined> {
    const _id = this.#key(id);
    const col = await this.#host.handle();
    const pipeline = this.#change(change.set, change.inc);
    if (pipeline) {
      const doc = await col.findOneAndUpdate(this.#object(_id), pipeline, {
        returnDocument: 'after',
        projection: { v: 1, esc: 1 },
      });
      if (doc) return unpack(doc) as T;
    }
    const out = await this.#rewrite(_id, (current) => ({
      next: changed(current, change as RecordChange<unknown>),
    }));
    return out && out !== 'missing' ? (out.next as T) : undefined;
  }

  async compareAndSet(id: string, expected: Partial<T>, set: Partial<T>): Promise<boolean> {
    const _id = this.#key(id);
    const col = await this.#host.handle();
    const wanted = Object.entries(expected as Record<string, unknown>);
    const pipeline = wanted.every(([field]) => direct(field)) ? this.#change(set) : undefined;
    if (pipeline) {
      // Exact equality, as the filesystem store compares: a missing field equals only undefined.
      const same = wanted.map(([field, want]) =>
        want === undefined
          ? { $eq: [{ $type: `$${path(field)}` }, 'missing'] }
          : { $eq: [`$${path(field)}`, { $literal: pack(want).body.v }] },
      );
      const object = this.#object(_id);
      const result = await col.updateOne(
        { _id, $expr: { $and: [object.$expr, ...same] } } as Filter<Stored>,
        pipeline,
      );
      if (result.matchedCount === 1) return true;
      // Differs or missing, unless it is a record one update cannot reach.
      const other = await col.countDocuments({ _id, $nor: [object] } as Filter<Stored>, {
        limit: 1,
      });
      if (!other) return false;
    }
    const out = await this.#rewrite(_id, (current) =>
      matches(current, expected) ? { next: { ...(current as object), ...set } } : undefined,
    );
    return out !== undefined && out !== 'missing';
  }

  async delete(id: string): Promise<void> {
    const _id = this.#key(id);
    await (await this.#host.handle()).deleteOne({ _id });
  }

  async clear(): Promise<void> {
    await (await this.#host.handle()).deleteMany(this.#scope);
  }

  async ids(): Promise<string[]> {
    const docs = await (await this.#host.handle())
      .find(this.#scope, { projection: { _id: 0, id: 1 } })
      .toArray();
    return docs.map((doc) => doc.id);
  }

  async find(where?: Partial<T>): Promise<RecordEntry<T>[]> {
    const wanted = Object.entries((where ?? {}) as Record<string, unknown>);
    const query: Record<string, unknown> = { ...this.#place.scope };
    // Found by index where the fields can be named as paths; else every record is compared.
    if (wanted.every(([field]) => direct(field))) {
      for (const [field, want] of wanted) {
        query[path(field)] =
          want === undefined
            ? { $exists: false }
            : want === null
              ? { $type: 'null' }
              : { $eq: pack(want).body.v };
      }
    }
    const docs = await (await this.#host.handle()).find(query as Filter<Stored>).toArray();
    const out: RecordEntry<T>[] = [];
    for (const doc of docs) {
      const value = unpack(doc);
      // The exact comparison is the filesystem store's own.
      if (wanted.length && !matches(value ?? {}, where as object)) continue;
      out.push({ id: doc.id, value: value as T, usedAt: doc.used_at });
    }
    return out;
  }

  async touch(id: string): Promise<void> {
    const _id = this.#key(id);
    await this.#touch(await this.#host.handle(), _id);
  }

  async usedAt(id: string): Promise<Date | undefined> {
    const _id = this.#key(id);
    const doc = await (await this.#host.handle()).findOne({ _id }, { projection: { used_at: 1 } });
    return doc?.used_at;
  }

  async expire(
    ttlMs: number,
    keep?: (id: string) => boolean,
    removed?: (id: string) => Promise<void>,
  ): Promise<string[]> {
    const col = await this.#host.handle();
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
    await (await this.#col()).insertOne({ ...this.#scope, at: new Date(), ...pack(entry).body });
  }

  async read(): Promise<T[]> {
    const { part: _part, ...all } = this.#scope;
    const docs = await (await this.#col())
      .find(all, { projection: { _id: 0, v: 1, esc: 1 } })
      .toArray();
    return docs.map((doc) => unpack(doc as { v?: unknown; esc?: boolean }) as T);
  }

  async expire(ttlMs: number): Promise<void> {
    const { part: _part, ...all } = this.#scope;
    await (await this.#col()).deleteMany({ ...all, at: { $lt: new Date(Date.now() - ttlMs) } });
  }
}
