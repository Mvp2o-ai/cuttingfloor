import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import type { BlobStore, CollectionSpec, RecordEntry } from '@cuttingfloor/core';
import { relTag, specKey } from './layout.ts';
import { type Manifest, parseRecordKey } from './manifest.ts';
import {
  blobFields,
  type Plan,
  type PlannedBlob,
  type PlannedLog,
  type PlannedRecord,
  readRecord,
  type Source,
} from './plan.ts';
import type { LogEntry, MigrationTarget } from './target.ts';
import { type Carried, carryPartway, partwayRecord } from './uploads.ts';

// One pass: every blob, then every record, then the logs, then what has gone from the source,
// then the folders' ages. Blobs go first so a record at the target never names a file that is
// not there yet. Each step writes only what the manifest (or, without one, the target itself)
// does not already show as done.

/** A carried upload is sent anew after this long: stores drop unfinished multipart uploads. */
export const PARTWAY_REDO_MS = 24 * 3_600_000;

export class Interrupted extends Error {
  constructor() {
    super('interrupted');
  }
}

export interface Counts {
  [name: string]: number;
}

export interface PassState {
  manifest: Manifest;
  /** Items left for the next pass, with why. Never a failure by itself while the source is live. */
  waiting: Array<{ what: string; why: string }>;
  /** Writes the target refused or that broke; the pass went on without them. */
  failed: Array<{ what: string; why: string }>;
  /** Records the target cannot hold. */
  oversize: Array<{ collection: string; id: string; bytes: number }>;
  records: Record<string, Counts>;
  blobs: Record<string, Counts>;
  logs: Counts;
  deletes: { planned: number; done: number; refused: boolean; of: number };
  notes: string[];
}

export interface PassOptions {
  dryRun: boolean;
  concurrency: number;
  recordConcurrency: number;
  bytesPerSecond?: number;
  allowDeletes: boolean;
  maxDeleteFraction: number;
  rehash: boolean;
  partBytes?: number;
  /** Stops after this many writes to the target (tests of an interrupted pass). */
  abortAfter?: number;
  signal?: AbortSignal;
  log: (line: string) => void;
  /** Saves the manifest; called now and then and at the end. */
  save: () => Promise<void>;
}

export const sameTime = (a: number, b: number) => Math.abs(a - b) < 2;

/** A value as a JSON file would hold it, its keys in one order, so equal records hash equal. */
export function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) {
        Object.defineProperty(out, key, {
          value: sort((v as Record<string, unknown>)[key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value) ?? 'null')));
}

/** An error in a few safe words: its kind and code, and its message with any address taken out. */
export function errorText(error: unknown): string {
  const e = error as { name?: string; code?: unknown; message?: string } | undefined;
  const message = String(e?.message ?? '')
    .replace(/mongodb(\+srv)?:\/\/\S+/g, 'mongodb://…')
    .slice(0, 160);
  return [e?.name ?? 'Error', e?.code !== undefined ? String(e.code) : '', message]
    .filter(Boolean)
    .join(' ');
}

/** The entry of a tally under `key`, made when it is the first. */
export function slot<T>(into: Record<string, T>, key: string, make: () => T): T {
  const had = into[key];
  if (had !== undefined) return had;
  const made = make();
  into[key] = made;
  return made;
}

