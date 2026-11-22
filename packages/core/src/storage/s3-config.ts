import { isAbsolute, join, resolve } from 'node:path';
import type { BlobStore } from './blobs.ts';
import { FsBlobStore } from './fs-blobs.ts';
import { FsScratch } from './fs-scratch.ts';
import type { Records } from './records.ts';
import { S3BlobStore } from './s3-blobs.ts';
import { S3Scratch } from './s3-scratch.ts';
import type { Scratch } from './scratch.ts';

/** Files in an S3 bucket instead of under the data root (CUTTINGFLOOR_BLOBS=s3). */
export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  /** Secrets: never logged, never in an error. */
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
  /** The node's copy of blobs engines read; default `cache/blobs` under the data root. */
  cacheDir?: string;
  cacheBytes: number;
  partBytes: number;
  concurrency: number;
  connections: number;
  /** Parts streamed at a client's pace at once, apart from `connections` (default 32). */
  uploads?: number;
  /** Tests: a copy larger than this is made in parts; whether the bucket takes conditional puts. */
  copyPartBytes?: number;
  conditionalWrites?: boolean;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Where files are kept, from CUTTINGFLOOR_BLOBS: the filesystem (undefined) unless it says
 * `s3`, which needs the bucket's address and keys. Throws naming the variable that is missing
 * or wrong, never what one holds.
 */
export function s3SettingsFromEnv(env: NodeJS.ProcessEnv): S3Settings | undefined {
  // Trimmed: a value read from a secrets file ends in a newline.
  const value = (name: string) => env[name]?.trim() ?? '';
  const store = value('CUTTINGFLOOR_BLOBS').toLowerCase();
  if (!store || store === 'fs' || store === 'filesystem') return undefined;
  if (store !== 's3') throw new Error('CUTTINGFLOOR_BLOBS must be fs or s3');
  const need = (name: string) => {
    const v = value(name);
    if (!v) throw new Error(`CUTTINGFLOOR_BLOBS=s3 needs ${name}`);
    return v;
  };
  const endpoint = need('CUTTINGFLOOR_S3_ENDPOINT');
  let url: URL | undefined;
  try {
    url = new URL(endpoint);
  } catch {
    url = undefined;
  }
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error(
      'CUTTINGFLOOR_S3_ENDPOINT must be an http(s) address with no sign-in in it, like https://fsn1.your-objectstorage.com',
    );
  }
  const bucket = need('CUTTINGFLOOR_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(
      'CUTTINGFLOOR_S3_BUCKET must be a bucket name (lowercase letters, digits, - and .)',
    );
  }
  const number = (name: string, fallback: number, least: number, most: number) => {
    const text = value(name);
    if (!text) return fallback;
    const n = Number(text);
    if (!Number.isFinite(n) || n < least || n > most) {
      throw new Error(`${name} must be a number from ${least} to ${most}`);
    }
    return n;
  };
  const cacheDir = value('CUTTINGFLOOR_BLOB_CACHE');
  if (cacheDir && !isAbsolute(cacheDir)) {
    throw new Error('CUTTINGFLOOR_BLOB_CACHE must be an absolute path');
  }
  const style = value('CUTTINGFLOOR_S3_PATH_STYLE').toLowerCase();
  const pathStyle = style === '1' || style === 'true';
  if (bucket.includes('.') && !pathStyle) {
    throw new Error(
      'CUTTINGFLOOR_S3_BUCKET has dots, so it is reached as a path: set CUTTINGFLOOR_S3_PATH_STYLE=1, or use a name without dots',
    );
  }
  return {
    endpoint: url.origin,
    region: need('CUTTINGFLOOR_S3_REGION'),
    bucket,
    accessKeyId: need('CUTTINGFLOOR_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('CUTTINGFLOOR_S3_SECRET_ACCESS_KEY'),
    pathStyle,
    ...(cacheDir ? { cacheDir } : {}),
    cacheBytes: Math.round(number('CUTTINGFLOOR_BLOB_CACHE_GB', 50, 0.001, 100_000) * GIB),
    // Bytes sent in order are gathered in memory a part at a time: an upload holds up to about
    // twice this (see S3_MAX_PART_BYTES).
    partBytes: Math.round(number('CUTTINGFLOOR_S3_PART_MB', 16, 5, 64) * MIB),
    concurrency: Math.round(number('CUTTINGFLOOR_S3_CONCURRENCY', 6, 1, 64)),
    connections: Math.round(number('CUTTINGFLOOR_S3_CONNECTIONS', 64, 1, 200)),
  };
}

/**
 * The blob store and the node's local paths over it, for a data root: the bucket `s3` names, or
 * the files under the root without it. `records` is where the bucket's holders are counted.
 */
export function blobStores(
  root: string,
  options: {
    s3?: S3Settings;
    records: Records;
    presign?: ConstructorParameters<typeof FsBlobStore>[1];
  },
): { blobs: BlobStore; scratch: Scratch; local: FsBlobStore } {
  const local = new FsBlobStore(resolve(root), options.presign ?? {});
  const localScratch = new FsScratch(local);
  if (!options.s3) return { blobs: local, scratch: localScratch, local };
  const { cacheDir, cacheBytes, ...s3 } = options.s3;
  const blobs = new S3BlobStore({ ...s3, records: options.records, local });
  const scratch = new S3Scratch(blobs, localScratch, {
    dir: cacheDir ?? join(resolve(root), 'cache', 'blobs'),
    maxBytes: cacheBytes,
  });
  return { blobs, scratch, local };
}

/**
 * The blob store the environment names (CUTTINGFLOOR_BLOBS and CUTTINGFLOOR_S3_*), for a tool
 * that works on the files apart from a server (a migration). `root` is the data root, which an
 * S3 store uses only for `cache/…` keys.
 */
export function blobsFromEnv(
  env: NodeJS.ProcessEnv,
  options: { root: string; records: Records },
): BlobStore {
  const s3 = s3SettingsFromEnv(env);
  return blobStores(options.root, { ...(s3 ? { s3 } : {}), records: options.records }).blobs;
}
