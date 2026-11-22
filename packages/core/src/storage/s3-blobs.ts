import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { CfError } from '@cuttingfloor/schema';
import type {
  BlobHead,
  BlobKey,
  BlobKeys,
  BlobPart,
  BlobSource,
  BlobStore,
  OrphanReport,
  PresignOptions,
} from './blobs.ts';
import type { FsBlobStore } from './fs-blobs.ts';
import { ownerKey } from './fs-util.ts';
import { type Collection, defineCollection, type Records } from './records.ts';

const MIB = 1024 ** 2;
/** The least a part of an upload in parts may be, but for the last (S3's rule). */
export const S3_MIN_PART_BYTES = 5 * MIB;
/** The most parts an upload may have (S3's rule). */
export const S3_MAX_PARTS = 10_000;

/**
 * The bucket's layout: every key starts with its kind, then the owner.
 *
 *   media/{owner}/{media_id|upload_id}/{name}   sources, mezzanines, proxies; an upload lands here
 *   derived/{owner}/{media_id}/…                analyses, cleaned sound, in-betweens, indexes
 *   outputs/{owner}/{job_or_frames_id}/{name}
 *   tmp/…                                       the store's own probes (a bucket rule clears it)
 *
 * `cache/…` is never in the bucket: it stays on the node's disk. An owner has no one prefix
 * (`forget` removes all of theirs); `owner()` is the prefix of their media.
 */
export const S3_BLOB_KEYS: BlobKeys = {
  media: (owner, mediaId, name) => `media/${ownerKey(owner)}/${mediaId}/${name}`,
  derived: (owner, mediaId, ...name) =>
    ['derived', ownerKey(owner), mediaId, ...name].filter(Boolean).join('/'),
  output: (owner, id, name) => `outputs/${ownerKey(owner)}/${id}/${name}`,
  outputs: (owner) => `outputs/${ownerKey(owner)}`,
  upload: (owner, uploadId, name) => `media/${ownerKey(owner)}/${uploadId}/${name}`,
  uploads: (owner) => `media/${ownerKey(owner)}/u_`,
  owner: (owner) => `media/${ownerKey(owner)}`,
  cache: (...name) => ['cache', ...name].join('/'),
};

/**
 * What the bucket cannot hold about a blob: how many holders share a media file, and a last use
 * later than its last write. Most blobs have no record: one holder, last used when written.
 */
export interface BlobRecord {
  key: BlobKey;
  /** Holders of a media file. Absent or 1: one. 0: its last holder is deleting it. */
  refs?: number;
  /** When `touch` last marked it used. */
  used_at?: string;
}

export const BLOBS = defineCollection<BlobRecord>({
  name: 'blobs',
  scope: 'owner',
  fs: { dir: 'blobs' },
});

export interface S3BlobOptions {
  /** `https://fsn1.your-objectstorage.com`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Address the bucket as a path on the endpoint (MinIO) instead of a host name under it. */
  pathStyle?: boolean;
  /** Where holders and last uses are kept (the `blobs` collection). */
  records: Records;
  /** This node's disk, for `cache/…` keys. */
  local: FsBlobStore;
  /** Part size of an upload in parts, before it grows to stay under 10,000 parts. Default 16 MiB. */
  partBytes?: number;
  /** Parts of one transfer sent or fetched at once. Default 6. */
  concurrency?: number;
  /** Requests to the bucket at once, all transfers together. Default 64 (the bucket allows 256). */
  connections?: number;
  /** A copy larger than this is made in parts. Default 4 GiB (one request copies up to 5). */
  copyPartBytes?: number;
}

/** What follows a blob's key in the keys of an in-order upload's states (see multipartPart). */
const PARTS_SUFFIX = '.parts/';
/** What an in-order part's etag starts with; the rest is the key of the state after it. */
const IN_ORDER = 'seq:';

/** An in-order upload after one of its parts: the bucket's real parts, and what is left over. */
interface UploadSoFar {
  /** The number the next real part takes. */
  next: number;
  /** Real parts so far: number, the bucket's tag, bytes. */
  parts: Array<[number, string, number]>;
  /** Bytes received and not yet in a real part (under 5 MiB). */
  tail: Buffer;
}

type Sdk = typeof import('@aws-sdk/client-s3');

interface Loaded {
  sdk: Sdk;
  client: S3Client;
}

function errno(code: 'ENOENT' | 'EEXIST', message: string): Error {
  return Object.assign(new Error(message), { code });
}

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function notFound(error: unknown): boolean {
  const name = (error as Error | undefined)?.name;
  return (
    name === 'NoSuchKey' || name === 'NotFound' || name === 'NoSuchUpload' || status(error) === 404
  );
}

function precondition(error: unknown): boolean {
  return (error as Error | undefined)?.name === 'PreconditionFailed' || status(error) === 412;
}

/** Runs `work` over `items`, at most `limit` at once; the first failure rejects. */
async function each<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** The part size for a file of `bytes`: `base`, or what keeps it under 10,000 parts, in whole MiB. */
export function partSize(bytes: number, base: number): number {
  const least = Math.ceil(bytes / S3_MAX_PARTS / MIB) * MIB;
  return Math.max(base, least, S3_MIN_PART_BYTES);
}

/**
 * Blobs as objects in an S3 bucket (Hetzner Object Storage, MinIO, or S3 itself). The bucket is
 * the truth for what exists and how big it is; the `blobs` records add only what it cannot say
 * (see BlobRecord). The SDK is loaded when the store is first used, so a server on the
 * filesystem never loads it.
 */