export const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[u]}`;
}

function spanText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

const bump = (into: Record<string, Counts>, name: string, field: string, by = 1) => {
  const counts = slot(into, name, (): Counts => ({}));
  counts[field] = (counts[field] ?? 0) + by;
};

/** At most `bytesPerSecond` across everything that reads through it. */
export class Throttle {
  readonly #rate: number | undefined;
  #free = Date.now();

  constructor(bytesPerSecond?: number) {
    this.#rate = bytesPerSecond && bytesPerSecond > 0 ? bytesPerSecond : undefined;
  }

  async take(bytes: number): Promise<void> {
    if (!this.#rate) return;
    const now = Date.now();
    const at = Math.max(this.#free, now);
    this.#free = at + (bytes / this.#rate) * 1000;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

/** Runs `work` over `items`, `limit` at a time. Stops taking more once one fails. */
export async function pool<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed: unknown;
  const run = async () => {
    while (failed === undefined && next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await work(item);
      } catch (error) {
        failed ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  if (failed !== undefined) throw failed;
}

/** A stream's SHA-256, paced by the throttle and counted. */
export async function hashStream(
  stream: Readable,
  throttle?: Throttle,
  onBytes?: (n: number) => void,
): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    await throttle?.take(bytes.length);
    hash.update(bytes);
    onBytes?.(bytes.length);
  }
  return hash.digest('hex');
}

/** A blob's SHA-256 at the target: what the store keeps, or its bytes read back. */
export async function targetSha(store: BlobStore, key: string, known?: string): Promise<string> {
  return known ?? hashStream(await store.get(key));
}

/** The record as the target holds it: blob fields as target keys, a part-way upload's offset. */
export function atTarget(
  item: PlannedRecord['item'],
  value: unknown,
  manifest: Manifest,
  plan: Plan,
  /** A dry run asks where things would go, not whether they are there yet. */
  planned = false,
): { value: unknown } | { wait: string } {
  let out = value;
  const fields = blobFields(item.spec, value);
  if (fields.length) {
    const next = { ...(value as Record<string, unknown>) };
    for (const [field, ref] of fields) {
      const copied = manifest.blobs[ref]?.target;
      // A file the record names and the source no longer has keeps its name's place.
      const there = plan.blobs.some((b) => b.item.rel === ref);
      if (!copied && there && !planned) return { wait: `its ${field} is not at the target yet` };
      next[field] = copied ?? plan.mapKey(ref);
    }
    out = next;
  }
  if (item.spec.name === 'uploads' && !item.spec.kind) {
    const file = plan.arriving.get(`${item.owner}/${item.id}`);
    if (file !== undefined) {
      const key = `owners/${item.owner}/uploads/${item.id}/${file}`;
      const carried = manifest.partway[key];
      if (carried) out = partwayRecord(out as object, carried);
      else if (!planned && plan.blobs.some((b) => b.item.rel === key)) {
        return { wait: 'its bytes are not at the target yet' };
      }
    }
  }
  return { value: out };
}

/** A log part's entries with their own times; lines that are not JSON are skipped, as a read does. */
export function logEntries(text: string, fallback: Date, ttlMs: number | undefined, now: number) {
  const entries: LogEntry[] = [];
  const lines = text.split('\n');
  // The last line of a part being appended to may be half written.
  const whole = text.endsWith('\n') ? lines.length : lines.length - 1;
  for (let n = 0; n < whole; n += 1) {
    const line = lines[n];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const own = Date.parse(String((entry as { at?: unknown } | null)?.at));
    const at = Number.isNaN(own) ? fallback : new Date(own);
    if (ttlMs !== undefined && at.getTime() + ttlMs < now) continue;
    entries.push({ n, at, entry });
  }
  return entries;
}

export async function runPass(
  source: Source,
  target: MigrationTarget,
  plan: Plan,
  manifest: Manifest,
  options: PassOptions,
): Promise<PassState> {
  const state: PassState = {
    manifest,
    waiting: [],
    failed: [],
    oversize: [],
    records: {},
    blobs: {},
    logs: {},
    deletes: { planned: 0, done: 0, refused: false, of: 0 },
    notes: [],
  };
  const { dryRun, log } = options;
  const throttle = new Throttle(options.bytesPerSecond);
  let writes = 0;
  let lastSave = Date.now();
  const stopIfAsked = () => {
    if (options.signal?.aborted) throw new Interrupted();
    if (options.abortAfter !== undefined && writes >= options.abortAfter) throw new Interrupted();
  };
  /** One write to the target done: counted, and the manifest saved now and then. */
  const wrote = async () => {
    writes += 1;
    if (!dryRun && (writes % 100 === 0 || Date.now() - lastSave > 5000)) {
      lastSave = Date.now();
      await options.save();
    }
  };
  const wait = (what: string, why: string) => state.waiting.push({ what, why });
  /** One item's failure is noted and the pass goes on; only an interruption stops it. */
  const guarded =
    <T>(what: (item: T) => string, work: (item: T) => Promise<void>) =>
    async (item: T): Promise<void> => {
      try {
        await work(item);
      } catch (error) {
        if (error instanceof Interrupted) throw error;
        state.failed.push({ what: what(item), why: errorText(error) });
      }
    };

  if (!dryRun) {
    await target.records.ready();
    for (const owner of plan.layout.owners) {
      if (!manifest.owners.includes(owner)) manifest.owners.push(owner);
    }
  }

  // ---- Blobs ----------------------------------------------------------------------------

  const totalBytes = plan.blobs.reduce((sum, b) => sum + b.item.size, 0);
  let seenBytes = 0;
  let movedBytes = 0;
  const started = Date.now();
  const rate = () => movedBytes / Math.max(1, (Date.now() - started) / 1000);
  const progress = () =>
    `${bytesText(seenBytes)} of ${bytesText(totalBytes)} seen, ${bytesText(movedBytes)} read at ${bytesText(rate())}/s, about ${spanText((totalBytes - seenBytes) / Math.max(1, rate()))} left`;
  let ticker: NodeJS.Timeout | undefined;
  if (!dryRun && totalBytes > 0) {
    ticker = setInterval(() => log(`  … ${progress()}`), 15_000);
    ticker.unref();
  }

  /** Hard links at the source: of each set of files sharing bytes, the first is stored, the rest share it. */
  const firstOf = new Map<string, PlannedBlob>();
  const groupSize = new Map<string, number>();
  const linkOf = (b: PlannedBlob) => `${b.item.owner}:${b.item.dev}:${b.item.ino}`;
  for (const b of plan.blobs) {
    if (b.partway || b.item.nlink < 2) continue;
    if (!firstOf.has(linkOf(b))) firstOf.set(linkOf(b), b);
    groupSize.set(linkOf(b), (groupSize.get(linkOf(b)) ?? 0) + 1);
  }
  const sharer = (b: PlannedBlob) => {
    const first = firstOf.get(linkOf(b));
    return !b.partway && b.item.nlink > 1 && first && first !== b ? first : undefined;
  };

  const sourceStat = (rel: string) =>
    lstat(join(source.root, ...rel.split('/'))).then(
      (s) => s,
      () => undefined,
    );
  const unchanged = async (b: PlannedBlob) => {
    const s = await sourceStat(b.item.rel);
    return Boolean(
      s && s.size === b.item.size && s.mtimeMs === b.item.mtimeMs && s.ino === b.item.ino,
    );
  };
  const clean = (b: PlannedBlob) => {
    const entry = manifest.blobs[b.item.rel];
    return Boolean(
      entry &&
        !options.rehash &&
        entry.size === b.item.size &&
        entry.mtime_ms === b.item.mtimeMs &&
        entry.ino === b.item.ino,
    );
  };
  const setTime = async (key: string, mtimeMs: number) => {
    await target.setBlobTime?.(key, new Date(mtimeMs));
  };

  const storeBlob = async (b: PlannedBlob): Promise<void> => {
    stopIfAsked();
    const { item, kind } = b;
    bump(state.blobs, kind, 'files');
    bump(state.blobs, kind, 'bytes', item.size);
    if (b.wait) {
      bump(state.blobs, kind, 'waiting');
      wait(relTag(item.rel), b.wait);
      return;
    }
    if (b.partway) return carry(b);
    const first = sharer(b);
    const entry = manifest.blobs[item.rel];
    if (clean(b) && (first ? entry?.shared_from === first.item.rel : !entry?.shared_from)) {
      bump(state.blobs, kind, 'unchanged');
      return;
    }
    if (dryRun) {
      bump(state.blobs, kind, first ? 'to_share' : 'to_copy');
      if (!first) bump(state.blobs, kind, 'to_copy_bytes', item.size);
      return;
    }
    // A multipart upload carried while this upload was still arriving is over.
    const was = manifest.partway[item.rel];
    if (was) {
      await target.blobs.multipartAbort(was.target, was.upload_id).catch(() => undefined);
      delete manifest.partway[item.rel];
    }
    if (first) {
      const from = manifest.blobs[first.item.rel];
      if (!from) {
        bump(state.blobs, kind, 'waiting');
        wait(relTag(item.rel), 'the file it shares bytes with is not at the target yet');
        return;
      }
      const head = await target.blobs.head(b.targetKey);
      const firstHead = await target.blobs.head(from.target);
      let key: string;
      if (head && head.bytes === item.size && head.refs > 1 && !entry) key = b.targetKey;
      else if (!entry && !head && (firstHead?.refs ?? 0) >= (groupSize.get(linkOf(b)) ?? 2)) {
        key = from.target;
      } else {
        // Its own bytes from an earlier pass go; then it holds the first one's.
        if (entry && entry.target !== b.targetKey) await target.blobs.delete(entry.target);
        key = await target.blobs.share(from.target, b.targetKey);
        await wrote();
        bump(state.blobs, kind, 'shared');
      }
      manifest.blobs[item.rel] = {
        size: item.size,
        mtime_ms: item.mtimeMs,
        ino: item.ino,
        sha256: from.sha256,
        target: key,
        shared_from: first.item.rel,
      };
      await setTime(key, item.mtimeMs);
      return;
    }
    const count = (n: number) => {
      movedBytes += n;
    };
    let sha256: string | undefined;
    let put = true;
    const head = await target.blobs.head(b.targetKey);
    try {
      if (head && head.bytes === item.size && !entry?.shared_from) {
        // Already there, perhaps: the same bytes are not sent twice.
        sha256 = await hashStream(await source.blobs.get(item.rel), throttle, count);
        if ((await targetSha(target.blobs, b.targetKey, head.sha256)) === sha256) put = false;
      }
      if (put) {
        // Where it held other bytes: under another key, or sharing someone's (never written through).
        if (entry && entry.target !== b.targetKey) await target.blobs.delete(entry.target);
        if (head && head.refs > 1) await target.blobs.delete(b.targetKey);
        const hash = createHash('sha256');
        const through = new Transform({
          transform(chunk: Buffer, _enc, done) {
            throttle.take(chunk.length).then(() => {
              hash.update(chunk);
              count(chunk.length);
              done(null, chunk);
            }, done);
          },
        });
        const from = await source.blobs.get(item.rel);
        from.on('error', (error) => through.destroy(error));
        const written = await target.blobs.put(b.targetKey, { stream: from.pipe(through) });
        sha256 = hash.digest('hex');
        if (written.bytes !== item.size) throw new Error('changed');
      }
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      const gone = !(await sourceStat(item.rel));
      const moved = !gone && !(await unchanged(b));
      if (!gone && !moved && (error as Error).message !== 'changed') throw error;
      bump(state.blobs, kind, 'waiting');
      wait(relTag(item.rel), gone ? 'it went while it was read' : 'it changed while it was read');
      return;
    }
    if (!(await unchanged(b))) {
      bump(state.blobs, kind, 'waiting');
      wait(relTag(item.rel), 'it changed while it was read');
      return;
    }
    manifest.blobs[item.rel] = {
      size: item.size,
      mtime_ms: item.mtimeMs,
      ino: item.ino,
      sha256: sha256 as string,
      target: b.targetKey,
    };
    await setTime(b.targetKey, item.mtimeMs);
    if (put) {
      await wrote();
      bump(state.blobs, kind, 'copied');
      bump(state.blobs, kind, 'copied_bytes', item.size);
    } else bump(state.blobs, kind, 'found_at_target');
  };

  /** An upload still arriving: its whole parts go into a multipart upload at the target. */
  const carry = async (b: PlannedBlob): Promise<void> => {
    const { item, kind } = b;
    let prior = manifest.partway[item.rel];
    const fresh = prior && Date.parse(prior.started_at) > Date.now() - PARTWAY_REDO_MS;
    if (prior && fresh && prior.size === item.size && prior.mtime_ms === item.mtimeMs) {
      bump(state.blobs, kind, 'unchanged');
      return;
    }
    if (dryRun) {
      bump(state.blobs, kind, 'to_carry');
      return;
    }
    if (prior && !fresh) {
      await target.blobs.multipartAbort(prior.target, prior.upload_id).catch(() => undefined);
      prior = undefined;
    }
    let carried: Carried;
    try {
      carried = await carryPartway(source.blobs, item.rel, target.blobs, b.targetKey, item.size, {
        ...(prior ? { prior } : {}),
        ...(options.partBytes ? { partBytes: options.partBytes } : {}),
        onBytes: async (n) => {
          await throttle.take(n);
          movedBytes += n;
        },
      });
    } catch (error) {
      if (await sourceStat(item.rel)) {
        if (!/shrank|kept changing/.test((error as Error).message)) throw error;
      }
      delete manifest.partway[item.rel];
      bump(state.blobs, kind, 'waiting');
      wait(relTag(item.rel), 'the upload changed while it was read');
      return;
    }
    manifest.partway[item.rel] = { ...carried, size: item.size, mtime_ms: item.mtimeMs };
    await wrote();
    bump(state.blobs, kind, 'carried');
    bump(state.blobs, kind, 'carried_bytes', carried.offset);
  };

  try {
    const byOwner = new Map<string, PlannedBlob[]>();
    for (const b of plan.blobs) {
      const list = byOwner.get(b.item.owner) ?? [];
      list.push(b);
      byOwner.set(b.item.owner, list);
    }
    let n = 0;
    for (const [owner, blobs] of byOwner) {
      n += 1;
      const before = writes;
      const bytes = blobs.reduce((sum, b) => sum + b.item.size, 0);
      const each = guarded(
        (b: PlannedBlob) => relTag(b.item.rel),
        async (b) => {
          try {
            await storeBlob(b);
          } finally {
            seenBytes += b.item.size;
          }
        },
      );
      // Files that share bytes follow the one that is stored.
      await pool(
        blobs.filter((b) => !sharer(b)),
        options.concurrency,
        each,
      );
      await pool(
        blobs.filter((b) => sharer(b)),
        options.concurrency,
        each,
      );
      log(
        `blobs ${relTag(`owners/${owner}`)} (${n}/${byOwner.size}): ${blobs.length} files, ${bytesText(bytes)}, ${dryRun ? 'dry run' : `${writes - before} written`}; ${progress()}`,
      );
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }

  // ---- Records --------------------------------------------------------------------------

  const byCollection = new Map<string, PlannedRecord[]>();
  for (const r of plan.records) {
    const list = byCollection.get(specKey(r.item.spec)) ?? [];
    list.push(r);
    byCollection.set(specKey(r.item.spec), list);
  }
  /** What the target holds of a collection in one scope, read once, when something there is new. */
  const targetScopes = new Map<string, Promise<Map<string, RecordEntry<unknown>>>>();
  const atTargetNow = (r: PlannedRecord) => {
    const { spec, owner, parent } = r.item;
    const at = `${specKey(spec)}|${owner ?? ''}|${parent ?? ''}`;
    let found = targetScopes.get(at);
    if (!found) {
      found = target.records
        .collection(spec, { ...(owner ? { owner } : {}), ...(parent ? { parent } : {}) })
        .find()
        .then((entries) => new Map(entries.map((e) => [e.id, e])));
      targetScopes.set(at, found);
    }
    return found;
  };

  const storeRecord = async (r: PlannedRecord): Promise<void> => {
    stopIfAsked();
    const { item } = r;
    const name = specKey(item.spec);
    bump(state.records, name, 'source');
    const entry = manifest.records[r.key];
    // A record that names blobs, or an upload, is as the target holds it only while they are.
    const reads = Boolean(item.spec.blobs?.length) || item.spec.name === 'uploads';
    if (entry && !reads && entry.size === item.size && entry.mtime_ms === item.mtimeMs) {
      bump(state.records, name, 'unchanged');
      return;
    }
    const read = await readRecord(source, item);
    if (read.state === 'gone') {
      bump(state.records, name, 'source', -1);
      return;
    }
    if (read.state === 'unreadable') {
      bump(state.records, name, 'waiting');
      wait(`${name} ${relTag(item.rel)}`, `the record ${read.why}`);
      return;
    }
    const mapped = atTarget(item, read.value, manifest, plan, dryRun);
    if ('wait' in mapped) {
      bump(state.records, name, 'waiting');
      wait(`${name} ${relTag(item.rel)}`, mapped.wait);
      return;
    }
    const json = stable(mapped.value);
    const hash = hashOf(json);
    const bytes = Buffer.byteLength(json);
    if (target.maxRecordBytes !== undefined && bytes > target.maxRecordBytes) {
      bump(state.records, name, 'oversize');
      state.oversize.push({ collection: name, id: relTag(item.rel), bytes });
      return;
    }
    const { mtimeMs, size } = read.stat;
    if (entry && entry.hash === hash && entry.mtime_ms === mtimeMs) {
      entry.size = size;
      bump(state.records, name, 'unchanged');
      return;
    }
    if (!entry) {
      // No memory of it: the target may hold it already (an earlier pass whose manifest was lost).
      const there = (await atTargetNow(r)).get(item.id);
      if (
        there &&
        hashOf(stable(there.value)) === hash &&
        sameTime(there.usedAt.getTime(), mtimeMs)
      ) {
        if (!dryRun) manifest.records[r.key] = { size, mtime_ms: mtimeMs, hash };
        bump(state.records, name, 'found_at_target');
        return;
      }
    }
    bump(state.records, name, dryRun ? 'to_write' : 'written');
    bump(state.records, name, dryRun ? 'to_write_bytes' : 'written_bytes', bytes);
    if (dryRun) return;
    await target.restoreRecord(
      item.spec,
      {
        ...(item.owner ? { owner: item.owner } : {}),
        ...(item.parent ? { parent: item.parent } : {}),
      },
      item.id,
      mapped.value,
      new Date(mtimeMs),
    );
    manifest.records[r.key] = { size, mtime_ms: mtimeMs, hash };
    await wrote();
  };

  for (const [name, records] of byCollection) {
    await pool(
      records,
      options.recordConcurrency,
      guarded((r) => `${name} ${relTag(r.item.rel)}`, storeRecord),
    );
    const c = state.records[name] ?? {};
    log(
      `records ${name}: ${c.source ?? 0} at the source, ${c[dryRun ? 'to_write' : 'written'] ?? 0} ${dryRun ? 'to write' : 'written'}, ${c.unchanged ?? 0} unchanged${c.found_at_target ? `, ${c.found_at_target} already there` : ''}${c.waiting ? `, ${c.waiting} left for the next pass` : ''}${c.oversize ? `, ${c.oversize} TOO BIG` : ''}`,
    );
  }

  // ---- Logs -----------------------------------------------------------------------------

  const storeLog = async (l: PlannedLog): Promise<void> => {
    stopIfAsked();
    const { item } = l;
    bump({ logs: state.logs }, 'logs', 'parts');
    const entry = manifest.logs[item.rel];
    if (entry && entry.size === item.size && entry.mtime_ms === item.mtimeMs) {
      bump({ logs: state.logs }, 'logs', 'unchanged');
      return;
    }
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of await source.blobs.get(item.rel)) chunks.push(chunk as Buffer);
    } catch {
      return;
    }
    const after = await sourceStat(item.rel);
    if (!after) return;
    const entries = logEntries(
      Buffer.concat(chunks).toString('utf8'),
      new Date(after.mtimeMs),
      l.ttlMs,
      plan.now,
    );
    bump({ logs: state.logs }, 'logs', dryRun ? 'parts_to_write' : 'parts_written');
    bump({ logs: state.logs }, 'logs', 'entries', entries.length);
    if (dryRun) return;
    await target.restoreLog(
      item.spec,
      { ...(item.owner ? { owner: item.owner } : {}), part: item.part },
      entries,
      new Date(after.mtimeMs),
    );
    // As read: a part appended to since is sent again next pass.
    manifest.logs[item.rel] = {
      size: after.size,
      mtime_ms: after.mtimeMs,
      entries: entries.length,
    };
    await wrote();
  };
  await pool(
    plan.logs,
    options.recordConcurrency,
    guarded((l) => relTag(l.item.rel), storeLog),
  );
  if (plan.logs.length) {
    log(
      `logs: ${state.logs.parts ?? 0} parts, ${state.logs[dryRun ? 'parts_to_write' : 'parts_written'] ?? 0} ${dryRun ? 'to write' : 'written'} (${state.logs.entries ?? 0} entries), ${state.logs.unchanged ?? 0} unchanged`,
    );
  }

  // ---- What has gone from the source ----------------------------------------------------

  const liveBlobs = new Set(plan.blobs.map((b) => b.item.rel));
  const liveRecords = new Set(plan.records.map((r) => r.key));
  const liveOwners = new Set(plan.layout.owners);
  const goneOwners = manifest.owners.filter((owner) => !liveOwners.has(owner));
  const ownerOf = (rel: string) => /^owners\/([^/]+)\//.exec(rel)?.[1];
  const goneBlobs = Object.keys(manifest.blobs).filter((rel) => !liveBlobs.has(rel));
  const gonePartway = Object.keys(manifest.partway).filter((rel) => !liveBlobs.has(rel));
  const goneRecords = Object.keys(manifest.records).filter((key) => !liveRecords.has(key));
  const all =
    Object.keys(manifest.blobs).length +
    Object.keys(manifest.partway).length +
    Object.keys(manifest.records).length;
  state.deletes.planned = goneBlobs.length + gonePartway.length + goneRecords.length;
  state.deletes.of = all;
  const fraction = all ? state.deletes.planned / all : 0;
  if (state.deletes.planned && fraction > options.maxDeleteFraction && !options.allowDeletes) {
    state.deletes.refused = true;
    log(
      `deletes REFUSED: ${state.deletes.planned} of ${all} things moved so far are gone from the source (${(fraction * 100).toFixed(1)}%, more than ${(options.maxDeleteFraction * 100).toFixed(1)}%). Nothing was removed from the target. Run again with --allow-deletes if that is right.`,
    );
  } else if (state.deletes.planned) {
    if (!dryRun) {
      const specs = new Map(plan.specs.map((spec) => [specKey(spec), spec]));
      for (const owner of goneOwners) {
        stopIfAsked();
        await target.records.forget(owner);
        await target.blobs.deletePrefix(target.blobs.keys.owner(owner));
        manifest.owners = manifest.owners.filter((o) => o !== owner);
      }
      for (const rel of gonePartway) {
        stopIfAsked();
        const was = manifest.partway[rel] as NonNullable<(typeof manifest.partway)[string]>;
        if (!goneOwners.includes(ownerOf(rel) ?? '')) {
          await target.blobs.multipartAbort(was.target, was.upload_id).catch(() => undefined);
        }
        delete manifest.partway[rel];
        state.deletes.done += 1;
      }
      for (const rel of goneBlobs) {
        stopIfAsked();
        const was = manifest.blobs[rel] as NonNullable<(typeof manifest.blobs)[string]>;
        // A whole owner's files went above; a holder's key is otherwise deleted once each.
        if (!goneOwners.includes(ownerOf(rel) ?? '')) await target.blobs.delete(was.target);
        delete manifest.blobs[rel];
        state.deletes.done += 1;
        await wrote();
      }
      for (const key of goneRecords) {
        stopIfAsked();
        const { collection, owner, parent, id } = parseRecordKey(key);
        const spec = specs.get(collection) as CollectionSpec<unknown> | undefined;
        if (spec && !(owner && goneOwners.includes(owner))) {
          await target.records
            .collection(spec, { ...(owner ? { owner } : {}), ...(parent ? { parent } : {}) })
            .delete(id);
        }
        delete manifest.records[key];
        state.deletes.done += 1;
        await wrote();
      }
      for (const rel of Object.keys(manifest.logs)) {
        if (goneOwners.includes(ownerOf(rel) ?? '')) delete manifest.logs[rel];
      }
    }
    log(
      `deletes: ${state.deletes.planned} gone from the source (${goneRecords.length} records, ${goneBlobs.length + gonePartway.length} files${goneOwners.length ? `, ${goneOwners.length} whole accounts` : ''})${dryRun ? ' would be removed from the target' : ' removed from the target'}`,
    );
  }

  // ---- Ages of the folders the blob store sweeps by --------------------------------------

  if (!dryRun) {
    if (!target.setBlobTime) {
      state.notes.push(
        'The target blob store cannot be told how old a file is: uploads and kept frames start their time again from this copy.',
      );
    } else {
      for (const folder of plan.folders) {
        stopIfAsked();
        const there = await target.getBlobTime?.(folder.target);
        if (!there || !sameTime(there.getTime(), folder.mtimeMs)) {
          await target.setBlobTime(folder.target, new Date(folder.mtimeMs));
        }
        manifest.folders[folder.rel] = folder.mtimeMs;
      }
      const live = new Set(plan.folders.map((f) => f.rel));
      for (const rel of Object.keys(manifest.folders))
        if (!live.has(rel)) delete manifest.folders[rel];
    }
    await options.save();
  }
  return state;
}
