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
import { workingCopy } from './blobs.ts';
import type { FsBlobStore } from './fs-blobs.ts';
import { ownerKey } from './fs-util.ts';
import { type Collection, defineCollection, type Records } from './records.ts';

const MIB = 1024 ** 2;
/** The least a part of an upload in parts may be, but for the last (S3's rule). */
export const S3_MIN_PART_BYTES = 5 * MIB;
/** The most parts an upload may have (S3's rule). */
export const S3_MAX_PARTS = 10_000;
/**
 * The most a part of an in-order upload may be. Bytes sent in order are gathered in memory into
 * parts of `partBytes`, so one such upload holds up to about twice that at once (the bytes
 * gathered, and the part made of them while it is sent): 32 MiB at the default 16, 128 MiB here.
 */
export const S3_MAX_PART_BYTES = 64 * MIB;

/**
 * The bucket's layout: every key starts with its kind, then the owner.
 *
 *   media/{owner}/{media_id|upload_id}/{name}   sources, mezzanines, proxies; an upload lands here
 *   derived/{owner}/{media_id}/…                analyses, cleaned sound, in-betweens, indexes
 *   outputs/{owner}/{job_or_frames_id}/{name}
 *   tmp/…                                       the store's own probes (a bucket rule clears it)
 *
 * `cache/…` is never in the bucket: it stays on the node's disk. An owner's blobs have no one
 * prefix in the bucket; `owner()` is the prefix of their media, and that exact name given to
 * `list`, `freeable` or `deletePrefix` stands for everything the owner has, as it does on the
 * filesystem (`media/{owner}/` with its slash is the media alone).
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
  /**
   * The bytes' SHA-256, for a blob that went up as a stream in parts (its hash was not known
   * when its first part was sent, so it could not go with the object as others' do). It holds
   * only while the object's tag is still `etag`: a blob written again is another's bytes.
   */
  sha256?: string;
  etag?: string;
  /** When the orphan sweep first met this file with nothing naming it. */
  orphan_at?: string;
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
  /**
   * Parts sent at the pace of a client (an upload's numbered parts, streamed from the sender to
   * the bucket) at once, apart from `connections`, so slow senders never hold up downloads and
   * other requests. Default 32. One upload has no more than `concurrency` of them at once.
   * Each costs little memory: its bytes stream through (about 64 KiB of buffers), never held.
   */
  uploads?: number;
  /**
   * Send each whole-object put's SHA-256 for the bucket to check before it stores the bytes
   * (`x-amz-checksum-sha256`), where the bucket enforces it (scripts/check-s3.ts says). Parts of
   * an upload in parts are not sent with one: a client's part is streamed before its hash is
   * known, and a bucket wants one on every part or none.
   */
  checksums?: boolean;
  /**
   * Send the MD5 of every body whose bytes are in hand (whole-object puts, parts of a file or an
   * in-order upload) as `Content-MD5`, for the bucket to refuse bytes that arrived changed.
   * Hetzner's store enforces this and not the SHA-256 (scripts/check-s3.ts says which). A part
   * streamed from a client at its pace carries none: its hash is not known before it is sent.
   */
  md5?: boolean;
  /** A copy larger than this is made in parts. Default 4 GiB (one request copies up to 5). */
  copyPartBytes?: number;
  /**
   * Whether the bucket refuses a put with `If-None-Match: *` over an existing object. Default:
   * asked of the bucket itself when the store is first used.
   */
  conditionalWrites?: boolean;
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

interface Listed {
  key: string;
  bytes: number;
  modifiedAt: Date;
  etag?: string;
}

type Sdk = typeof import('@aws-sdk/client-s3');

interface Loaded {
  sdk: Sdk;
  client: S3Client;
}