export class S3BlobStore implements BlobStore {
  readonly keys = S3_BLOB_KEYS;
  readonly remote = true;
  readonly bucket: string;
  /** Where a link to a blob points: the origin a page must allow to play one. */
  readonly origin: string;
  readonly partBytes: number;
  readonly concurrency: number;
  readonly #o: S3BlobOptions;
  readonly #records: Records;
  readonly #local: FsBlobStore;
  #loaded: Promise<Loaded> | undefined;
  /** Whether the bucket refuses a write to a taken key when asked to (`If-None-Match: *`). */
  #conditional: boolean | undefined;
  #free: number;
  readonly #waiting: Array<() => void> = [];

  constructor(options: S3BlobOptions) {
    this.#o = options;
    this.#records = options.records;
    this.#local = options.local;
    this.bucket = options.bucket;
    this.partBytes = Math.max(S3_MIN_PART_BYTES, options.partBytes ?? 16 * MIB);
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.#free = Math.max(1, options.connections ?? 64);
    const url = new URL(options.endpoint);
    this.origin = options.pathStyle ? url.origin : `${url.protocol}//${options.bucket}.${url.host}`;
  }

  async #s3(): Promise<Loaded> {
    this.#loaded ??= (async () => {
      const sdk = await import('@aws-sdk/client-s3');
      const sockets = Math.max(8, this.#o.connections ?? 64);
      const client = new sdk.S3Client({
        endpoint: this.#o.endpoint,
        region: this.#o.region,
        credentials: {
          accessKeyId: this.#o.accessKeyId,
          secretAccessKey: this.#o.secretAccessKey,
        },
        forcePathStyle: this.#o.pathStyle === true,
        // Stores that are not AWS may refuse the CRC checksums newer SDKs add by default.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 4,
        requestHandler: {
          connectionTimeout: 10_000,
          httpsAgent: { keepAlive: true, maxSockets: sockets },
          httpAgent: { keepAlive: true, maxSockets: sockets },
        },
      });
      return { sdk, client };
    })();
    return this.#loaded;
  }

  /** One request's turn: no more than `connections` talk to the bucket at once. */
  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }

  /**
   * A request to the bucket. A missing object rejects as ENOENT; anything else is logged with
   * its detail and reaches the caller as a plain refusal that names nothing of the store.
   */
  async #call<T>(operation: string, key: string, work: (s3: Loaded) => Promise<T>): Promise<T> {
    const s3 = await this.#s3();
    try {
      return await this.#slot(() => work(s3));
    } catch (error) {
      if (notFound(error)) throw errno('ENOENT', `No blob ${key}`);
      if (precondition(error)) throw errno('EEXIST', `A blob is already at ${key}`);
      throw this.#failed(operation, key, error);
    }
  }

  #failed(operation: string, key: string, error: unknown): CfError {
    const e = error as Error;
    process.stderr.write(
      `blobs: ${operation} ${key}: ${e?.name ?? 'Error'}: ${e?.message ?? error}${status(error) ? ` (${status(error)})` : ''}\n`,
    );
    return new CfError(
      'service_unavailable',
      'The server could not read or write a file just now',
      {
        hint: 'Nothing is wrong with the call; make it again in a moment',
      },
    );
  }

  /**
   * Checks the bucket answers with these settings, and learns whether it honours a write that
   * must not replace. Rejects in plain words (never with a key) when it cannot be used.
   */
  async ready(): Promise<void> {
    const { sdk, client } = await this.#s3();
    try {
      await client.send(new sdk.HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const e = error as Error;
      process.stderr.write(`blobs: bucket check: ${e?.name}: ${e?.message}\n`);
      const code = status(error);
      throw new Error(
        code === 404
          ? 'CUTTINGFLOOR_S3_BUCKET names a bucket that does not exist at CUTTINGFLOOR_S3_ENDPOINT'
          : code === 403 || code === 401
            ? 'The bucket refused CUTTINGFLOOR_S3_ACCESS_KEY_ID and CUTTINGFLOOR_S3_SECRET_ACCESS_KEY (or they may not use CUTTINGFLOOR_S3_BUCKET)'
            : 'The bucket did not answer: check CUTTINGFLOOR_S3_ENDPOINT, CUTTINGFLOOR_S3_REGION and CUTTINGFLOOR_S3_BUCKET',
      );
    }
    await this.conditionalWrites();
  }

  /** Nothing to let go of but idle connections. */
  async close(): Promise<void> {
    const loaded = await this.#loaded?.catch(() => undefined);
    loaded?.client.destroy();
  }

  /**
   * Whether the bucket refuses a put with `If-None-Match: *` over an existing object. Asked
   * once: an object under `tmp/` is put twice, the second time conditionally.
   */
  async conditionalWrites(): Promise<boolean> {
    if (this.#conditional !== undefined) return this.#conditional;
    const { sdk, client } = await this.#s3();
    const key = `tmp/probe-${randomBytes(8).toString('hex')}`;
    try {
      await client.send(
        new sdk.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: Buffer.from('1') }),
      );
      try {
        await client.send(
          new sdk.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: Buffer.from('2'),
            IfNoneMatch: '*',
          }),
        );
        this.#conditional = false;
      } catch (error) {
        // Anything but "it is taken" (a store that rejects the header outright) is not support.
        this.#conditional = precondition(error);
      }
    } catch (error) {
      throw this.#failed('probe', key, error);
    } finally {
      await client
        .send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
        .catch(() => undefined);
    }
    if (!this.#conditional) {
      process.stderr.write(
        'blobs: the bucket does not honour If-None-Match: * on a put; a write that must not replace is claimed in the records instead\n',
      );
    }
    return this.#conditional;
  }

  #isLocal(key: BlobKey): boolean {
    return key === 'cache' || key.startsWith('cache/');
  }

  /** The owner key a blob's key names, and whether it is a media file (which counts holders). */
  #owned(key: BlobKey): { owner: string; media: boolean } | undefined {
    const m = /^(media|derived|outputs)\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(key);
    return m ? { owner: m[2] as string, media: m[1] === 'media' } : undefined;
  }

  #id(key: BlobKey): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 40);
  }

  #kept(owner: string): Collection<BlobRecord> {
    return this.#records.collection(BLOBS, { owner });
  }

  async #record(key: BlobKey): Promise<BlobRecord | undefined> {
    const owned = this.#owned(key);
    return owned?.media ? this.#kept(owned.owner).get(this.#id(key)) : undefined;
  }

  async put(
    key: BlobKey,
    from: BlobSource,
    options: { type?: string; private?: boolean; durable?: boolean } = {},
  ): Promise<BlobHead> {
    if (this.#isLocal(key)) return this.#local.put(key, from, options);
    if ('bytes' in from) return this.#putBytes(key, Buffer.from(from.bytes), options.type);
    if ('file' in from) {
      const { size } = await stat(from.file);
      const head = await this.#putFile(key, from.file, size, options.type);
      if (from.move) await rm(from.file, { force: true });
      return head;
    }
    return this.#putStream(key, from.stream, options.type);
  }

  async #putBytes(key: BlobKey, body: Buffer, type: string | undefined): Promise<BlobHead> {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const out = await this.#call('put', key, ({ sdk, client }) =>
      client.send(
        new sdk.PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          Metadata: { sha256 },
          ...(type ? { ContentType: type } : {}),
        }),
      ),
    );
    return this.#made(key, body.length, out.ETag, sha256, type);
  }

  #made(
    key: BlobKey,
    bytes: number,
    etag: string | undefined,
    sha256: string | undefined,
    type: string | undefined,
  ): BlobHead {
    return {
      key,
      bytes,
      modifiedAt: new Date(),
      refs: 1,
      ...(etag ? { etag } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(type ? { type } : {}),
    };
  }

  /** A local file: one request when small, else parts sent side by side, its hash known first. */
  async #putFile(
    key: BlobKey,
    file: string,
    size: number,
    type: string | undefined,
  ): Promise<BlobHead> {
    if (size <= this.partBytes) {
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(file)) chunks.push(chunk as Buffer);
      return this.#putBytes(key, Buffer.concat(chunks), type);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { highWaterMark: MIB })) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const uploadId = await this.#start(key, type, { sha256 });
    try {
      const each_ = partSize(size, this.partBytes);
      const numbers = Array.from({ length: Math.ceil(size / each_) }, (_, i) => i + 1);
      const parts: BlobPart[] = [];
      await each(numbers, this.concurrency, async (part) => {
        const start = (part - 1) * each_;
        const bytes = Math.min(each_, size - start);
        // The SDK never sends a stream twice, so a part that fails is read and sent again here.
        for (let attempt = 1; ; attempt += 1) {
          try {
            const out = await this.#call('part', key, ({ sdk, client }) =>
              client.send(
                new sdk.UploadPartCommand({
                  Bucket: this.bucket,
                  Key: key,
                  UploadId: uploadId,
                  PartNumber: part,
                  Body: createReadStream(file, { start, end: start + bytes - 1 }),
                  ContentLength: bytes,
                }),
              ),
            );
            parts.push({ part, bytes, etag: out.ETag ?? '' });
            return;
          } catch (error) {
            if (attempt >= 3) throw error;
          }
        }
      });
      const head = await this.multipartComplete(key, uploadId, parts);
      return { ...head, sha256 };
    } catch (error) {
      await this.multipartAbort(key, uploadId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A stream of unknown length: held in memory a part at a time. One that ends within the first
   * part is one request and keeps its hash; a longer one goes up in parts, in order.
   */
  async #putStream(key: BlobKey, stream: Readable, type: string | undefined): Promise<BlobHead> {
    const size = this.partBytes;
    let held: Buffer[] = [];
    let bytes = 0;
    let uploadId: string | undefined;
    const parts: BlobPart[] = [];
    const flush = async () => {
      const body = Buffer.concat(held);
      held = [];
      bytes = 0;
      uploadId ??= await this.#start(key, type, {});
      const part = parts.length + 1;
      const id = uploadId;
      const out = await this.#call('part', key, ({ sdk, client }) =>
        client.send(
          new sdk.UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: id,
            PartNumber: part,
            Body: body,
            ContentLength: body.length,
          }),
        ),
      );
      parts.push({ part, bytes: body.length, etag: out.ETag ?? '' });
    };
    try {
      for await (const chunk of stream) {
        let rest = chunk as Buffer;
        while (bytes + rest.length > size) {
          const take = size - bytes;
          held.push(rest.subarray(0, take));
          bytes += take;
          rest = rest.subarray(take);
          await flush();
        }
        if (rest.length) {
          held.push(rest);
          bytes += rest.length;
        }
      }
      if (!uploadId) return await this.#putBytes(key, Buffer.concat(held), type);
      if (bytes) await flush();
      return await this.multipartComplete(key, uploadId, parts);
    } catch (error) {
      if (uploadId) await this.multipartAbort(key, uploadId).catch(() => undefined);
      throw error;
    }
  }

  async #start(
    key: BlobKey,
    type: string | undefined,
    metadata: Record<string, string>,
  ): Promise<string> {
    const out = await this.#call('start', key, ({ sdk, client }) =>
      client.send(
        new sdk.CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ...(type ? { ContentType: type } : {}),
          ...(Object.keys(metadata).length ? { Metadata: metadata } : {}),
        }),
      ),
    );
    if (!out.UploadId) throw this.#failed('start', key, new Error('no upload id'));
    return out.UploadId;
  }

  async get(key: BlobKey): Promise<Readable> {
    if (this.#isLocal(key)) return this.#local.get(key);
    return this.read(key, {});
  }

  async getRange(key: BlobKey, start: number, end?: number): Promise<Readable> {
    if (this.#isLocal(key)) return this.#local.getRange(key, start, end);
    return this.read(key, { start, ...(end === undefined ? {} : { end }) });
  }

  /**
   * The blob's bytes, or a range of them. With `etag` the read fails (EEXIST) when the blob has
   * been written again since that tag was read, so parts fetched apart are of one writing.
   */
  async read(
    key: BlobKey,
    range: { start?: number; end?: number; etag?: string },
  ): Promise<Readable> {
    const out = await this.#call('get', key, ({ sdk, client }) =>
      client.send(
        new sdk.GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range.start !== undefined || range.end !== undefined
            ? { Range: `bytes=${range.start ?? 0}-${range.end ?? ''}` }
            : {}),
          ...(range.etag ? { IfMatch: range.etag } : {}),
        }),
      ),
    );
    return out.Body as Readable;
  }

  async head(key: BlobKey): Promise<BlobHead | undefined> {
    if (this.#isLocal(key)) return this.#local.head(key);
    const head = await this.stat(key);
    if (!head) return undefined;
    const record = await this.#record(key);
    return record ? { ...head, refs: Math.max(1, record.refs ?? 1) } : head;
  }

  /** What the bucket says of one object, without the holders the records count. */
  async stat(key: BlobKey): Promise<BlobHead | undefined> {
    try {
      const out = await this.#call('head', key, ({ sdk, client }) =>
        client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: key })),
      );
      return {
        key,
        bytes: out.ContentLength ?? 0,
        modifiedAt: out.LastModified ?? new Date(),
        refs: 1,
        ...(out.ETag ? { etag: out.ETag } : {}),
        ...(out.Metadata?.sha256 ? { sha256: out.Metadata.sha256 } : {}),
        ...(out.ContentType ? { type: out.ContentType } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async #remove(key: BlobKey): Promise<void> {
    await this.#call('delete', key, ({ sdk, client }) =>
      client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: key })),
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /**
   * A media file goes only with its last holder. The holder count is taken down in the records
   * first, each step a compare-and-set, so a holder added at the same moment either counts
   * before the object goes or finds it going (and is refused).
   */
  async delete(key: BlobKey): Promise<void> {
    if (this.#isLocal(key)) return this.#local.delete(key);
    const owned = this.#owned(key);
    if (!owned?.media) return this.#remove(key);
    const kept = this.#kept(owned.owner);
    const id = this.#id(key);
    for (let turn = 0; ; turn += 1) {
      if (turn > 50) throw this.#failed('delete', key, new Error('holders kept changing'));
      const record = await kept.get(id);
      if (!record) {
        // One holder and no record: say it is going, so no holder is added meanwhile.
        if (await kept.insertOnce(id, { key, refs: 0 })) break;
        continue;
      }
      const refs = record.refs ?? 1;
      if (record.refs === undefined) {
        await kept.update(id, { set: { refs } });
        continue;
      }
      if (refs > 1) {
        if (await kept.compareAndSet(id, { refs }, { refs: refs - 1 })) return;
        continue;
      }
      if (refs <= 0) break;
      if (await kept.compareAndSet(id, { refs }, { refs: 0 })) break;
    }
    await this.#remove(key);
    await kept.delete(id);
  }

  /** The folder a prefix names: everything under `prefix/`. */
  #folder(prefix: BlobKey): string {
    return `${prefix.replace(/\/+$/, '')}/`;
  }

  async #listed(
    prefix: string,
  ): Promise<Array<{ key: string; bytes: number; modifiedAt: Date; etag?: string }>> {
    const found: Array<{ key: string; bytes: number; modifiedAt: Date; etag?: string }> = [];
    let token: string | undefined;
    do {
      const page = await this.#call('list', prefix, ({ sdk, client }) =>
        client.send(
          new sdk.ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        ),
      );
      for (const o of page.Contents ?? []) {
        if (!o.Key) continue;
        found.push({
          key: o.Key,
          bytes: o.Size ?? 0,
          modifiedAt: o.LastModified ?? new Date(),
          ...(o.ETag ? { etag: o.ETag } : {}),
        });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    // By key, as every store lists, whatever order the bucket answers in.
    return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async deletePrefix(prefix: BlobKey): Promise<void> {
    if (this.#isLocal(prefix)) return this.#local.deletePrefix(prefix);
    const bare = prefix.replace(/\/+$/, '');
    const found = await this.#listed(this.#folder(prefix));
    await each(found, 16, ({ key }) => this.delete(key));
    // A prefix that is one blob's own name ({kind}/{owner}/{id}/{name} at the least).
    if (bare.split('/').length < 4) return;
    if (!this.#owned(bare)?.media) await this.#remove(bare);
    else if (await this.stat(bare)) await this.delete(bare);
  }

  /** Sizes and times as the bucket lists them; a hash and a type come from `head`. */
  async list(prefix: BlobKey): Promise<BlobHead[]> {
    if (this.#isLocal(prefix)) return this.#local.list(prefix);
    const found = await this.#listed(this.#folder(prefix));
    const owned = this.#owned(prefix);
    const refs = new Map<string, number>();
    if (owned?.media && found.length) {
      for (const { value } of await this.#kept(owned.owner).find()) {
        if (value.refs !== undefined) refs.set(value.key, value.refs);
      }
    }
    return found.map((o) => ({ ...o, refs: Math.max(1, refs.get(o.key) ?? 1) }));
  }

  #source(key: BlobKey): string {
    return `${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async copy(from: BlobKey, to: BlobKey): Promise<BlobHead> {
    if (this.#isLocal(from) || this.#isLocal(to)) {
      if (this.#isLocal(from) && this.#isLocal(to)) return this.#local.copy(from, to);
      return this.put(to, { stream: await this.get(from) });
    }
    const head = await this.stat(from);
    if (!head) throw errno('ENOENT', `No blob ${from}`);
    const limit = this.#o.copyPartBytes ?? 4 * 1024 ** 3;
    if (head.bytes <= limit) {
      await this.#call('copy', from, ({ sdk, client }) =>
        client.send(
          new sdk.CopyObjectCommand({
            Bucket: this.bucket,
            Key: to,
            CopySource: this.#source(from),
          }),
        ),
      );
    } else {
      // In parts, each a range of the source copied inside the store.
      const uploadId = await this.#start(to, head.type, head.sha256 ? { sha256: head.sha256 } : {});
      try {
        const size = partSize(head.bytes, Math.min(limit, 1024 ** 3));
        const numbers = Array.from({ length: Math.ceil(head.bytes / size) }, (_, i) => i + 1);
        const parts: BlobPart[] = [];
        await each(numbers, this.concurrency, async (part) => {
          const start = (part - 1) * size;
          const end = Math.min(head.bytes, start + size) - 1;
          const out = await this.#call('copy', from, ({ sdk, client }) =>
            client.send(
              new sdk.UploadPartCopyCommand({
                Bucket: this.bucket,
                Key: to,
                UploadId: uploadId,
                PartNumber: part,
                CopySource: this.#source(from),
                CopySourceRange: `bytes=${start}-${end}`,
                ...(head.etag ? { CopySourceIfMatch: head.etag } : {}),
              }),
            ),
          );
          parts.push({ part, bytes: end - start + 1, etag: out.CopyPartResult?.ETag ?? '' });
        });
        await this.multipartComplete(to, uploadId, parts);
      } catch (error) {
        await this.multipartAbort(to, uploadId).catch(() => undefined);
        throw error;
      }
    }
    const { etag: _etag, ...rest } = head;
    return { ...rest, key: to, modifiedAt: new Date(), refs: 1 };
  }

  /**
   * A media file gains a holder in the records and keeps its key (`from` is returned): no bytes
   * move. Any other blob is copied inside the store to `to`, which is returned.
   */
  async share(from: BlobKey, to: BlobKey): Promise<BlobKey> {
    if (this.#isLocal(from) || this.#isLocal(to)) {
      await this.copy(from, to);
      return to;
    }
    const owned = this.#owned(from);
    if (!owned?.media) {
      await this.copy(from, to);
      return to;
    }
    if (!(await this.stat(from))) throw errno('ENOENT', `No blob ${from}`);
    const kept = this.#kept(owned.owner);
    const id = this.#id(from);
    for (let turn = 0; ; turn += 1) {
      if (turn > 50) throw this.#failed('share', from, new Error('holders kept changing'));
      const record = await kept.get(id);
      if (!record) {
        if (await kept.insertOnce(id, { key: from, refs: 2 })) break;
        continue;
      }
      if (record.refs === undefined) {
        await kept.update(id, { set: { refs: 1 } });
        continue;
      }
      // Its last holder is deleting it.
      if (record.refs <= 0) throw errno('ENOENT', `No blob ${from}`);
      if (await kept.compareAndSet(id, { refs: record.refs }, { refs: record.refs + 1 })) break;
    }
    // Gone in between (deleted by a holder with no record yet): this holder holds nothing.
    if (!(await this.stat(from))) {
      await kept.delete(id);
      throw errno('ENOENT', `No blob ${from}`);
    }
    return from;
  }

  async move(from: BlobKey, to: BlobKey, options: { ifAbsent?: boolean } = {}): Promise<BlobKey> {
    if (this.#isLocal(from) && this.#isLocal(to)) return this.#local.move(from, to, options);
    if (from === to) return to;
    if (options.ifAbsent) await this.#putAbsent(from, to);
    else await this.copy(from, to);
    await this.delete(from);
    return to;
  }

  /**
   * Writes `from`'s bytes at `to` only when nothing is there: a put with `If-None-Match: *`,
   * which the bucket decides atomically. Where the bucket does not honour that, the name is
   * claimed in the records for the length of the write instead.
   */
  async #putAbsent(from: BlobKey, to: BlobKey): Promise<void> {
    const head = await this.stat(from);
    if (!head) throw errno('ENOENT', `No blob ${from}`);
    if (head.bytes > 4 * 1024 ** 3) {
      throw this.#failed('move', to, new Error('too large to place only when absent'));
    }
    const conditional = await this.conditionalWrites();
    const write = async () => {
      // Small (an analysis): held in memory, so a retry sends the same bytes.
      const body =
        head.bytes <= this.partBytes ? await buffer(await this.get(from)) : await this.get(from);
      await this.#call('put', to, ({ sdk, client }) =>
        client.send(
          new sdk.PutObjectCommand({
            Bucket: this.bucket,
            Key: to,
            Body: body,
            ContentLength: head.bytes,
            ...(head.type ? { ContentType: head.type } : {}),
            ...(head.sha256 ? { Metadata: { sha256: head.sha256 } } : {}),
            ...(conditional ? { IfNoneMatch: '*' } : {}),
          }),
        ),
      );
    };
    if (conditional) {
      try {
        await write();
      } catch (error) {
        // Two conditional writes at one moment: the store asks one to come back; by then the
        // other has landed.
        if (status(error) === 409 && (await this.stat(to))) throw errno('EEXIST', `Taken: ${to}`);
        throw error;
      }
      return;
    }
    const owned = this.#owned(to);
    if (!owned) throw this.#failed('move', to, new Error('no owner to claim under'));
    const kept = this.#kept(owned.owner);
    const claim = `claim-${this.#id(to)}`;
    for (let turn = 0; ; turn += 1) {
      if (await kept.insertOnce(claim, { key: to, used_at: new Date().toISOString() })) break;
      // A claim its writer never let go of (it died) is taken over after a minute.
      const stale = await kept.get(claim);
      const age = stale?.used_at ? Date.now() - Date.parse(stale.used_at) : 0;
      if (stale && age > 60_000 && turn < 2) {
        await kept.delete(claim);
        continue;
      }
      throw errno('EEXIST', `A blob is already at ${to}`);
    }
    try {
      if (await this.stat(to)) throw errno('EEXIST', `A blob is already at ${to}`);
      await write();
    } finally {
      await kept.delete(claim).catch(() => undefined);
    }
  }

  /** A last use later than the last write is a record; the bucket keeps only when it was written. */
  async touch(key: BlobKey): Promise<void> {
    if (this.#isLocal(key)) return this.#local.touch(key);
    const name = key.replace(/\/+$/, '');
    const owned = this.#owned(name);
    if (!owned) return;
    const kept = this.#kept(owned.owner);
    const id = this.#id(name);
    const used_at = new Date().toISOString();
    if (await kept.update(id, { set: { used_at } })) return;
    const fresh: BlobRecord = { key: name, used_at, ...(owned.media ? { refs: 1 } : {}) };
    if (!(await kept.insertOnce(id, fresh))) await kept.update(id, { set: { used_at } });
  }

  /**
   * Each entry directly under the prefix is as old as the newest write under it, or as its
   * last `touch` when that came later (a touch record written after the newest object).
   */
  async expire(
    prefix: BlobKey,
    ttlMs: number,
    keep?: (name: string) => boolean,
  ): Promise<string[]> {
    if (this.#isLocal(prefix)) return this.#local.expire(prefix, ttlMs, keep);
    const folder = this.#folder(prefix);
    const newest = new Map<string, number>();
    for (const o of await this.#listed(folder)) {
      const name = o.key.slice(folder.length).split('/')[0] as string;
      newest.set(name, Math.max(newest.get(name) ?? 0, o.modifiedAt.getTime()));
    }
    if (!newest.size) return [];
    const owned = this.#owned(folder);
    const touched = new Map<string, { at: number; written: number; id: string }>();
    if (owned) {
      for (const { id, value, usedAt } of await this.#kept(owned.owner).find()) {
        if (!value.used_at || !value.key.startsWith(folder)) continue;
        const name = value.key.slice(folder.length);
        if (!name.includes('/')) {
          touched.set(name, { at: Date.parse(value.used_at), written: usedAt.getTime(), id });
        }
      }
    }
    const cutoff = Date.now() - ttlMs;
    const removed: string[] = [];
    for (const [name, written] of [...newest].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (keep?.(name)) continue;
      const touch = touched.get(name);
      // The bucket's times are whole seconds: a touch in the same second came after.
      const used = touch && touch.written + 1000 >= written ? touch.at : written;
      if (!(used < cutoff)) continue;
      await this.deletePrefix(`${folder}${name}`);
      if (touch && owned) await this.#kept(owned.owner).delete(touch.id);
      removed.push(name);
    }
    return removed;
  }

  #prefixes(owner: string): string[] {
    const key = ownerKey(owner);
    return [`media/${key}/`, `derived/${key}/`, `outputs/${key}/`];
  }

  /** Every object under the owner's prefixes, each once however many hold it. */
  async usage(owner: string): Promise<number> {
    let total = 0;
    for (const prefix of this.#prefixes(owner)) {
      for (const o of await this.#listed(prefix)) total += o.bytes;
    }
    return total;
  }

  async freeable(prefix: BlobKey): Promise<number> {
    if (this.#isLocal(prefix)) return this.#local.freeable(prefix);
    let total = 0;
    for (const head of await this.list(prefix)) if (head.refs <= 1) total += head.bytes;
    return total;
  }

  /** Every object the owner has, whoever holds it, and every upload of theirs still in parts. */
  async forget(owner: string): Promise<void> {
    for (const prefix of this.#prefixes(owner)) {
      await each(await this.#listed(prefix), 16, ({ key }) => this.#remove(key));
    }
    const media = this.#prefixes(owner)[0] as string;
    const open = await this.#call('uploads', media, ({ sdk, client }) =>
      client.send(new sdk.ListMultipartUploadsCommand({ Bucket: this.bucket, Prefix: media })),
    );
    for (const upload of open.Uploads ?? []) {
      if (upload.Key && upload.UploadId) await this.multipartAbort(upload.Key, upload.UploadId);
    }
    await this.#kept(ownerKey(owner)).clear();
  }

  async presignGet(key: BlobKey, options: PresignOptions): Promise<string | undefined> {
    if (this.#isLocal(key)) return undefined;
    const { sdk, client } = await this.#s3();
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(
      client,
      new sdk.GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.disposition ? { ResponseContentDisposition: options.disposition } : {}),
        ...(options.type ? { ResponseContentType: options.type } : {}),
      }),
      { expiresIn: Math.max(1, Math.min(7 * 86_400, Math.round(options.ttlMs / 1000))) },
    );
  }

  async multipartStart(key: BlobKey, options: { type?: string } = {}): Promise<string> {
    if (this.#isLocal(key)) return this.#local.multipartStart(key);
    return this.#start(key, options.type, {});
  }

  /**
   * In order (the default), parts may be any size, which the bucket does not allow: bytes are
   * gathered into real parts of the bucket's upload, and what is left over at the end of each
   * call (under 5 MiB) is kept in the bucket as a small object beside the blob, with the list
   * of real parts so far. The part returned names that object, so the caller's latest part is
   * the whole state of the upload and any server can take the next one.
   */
  async multipartPart(
    key: BlobKey,
    uploadId: string,
    part: number,
    body: Readable,
    options: { bytes?: number; after?: BlobPart; anyOrder?: boolean } = {},
  ): Promise<BlobPart> {
    if (this.#isLocal(key)) return this.#local.multipartPart(key, uploadId, part, body);
    if (!options.anyOrder) return this.#inOrder(key, uploadId, part, body, options.after);
    // Streamed straight through when its length is known; held in memory first when not (the
    // bucket must be told a part's length before its first byte).
    const sent = options.bytes === undefined ? await buffer(body) : body;
    const length = options.bytes ?? (sent as Buffer).length;
    const etag = await this.#part(key, uploadId, part, sent, length);
    return { part, bytes: length, etag };
  }

  async #part(
    key: BlobKey,
    uploadId: string,
    part: number,
    body: Readable | Buffer,
    bytes: number,
  ): Promise<string> {
    if (part < 1 || part > S3_MAX_PARTS) {
      throw new CfError('limit_exceeded', `An upload takes up to ${S3_MAX_PARTS} parts`, {
        hint: 'Send the file in larger parts',
      });
    }
    const out = await this.#call('part', key, ({ sdk, client }) =>
      client.send(
        new sdk.UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: part,
          Body: body,
          ContentLength: bytes,
        }),
      ),
    );
    return out.ETag ?? '';
  }

  /** Where an upload's state after its in-order part `part` is kept. */
  #stateKey(key: BlobKey, part: number, token: string): string {
    return `${key}${PARTS_SUFFIX}${String(part).padStart(6, '0')}-${token}`;
  }

  async #state(key: BlobKey, part: number, after: BlobPart | undefined): Promise<UploadSoFar> {
    let at = after?.etag.startsWith(IN_ORDER) ? after.etag.slice(IN_ORDER.length) : undefined;
    if (after && (after.part !== part || !at)) {
      throw new Error(`Part ${part + 1} of ${key} does not follow the part given`);
    }
    if (!at) {
      // No part handed back: the newest state written for that part number.
      const prefix = `${key}${PARTS_SUFFIX}${String(part).padStart(6, '0')}-`;
      const found = (await this.#listed(prefix)).sort(
        (a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime(),
      );
      at = found[0]?.key;
    }
    if (!at) throw new Error(`Part ${part + 1} of ${key} was sent before part ${part}`);
    const body = await buffer(await this.read(at, {}));
    const line = body.indexOf(0x0a);
    const { next, parts } = JSON.parse(body.subarray(0, line).toString('utf8')) as {
      next: number;
      parts: Array<[number, string, number]>;
    };
    return { next, parts, tail: body.subarray(line + 1) };
  }

  async #inOrder(
    key: BlobKey,
    uploadId: string,
    part: number,
    body: Readable,
    after: BlobPart | undefined,
  ): Promise<BlobPart> {
    const before: UploadSoFar =
      part <= 1
        ? { next: 1, parts: [], tail: Buffer.alloc(0) }
        : await this.#state(key, part - 1, after);
    const parts = [...before.parts];
    let next = before.next;
    let held: Buffer[] = before.tail.length ? [before.tail] : [];
    let size = before.tail.length;
    let received = 0;
    const flush = async (bytes: Buffer) => {
      const etag = await this.#part(key, uploadId, next, bytes, bytes.length);
      parts.push([next, etag, bytes.length]);
      next += 1;
    };
    let broken: unknown;
    try {
      for await (const chunk of body) {
        let rest = chunk as Buffer;
        received += rest.length;
        while (size + rest.length >= this.partBytes) {
          const take = this.partBytes - size;
          held.push(rest.subarray(0, take));
          rest = rest.subarray(take);
          const full = Buffer.concat(held);
          held = [];
          size = 0;
          await flush(full);
        }
        if (rest.length) {
          held.push(rest);
          size += rest.length;
        }
      }
    } catch (error) {
      // A refusal of the store's own is the caller's to hear; a sender that broke off keeps
      // what arrived.
      if (error instanceof CfError || (error as { landed?: unknown })?.landed) throw error;
      broken = error;
      if (!received) throw error;
    }
    let tail = Buffer.concat(held);
    if (tail.length >= S3_MIN_PART_BYTES) {
      await flush(tail);
      tail = Buffer.alloc(0);
    }
    const at = this.#stateKey(key, part, randomBytes(6).toString('hex'));
    const header = Buffer.from(`${JSON.stringify({ next, parts })}\n`);
    const state = Buffer.concat([header, tail]);
    await this.#call('part', key, ({ sdk, client }) =>
      client.send(
        new sdk.PutObjectCommand({
          Bucket: this.bucket,
          Key: at,
          Body: state,
          ContentLength: state.length,
        }),
      ),
    );
    // States two parts back are no one's to read again (the one before this may be, by a
    // sender repeating this part).
    void this.#listed(`${key}${PARTS_SUFFIX}`)
      .then((found) =>
        each(
          found.filter((o) => Number(o.key.slice(-19, -13)) < part - 1),
          8,
          (o) => this.#remove(o.key),
        ),
      )
      .catch(() => undefined);
    const landed: BlobPart = { part, bytes: received, etag: `${IN_ORDER}${at}` };
    if (broken) {
      throw Object.assign(new Error('The part stopped part way', { cause: broken }), { landed });
    }
    return landed;
  }

  async #dropStates(key: BlobKey): Promise<void> {
    const found = await this.#listed(`${key}${PARTS_SUFFIX}`);
    await each(found, 8, (o) => this.#remove(o.key));
  }

  async multipartComplete(key: BlobKey, uploadId: string, parts: BlobPart[]): Promise<BlobHead> {
    if (this.#isLocal(key)) return this.#local.multipartComplete(key);
    let ordered = [...parts].sort((a, b) => a.part - b.part);
    const last = ordered.at(-1);
    const inOrder = !last || last.etag.startsWith(IN_ORDER);
    if (inOrder) {
      // The latest in-order part names everything: the real parts so far and what is left over,
      // which goes up as the last part (the one part that may be small).
      const state: UploadSoFar = last
        ? await this.#state(key, last.part, last)
        : { next: 1, parts: [], tail: Buffer.alloc(0) };
      const real = [...state.parts];
      if (state.tail.length) {
        const etag = await this.#part(key, uploadId, state.next, state.tail, state.tail.length);
        real.push([state.next, etag, state.tail.length]);
      }
      if (!real.length) {
        // Nothing was sent: an empty blob, which an upload in parts cannot make.
        await this.multipartAbort(key, uploadId);
        return this.#putBytes(key, Buffer.alloc(0), undefined);
      }
      ordered = real.map(([part, etag, bytes]) => ({ part, etag, bytes }));
    }
    const out = await this.#call('complete', key, ({ sdk, client }) =>
      client.send(
        new sdk.CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((p) => ({ PartNumber: p.part, ETag: p.etag })),
          },
        }),
      ),
    );
    if (inOrder) await this.#dropStates(key).catch(() => undefined);
    return this.#made(
      key,
      ordered.reduce((sum, p) => sum + p.bytes, 0),
      out.ETag,
      undefined,
      undefined,
    );
  }

  async multipartAbort(key: BlobKey, uploadId: string): Promise<void> {
    if (this.#isLocal(key)) return this.#local.multipartAbort(key);
    await this.#call('abort', key, ({ sdk, client }) =>
      client.send(
        new sdk.AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      ),
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await this.#dropStates(key);
  }

  /** The parts the bucket holds of an upload in parts, by number. */
  async multipartParts(key: BlobKey, uploadId: string): Promise<BlobPart[]> {
    const parts: BlobPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.#call('parts', key, ({ sdk, client }) =>
        client.send(
          new sdk.ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            ...(marker ? { PartNumberMarker: marker } : {}),
          }),
        ),
      );
      for (const p of page.Parts ?? []) {
        parts.push({ part: p.PartNumber ?? 0, bytes: p.Size ?? 0, etag: p.ETag ?? '' });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  /**
   * Closes what a crash between the bucket and the records leaves, for one owner. `held` is
   * how many of the owner's media and unimported uploads name each media file; `media` the ids
   * that still have a record. Nothing newer than `graceMs` is judged: it may be mid-write.
   *
   * - a record saying its file is going (refs 0): the file and the record go;
   * - a record whose file is gone: the record goes;
   * - a holder count that is not the number of holders: set to it;
   * - a media file no media or upload names: deleted;
   * - derived files of a media that has no record: deleted.
   */
  async orphans(
    owner: string,
    holders: { held: Map<BlobKey, number>; media: Set<string> },
    graceMs: number,
  ): Promise<OrphanReport> {
    const key = ownerKey(owner);
    const report: OrphanReport = { records: 0, objects: 0, refs: 0 };
    const old = (at: Date) => at.getTime() < Date.now() - graceMs;
    const kept = this.#kept(key);
    const mediaPrefix = `media/${key}/`;
    const objects = new Map((await this.#listed(mediaPrefix)).map((o) => [o.key, o]));
    for (const { id, value, usedAt } of await kept.find()) {
      if (!old(usedAt)) continue;
      if (id.startsWith('claim-')) {
        await kept.delete(id);
        report.records += 1;
        continue;
      }
      if (!value.key.startsWith(mediaPrefix)) {
        // A last use of something that has gone.
        const under = await this.#listed(this.#folder(value.key));
        if (!under.length && !(await this.stat(value.key))) {
          await kept.delete(id);
          report.records += 1;
        }
        continue;
      }
      const object = objects.get(value.key);
      const holding = holders.held.get(value.key) ?? 0;
      if (!object) {
        await kept.delete(id);
        report.records += 1;
      } else if ((value.refs ?? 1) <= 0 || holding === 0) {
        if (!old(object.modifiedAt)) continue;
        await this.#remove(value.key);
        await kept.delete(id);
        objects.delete(value.key);
        report.objects += 1;
        report.records += 1;
      } else if (value.refs === undefined) {
        await kept.update(id, { set: { refs: holding } });
      } else if (value.refs !== holding) {
        if (await kept.compareAndSet(id, { refs: value.refs }, { refs: holding })) report.refs += 1;
      }
    }
    for (const object of objects.values()) {
      if (holders.held.has(object.key) || !old(object.modifiedAt)) continue;
      // The state of an upload still being sent is held by the upload, as long as one lasts.
      const upload = object.key.indexOf(PARTS_SUFFIX);
      if (upload > 0) {
        if (holders.held.has(object.key.slice(0, upload))) continue;
        if (object.modifiedAt.getTime() > Date.now() - Math.max(graceMs, 8 * 86_400_000)) continue;
      }
      if (await kept.has(this.#id(object.key))) continue;
      await this.#remove(object.key);
      report.objects += 1;
    }
    const derivedPrefix = `derived/${key}/`;
    const stale = new Map<string, boolean>();
    for (const o of await this.#listed(derivedPrefix)) {
      const id = o.key.slice(derivedPrefix.length).split('/')[0] as string;
      if (holders.media.has(id)) continue;
      stale.set(id, (stale.get(id) ?? true) && old(o.modifiedAt));
    }
    for (const [id, all] of stale) {
      if (!all) continue;
      const found = await this.#listed(`${derivedPrefix}${id}/`);
      await each(found, 16, (o) => this.#remove(o.key));
      report.objects += found.length;
    }
    return report;
  }
}

async function buffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
