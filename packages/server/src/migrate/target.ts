import { stat, utimes } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  type BlobKey,
  type BlobStore,
  type CollectionScope,
  type CollectionSpec,
  FsBlobStore,
  FsRecords,
  MongoRecords,
  type Records,
} from '@cuttingfloor/core';
import { configFromEnv } from '../runtime.ts';
import { readLayout } from './layout.ts';

// Where a migration writes: any `Records` and any `BlobStore`, plus the few things moving a data
// root needs that serving it never does (a record with its old last use, a log part with its old
// times, a blob's old age).

export interface LogEntry {
  /** The entry's line in its part, from 0. */
  n: number;
  /** The entry's own time, which the log's expiry runs on. */
  at: Date;
  entry: unknown;
}

export interface MigrationTarget {
  /** What it is, for the manifest and reports. Never an address with a sign-in. */
  readonly name: string;
  readonly records: Records;
  readonly blobs: BlobStore;
  /** The most a record's JSON may take, where the store has a limit. */
  readonly maxRecordBytes?: number;
  /** Writes a record as it was, with its last use. */
  restoreRecord(
    spec: CollectionSpec<unknown>,
    scope: CollectionScope,
    id: string,
    value: unknown,
    usedAt: Date,
  ): Promise<void>;
  /** Writes one part of a log; `usedAt` is the part's last write. */
  restoreLog(
    spec: CollectionSpec<unknown>,
    scope: CollectionScope & { part: string },
    entries: readonly LogEntry[],
    usedAt: Date,
  ): Promise<void>;
  /**
   * Sets when a blob, or a folder of them (an upload, an output), was last written: the clock
   * `BlobStore.expire` runs on. Absent where the store cannot: what it ages by its own clock
   * then starts again at the copy, and the migration says so.
   */
  setBlobTime?(keyOrPrefix: BlobKey, at: Date): Promise<void>;
  getBlobTime?(keyOrPrefix: BlobKey): Promise<Date | undefined>;
  /**
   * The records and log parts kept as files beside the blobs (which `blobs.usage` and
   * `blobs.list` then see as an owner's files), by key with their sizes. Empty where records
   * are elsewhere.
   */
  recordFiles(specs: readonly CollectionSpec<unknown>[]): Promise<Map<BlobKey, number>>;
  close(): Promise<void>;
}

/** Whether `inner` is `outer` or inside it. */
export function within(outer: string, inner: string): boolean {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function fsTimes(blobs: FsBlobStore): Pick<MigrationTarget, 'setBlobTime' | 'getBlobTime'> {
  return {
    setBlobTime: async (key, at) => {
      await utimes(blobs.file(key), at, at).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
    getBlobTime: (key) =>
      stat(blobs.file(key)).then(
        (s) => s.mtime,
        () => undefined,
      ),
  };
}

/** A filesystem data root as the target: records as JSON files, or in another store given. */
export function fsTarget(dir: string, records?: Records, recordsName?: string): MigrationTarget {
  const root = resolve(dir);
  const blobs = new FsBlobStore(root);
  const fsRecords = records ? undefined : new FsRecords(root);
  const mongo = records instanceof MongoRecords ? records : undefined;
  const store = records ?? (fsRecords as FsRecords);
  return {
    name: `records=${recordsName ?? (fsRecords ? `fs:${root}` : 'other')} blobs=fs:${root}`,
    records: store,
    blobs,
    ...(mongo ? { maxRecordBytes: 16 * 1024 ** 2 - 64 * 1024 } : {}),
    restoreRecord: async (spec, scope, id, value, usedAt) => {
      if (fsRecords) return fsRecords.restore(spec, scope, id, value, usedAt);
      if (mongo) return mongo.restore(spec, scope, id, value, usedAt);
      throw new Error('This record store cannot take a record with its last use');
    },
    restoreLog: async (spec, scope, entries, usedAt) => {
      if (fsRecords) return fsRecords.restoreLog(spec, scope, entries, usedAt);
      if (mongo) return mongo.restoreLog(spec, scope, entries);
      throw new Error('This record store cannot take a log with its times');
    },
    ...fsTimes(blobs),
    recordFiles: async (specs) => {
      const out = new Map<BlobKey, number>();
      if (!fsRecords) return out;
      const layout = await readLayout(root, specs);
      for (const item of [...layout.records, ...layout.logs, ...layout.left]) {
        out.set(item.rel, item.size);
      }
      return out;
    },
    close: async () => {
      await store.close();
    },
  };
}

/**
 * The store files are moved into, chosen as the server will choose its own: CUTTINGFLOOR_BLOBS.
 * Today only the filesystem (a second data root at `targetDir`); the object store's goes here.
 */
export function blobTargetFromEnv(
  env: NodeJS.ProcessEnv,
  options: { targetDir?: string },
): { kind: 'fs'; dir: string } {
  const store = (env.CUTTINGFLOOR_BLOBS ?? '').trim().toLowerCase();
  if (store && store !== 'fs' && store !== 'filesystem') {
    throw new Error(
      `CUTTINGFLOOR_BLOBS=${store}: this build moves files into a filesystem data root only (--target-dir). The object store's target is added in blobTargetFromEnv when that store lands.`,
    );
  }
  if (!options.targetDir) {
    throw new Error('--target-dir is needed: the data root the files are moved into');
  }
  return { kind: 'fs', dir: options.targetDir };
}

/**
 * The target from the server's own settings: CUTTINGFLOOR_RECORDS=mongo with the
 * CUTTINGFLOOR_MONGODB_* variables puts records in MongoDB, anything else beside the files.
 */
export function targetFromEnv(
  env: NodeJS.ProcessEnv,
  options: { targetDir?: string },
): MigrationTarget {
  const blobs = blobTargetFromEnv(env, options);
  const { records } = configFromEnv(env);
  if (!records) return fsTarget(blobs.dir);
  const mongo = new MongoRecords({ uri: records.uri, db: records.db, node: 'migration' });
  // The database's name only: the address carries the sign-in.
  return fsTarget(blobs.dir, mongo, `mongo:${records.db}`);
}