function errno(code: 'ENOENT' | 'EEXIST' | 'EPART', message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Text that may name a blob, as it may be logged or reach an error: each owner in a key is a
 * short hash of it (an owner is an account id), so logs never carry who a file is.
 */
export function shown(text: string): string {
  return text.replace(
    /\b(media|derived|outputs)\/([A-Za-z0-9_-]{1,64})(?=\/|\b)/g,
    (_all, kind: string, owner: string) =>
      `${kind}/o-${createHash('sha256').update(owner).digest('hex').slice(0, 10)}`,
  );
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

/** A completion naming parts the upload does not hold as named (another sender's bytes). */
function badPart(error: unknown): boolean {
  const name = (error as Error | undefined)?.name;
  return name === 'InvalidPart' || name === 'InvalidPartOrder' || name === 'EntityTooSmall';
}

function precondition(error: unknown): boolean {
  return (error as Error | undefined)?.name === 'PreconditionFailed' || status(error) === 412;
}

/** At most `limit` holders at once; the rest wait their turn in order. */
class Gate {
  #free: number;
  readonly #waiting: Array<() => void> = [];
  constructor(limit: number) {
    this.#free = Math.max(1, limit);
  }

  get idle(): boolean {
    return this.#waiting.length === 0 && this.#free > 0 && this.#busy === 0;
  }

  #busy = 0;

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#busy += 1;
    try {
      return await work();
    } finally {
      this.#busy -= 1;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
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
  /** Requests to the bucket at once (`connections`). */
  readonly #requests: Gate;
  /** Parts streamed at a client's pace at once (`uploads`), and per upload. */
  readonly #paced: Gate;
  readonly #pacedPer = new Map<BlobKey, Gate>();

  constructor(options: S3BlobOptions) {
    // A bucket named with dots is not one host name under the endpoint (its certificate covers
    // one level only): it is reached as a path, which must then be asked for.
    if (options.bucket.includes('.') && !options.pathStyle) {
      throw new Error(
        'A bucket name with dots is reached as a path on the endpoint: set CUTTINGFLOOR_S3_PATH_STYLE=1, or use a name without dots',
      );
    }
    this.#o = options;
    this.#records = options.records;
    this.#local = options.local;
    this.bucket = options.bucket;
    this.partBytes = Math.min(
      S3_MAX_PART_BYTES,
      Math.max(S3_MIN_PART_BYTES, options.partBytes ?? 16 * MIB),
    );
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.#requests = new Gate(options.connections ?? 64);
    this.#paced = new Gate(options.uploads ?? 32);
    this.#conditional = options.conditionalWrites;
    const url = new URL(options.endpoint);
    // Where the client sends requests, as it addresses the bucket.
    this.origin = options.pathStyle ? url.origin : `${url.protocol}//${options.bucket}.${url.host}`;
  }

  async #s3(): Promise<Loaded> {
    this.#loaded ??= (async () => {
      const sdk = await import('@aws-sdk/client-s3');
      // Room for every request of either kind at once.
      const sockets = Math.max(8, (this.#o.connections ?? 64) + (this.#o.uploads ?? 32));
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
          // A request whose socket carries nothing for two minutes is given up (and retried),
          // so a stalled bucket never holds a turn for good. A client that stalls sending a
          // part is cut off by the server in the same time.
          socketTimeout: 120_000,
          httpsAgent: { keepAlive: true, maxSockets: sockets },
          httpAgent: { keepAlive: true, maxSockets: sockets },
        },
      });
      return { sdk, client };
    })();
    return this.#loaded;
  }

  /**
   * A request's turn. Most take one of `connections`. One whose body comes at a client's pace
   * (`paced`, the upload it is part of) takes one of `uploads` instead, and one of its upload's
   * own `concurrency`, so senders however slow never hold up anything else.
   */
  async #slot<T>(work: () => Promise<T>, paced?: BlobKey): Promise<T> {
    if (paced === undefined) return this.#requests.run(work);
    let own = this.#pacedPer.get(paced);
    if (!own) {
      own = new Gate(this.concurrency);
      this.#pacedPer.set(paced, own);
    }
    const gate = own;
    try {
      return await gate.run(() => this.#paced.run(work));
    } finally {
      if (gate.idle && this.#pacedPer.get(paced) === gate) this.#pacedPer.delete(paced);
    }
  }

  /**
   * A request to the bucket. A missing object rejects as ENOENT; parts that are not what the
   * upload holds (CompleteMultipartUpload's InvalidPart) as EPART; anything else is logged with
   * its detail and reaches the caller as a plain refusal that names nothing of the store.
   */
  async #call<T>(
    operation: string,
    key: string,
    work: (s3: Loaded) => Promise<T>,
    paced?: BlobKey,
  ): Promise<T> {
    const s3 = await this.#s3();
    try {
      return await this.#slot(() => work(s3), paced);
    } catch (error) {
      if (notFound(error)) throw errno('ENOENT', `No blob ${shown(key)}`);
      if (precondition(error)) throw errno('EEXIST', `A blob is already at ${shown(key)}`);
      if (badPart(error)) throw errno('EPART', `The parts of ${shown(key)} are not what was sent`);
      throw this.#failed(operation, key, error);
    }
  }

  #failed(operation: string, key: string, error: unknown): CfError {
    const e = error as Error;
    process.stderr.write(
      shown(
        `blobs: ${operation} ${key}: ${e?.name ?? 'Error'}: ${e?.message ?? error}${status(error) ? ` (${status(error)})` : ''}\n`,
      ),
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
      process.stderr.write(shown(`blobs: bucket check: ${e?.name}: ${e?.message}\n`));
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

  /**
   * Makes the bucket when there is none: for a store of one's own to develop or test against
   * (MinIO). A deployment's bucket is made once, by hand, with its rules.
   */
  async createBucket(): Promise<void> {
    const { sdk, client } = await this.#s3();
    try {
      await client.send(new sdk.CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') return;
      throw this.#failed('create bucket', this.bucket, error);
    }
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
    return owned ? this.#kept(owned.owner).get(this.#id(key)) : undefined;
  }

  /** Sets fields of a blob's record, making it when there is none. */
  async #note(key: BlobKey, set: Partial<BlobRecord>): Promise<void> {
    const owned = this.#owned(key);
    if (!owned) return;
    const kept = this.#kept(owned.owner);
    const id = this.#id(key);
    if (await kept.update(id, { set })) return;
    const fresh: BlobRecord = { key, ...(owned.media ? { refs: 1 } : {}), ...set };
    if (!(await kept.insertOnce(id, fresh))) await kept.update(id, { set });
  }

  /** The prefixes a listing covers: an owner's own name is everything of theirs. */
  #scope(prefix: BlobKey): { folders: string[]; owner?: string } {
    const whole = /^media\/([A-Za-z0-9_-]{1,64})$/.exec(prefix);
    return whole
      ? { folders: this.#prefixes(whole[1] as string), owner: whole[1] as string }
      : { folders: [this.#folder(prefix)] };
  }

  /** What callers see of a listing: not the states of uploads still in parts. */
  #shown<T extends { key: string }>(found: T[]): T[] {
    return found.filter((o) => !o.key.includes(PARTS_SUFFIX));
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

  /** The header that has the bucket check a body against its MD5, when that is on. */
  #md5(body: Buffer): { ContentMD5?: string } {
    return this.#o.md5 ? { ContentMD5: createHash('md5').update(body).digest('base64') } : {};
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
          ...(this.#o.checksums
            ? { ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64') }
            : {}),
          ...this.#md5(body),
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
            // With MD5 on, the part is read first so the bucket can check what it received.
            const held = this.#o.md5
              ? await buffer(createReadStream(file, { start, end: start + bytes - 1 }))
              : undefined;
            const out = await this.#call('part', key, ({ sdk, client }) =>
              client.send(
                new sdk.UploadPartCommand({
                  Bucket: this.bucket,
                  Key: key,
                  UploadId: uploadId,
                  PartNumber: part,
                  Body: held ?? createReadStream(file, { start, end: start + bytes - 1 }),
                  ContentLength: bytes,
                  ...(held ? this.#md5(held) : {}),
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
    const hash = createHash('sha256');
    const flush = async () => {
      const body = Buffer.concat(held);
      held = [];
      bytes = 0;
      hash.update(body);
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
            ...this.#md5(body),
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
      const head = await this.multipartComplete(key, uploadId, parts);
      // Its hash was not known when its first part went up: kept in the records instead.
      const sha256 = hash.digest('hex');
      if (head.etag) await this.#note(key, { sha256, etag: head.etag });
      return { ...head, sha256, ...(type ? { type } : {}) };
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
    // The records are asked only for what the bucket does not say: a media file's holders, and
    // the hash of a blob that could not carry its own.
    if (!this.#owned(key)?.media && head.sha256) return head;
    const record = await this.#record(key);
    if (!record) return head;
    return {
      ...head,
      refs: Math.max(1, record.refs ?? 1),
      ...(!head.sha256 && record.sha256 && record.etag === head.etag
        ? { sha256: record.sha256 }
        : {}),
    };
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

  async #listed(prefix: string): Promise<Listed[]> {
    const found: Listed[] = [];
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
    const whole = this.#scope(prefix).owner;
    if (whole) return this.forget(whole);
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
    const found: Listed[] = [];
    for (const folder of this.#scope(prefix).folders) {
      found.push(...this.#shown(await this.#listed(folder)));
    }
    found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
    if (!head) throw errno('ENOENT', `No blob ${shown(from)}`);
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
    if (!(await this.stat(from))) throw errno('ENOENT', `No blob ${shown(from)}`);
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
      if (record.refs <= 0) throw errno('ENOENT', `No blob ${shown(from)}`);
      if (await kept.compareAndSet(id, { refs: record.refs }, { refs: record.refs + 1 })) break;
    }
    // Gone in between (deleted by a holder with no record yet): this holder holds nothing.
    if (!(await this.stat(from))) {
      await kept.delete(id);
      throw errno('ENOENT', `No blob ${shown(from)}`);
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
    if (!head) throw errno('ENOENT', `No blob ${shown(from)}`);
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
        if (status(error) === 409 && (await this.stat(to)))
          throw errno('EEXIST', `Taken: ${shown(to)}`);
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
      // (A claim being written this instant may not read yet: it is as good as held.)
      const stale = await kept.get(claim).catch(() => undefined);
      const age = stale?.used_at ? Date.now() - Date.parse(stale.used_at) : 0;
      if (stale && age > 60_000 && turn < 2) {
        await kept.delete(claim);
        continue;
      }
      throw errno('EEXIST', `A blob is already at ${shown(to)}`);
    }
    try {
      if (await this.stat(to)) throw errno('EEXIST', `A blob is already at ${shown(to)}`);
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
   * Says when a blob, or a folder of them, was last used: for data brought from another store
   * with its age (a kept frame set that is days old must not start its days again). It holds
   * until something under it is written or touched again.
   */
  async setTime(keyOrPrefix: BlobKey, at: Date): Promise<void> {
    const name = keyOrPrefix.replace(/\/+$/, '');
    if (this.#isLocal(name) || !this.#owned(name)) return;
    await this.#note(name, { used_at: at.toISOString() });
  }

  /** When a blob, or a folder of them, was last used, as `expire` reads it. Undefined: nothing there. */
  async getTime(keyOrPrefix: BlobKey): Promise<Date | undefined> {
    const name = keyOrPrefix.replace(/\/+$/, '');
    if (this.#isLocal(name)) return (await this.#local.head(name))?.modifiedAt;
    let newest = (await this.stat(name))?.modifiedAt.getTime() ?? 0;
    for (const o of await this.#listed(`${name}/`))
      newest = Math.max(newest, o.modifiedAt.getTime());
    const owned = this.#owned(name);
    const touched = owned
      ? (await this.#kept(owned.owner).find({ key: name })).find((r) => r.value.used_at)
      : undefined;
    if (touched?.value.used_at && touched.usedAt.getTime() + 1000 >= newest) {
      return new Date(touched.value.used_at);
    }
    return newest ? new Date(newest) : undefined;
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

  /** Every object under the owner's prefixes but working copies, each once however many hold it. */
  async usage(owner: string): Promise<number> {
    let total = 0;
    for (const prefix of this.#prefixes(owner)) {
      for (const o of this.#shown(await this.#listed(prefix))) {
        if (!workingCopy(o.key)) total += o.bytes;
      }
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
    for (const upload of await this.openUploads(media)) {
      await this.multipartAbort(upload.key, upload.uploadId);
    }
    await this.#kept(ownerKey(owner)).clear();
  }

  /** Every upload in parts not yet completed or aborted under `prefix`, page by page. */
  async openUploads(prefix: string): Promise<Array<{ key: BlobKey; uploadId: string }>> {
    const found: Array<{ key: BlobKey; uploadId: string }> = [];
    let keyMarker: string | undefined;
    let idMarker: string | undefined;
    for (;;) {
      const page = await this.#call('uploads', prefix, ({ sdk, client }) =>
        client.send(
          new sdk.ListMultipartUploadsCommand({
            Bucket: this.bucket,
            Prefix: prefix,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(idMarker ? { UploadIdMarker: idMarker } : {}),
          }),
        ),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key && upload.UploadId)
          found.push({ key: upload.Key, uploadId: upload.UploadId });
      }
      if (!page.IsTruncated) return found;
      // A page that names no next place would ask for itself again: stop there.
      if (!page.NextKeyMarker && !page.NextUploadIdMarker) return found;
      keyMarker = page.NextKeyMarker;
      idMarker = page.NextUploadIdMarker;
    }
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
    const etag = await this.#part(key, uploadId, part, sent, length, sent === body);
    return { part, bytes: length, etag };
  }

  async #part(
    key: BlobKey,
    uploadId: string,
    part: number,
    body: Readable | Buffer,
    bytes: number,
    /** Its bytes come at the sender's pace (streamed from a client). */
    paced = false,
  ): Promise<string> {
    if (part < 1 || part > S3_MAX_PARTS) {
      throw new CfError('limit_exceeded', `An upload takes up to ${S3_MAX_PARTS} parts`, {
        hint: 'Send the file in larger parts',
      });
    }
    const out = await this.#call(
      'part',
      key,
      ({ sdk, client }) =>
        client.send(
          new sdk.UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: part,
            Body: body,
            ContentLength: bytes,
            ...(Buffer.isBuffer(body) ? this.#md5(body) : {}),
          }),
        ),
      paced ? key : undefined,
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
    /** Set while the store is being written to: a failure then is the store's, not the sender's. */
    let storing = false;
    const flush = async (bytes: Buffer) => {
      storing = true;
      const etag = await this.#part(key, uploadId, next, bytes, bytes.length);
      parts.push([next, etag, bytes.length]);
      next += 1;
      storing = false;
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
      // A failure of the store is the caller's to hear, and nothing of this part is kept; a
      // sender that broke off keeps what arrived.
      if (storing) throw error;
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

  async multipartRewind(
    key: BlobKey,
    uploadId: string,
    after: BlobPart | undefined,
  ): Promise<{ part: BlobPart | null; bytes: number }> {
    const state: UploadSoFar = after
      ? await this.#state(key, after.part, after)
      : { next: 1, parts: [], tail: Buffer.alloc(0) };
    const held = new Map((await this.multipartParts(key, uploadId)).map((p) => [p.part, p]));
    const good: Array<[number, string, number]> = [];
    for (const [n, etag, bytes] of state.parts) {
      const there = held.get(n);
      if (!there || there.etag !== etag || there.bytes !== bytes || n !== good.length + 1) break;
      good.push([n, etag, bytes]);
    }
    if (!good.length) return { part: null, bytes: 0 };
    // A state newer than any so far, holding that run and nothing left over.
    const call = (after?.part ?? 0) + 1;
    const at = this.#stateKey(key, call, randomBytes(6).toString('hex'));
    const body = Buffer.from(`${JSON.stringify({ next: good.length + 1, parts: good })}\n`);
    await this.#call('part', key, ({ sdk, client }) =>
      client.send(
        new sdk.PutObjectCommand({
          Bucket: this.bucket,
          Key: at,
          Body: body,
          ContentLength: body.length,
        }),
      ),
    );
    const bytes = good.reduce((sum, [, , b]) => sum + b, 0);
    return { part: { part: call, bytes: 0, etag: `${IN_ORDER}${at}` }, bytes };
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
   * Closes what a crash between the bucket and the records leaves, for one owner. `holders`
   * reads how many of the owner's media and unimported uploads name each media file, and the
   * media ids that have a record; it is read again before anything is deleted, and nothing
   * held then goes. Nothing is judged by a time newer than `graceMs` ago.
   *
   * - a record saying its file is going (refs 0), or a file no one holds that has a record:
   *   the file and the record go, once the later of the file's date and the record's times is
   *   past the grace;
   * - a record whose file is gone: the record goes;
   * - a holder count that is not the number of holders: set to it (also for a file two media
   *   name that has no count at all);
   * - a file no media or upload names and no record: marked with a record the first time it is
   *   met, and goes by the rule above no sooner than the grace after that, so a file's own date
   *   (which may be when its upload began) never decides alone;
   * - derived files of a media that has no record: deleted.
   */
  async orphans(
    owner: string,
    holders: () => Promise<{ held: Map<BlobKey, number>; media: Set<string> }>,
    graceMs: number,
  ): Promise<OrphanReport> {
    const key = ownerKey(owner);
    const report: OrphanReport = { records: 0, objects: 0, refs: 0, marked: 0 };
    const now = Date.now();
    const old = (at: number) => at < now - graceMs;
    const kept = this.#kept(key);
    const first = await holders();
    const mediaPrefix = `media/${key}/`;
    const objects = new Map((await this.#listed(mediaPrefix)).map((o) => [o.key, o]));
    const found = await kept.find();
    const recorded = new Set(found.map((r) => r.value.key));
    /** Files to delete once the holders are read again, with their records. */
    const doomed: Array<{ key: BlobKey; record?: string }> = [];
    for (const { id, value, usedAt } of found) {
      if (!old(usedAt.getTime())) continue;
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
      const holding = first.held.get(value.key) ?? 0;
      if (!object) {
        await kept.delete(id);
        report.records += 1;
      } else if ((value.refs ?? 1) <= 0 || holding === 0) {
        const used = Math.max(
          object.modifiedAt.getTime(),
          usedAt.getTime(),
          value.used_at ? Date.parse(value.used_at) || 0 : 0,
        );
        if (old(used)) doomed.push({ key: value.key, record: id });
      } else if (value.refs === undefined) {
        await kept.update(id, { set: { refs: holding } });
        report.refs += 1;
      } else if (value.refs !== holding) {
        if (await kept.compareAndSet(id, { refs: value.refs }, { refs: holding })) report.refs += 1;
      }
    }
    for (const object of objects.values()) {
      if (recorded.has(object.key)) continue;
      const id = this.#id(object.key);
      const holding = first.held.get(object.key) ?? 0;
      if (holding > 1) {
        // Named by more than one media and counted nowhere: count them, so deleting one of
        // them leaves the file for the others.
        if (await kept.insertOnce(id, { key: object.key, refs: holding })) report.refs += 1;
        continue;
      }
      if (holding > 0 || !old(object.modifiedAt.getTime())) continue;
      // The state of an upload still being sent is held by the upload, as long as one lasts.
      const upload = object.key.indexOf(PARTS_SUFFIX);
      if (upload > 0) {
        if (first.held.has(object.key.slice(0, upload))) continue;
        if (object.modifiedAt.getTime() > now - Math.max(graceMs, 8 * 86_400_000)) continue;
        doomed.push({ key: object.key });
        continue;
      }
      // First met with nothing naming it: marked now, judged a grace later.
      if (await kept.insertOnce(id, { key: object.key, orphan_at: new Date(now).toISOString() })) {
        report.marked = (report.marked ?? 0) + 1;
      }
    }
    const derivedPrefix = `derived/${key}/`;
    const stale = new Map<string, boolean>();
    for (const o of await this.#listed(derivedPrefix)) {
      const id = o.key.slice(derivedPrefix.length).split('/')[0] as string;
      if (first.media.has(id)) continue;
      stale.set(id, (stale.get(id) ?? true) && old(o.modifiedAt.getTime()));
    }
    const gone = [...stale].filter(([, all]) => all).map(([id]) => id);
    if (!doomed.length && !gone.length) return report;
    // Read again: what an import or upload made meanwhile holds is never deleted.
    const again = await holders();
    for (const { key: file, record } of doomed) {
      if (again.held.has(file) || first.held.has(file)) continue;
      if (file.includes(PARTS_SUFFIX) && again.held.has(file.slice(0, file.indexOf(PARTS_SUFFIX))))
        continue;
      await this.#remove(file);
      report.objects += 1;
      if (record) {
        await kept.delete(record);
        report.records += 1;
      }
    }
    for (const id of gone) {
      if (again.media.has(id)) continue;
      const under = await this.#listed(`${derivedPrefix}${id}/`);
      await each(under, 16, (o) => this.#remove(o.key));
      report.objects += under.length;
    }
    return report;
  }
}

async function buffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
