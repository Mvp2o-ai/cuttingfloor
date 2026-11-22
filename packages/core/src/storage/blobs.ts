import type { Readable } from 'node:stream';

/**
 * A file's name in the blob store. Opaque: made by `BlobStore.keys`, or returned by the store,
 * and kept in records as given. Never a local path, never a content hash. Relative, with `/`
 * between its parts, and never starting with `/` (so a record can tell it from a local path).
 */
export type BlobKey = string;

/** What the store knows about one blob without reading it. */
export interface BlobHead {
  key: BlobKey;
  bytes: number;
  /** When its bytes were last written. */
  modifiedAt: Date;
  /**
   * How many holders share these bytes (`share`). Counted once against an owner's storage, and
   * the bytes go only when the last holder deletes its key.
   */
  refs: number;
  /** The bytes' SHA-256, where the store keeps it (the filesystem store does not). */
  sha256?: string;
  /** The content type it was stored with, where the store keeps it. */
  type?: string;
  /**
   * The store's own tag of the bytes as written, where it has one (an object store's ETag). It
   * changes when the blob is written again; it is not a hash to compare content by.
   */
  etag?: string;
}

/** What an orphan sweep put right (see `BlobStore.orphans`). */
export interface OrphanReport {
  /** Records removed: their blob had gone. */
  records: number;
  /** Blobs removed: nothing held them. */
  objects: number;
  /** Holder counts corrected. */
  refs: number;
}

/** Bytes to store: a local file, a stream, or bytes in memory. */
export type BlobSource =
  | {
      file: string;
      /** The local file may be taken (renamed into the store) instead of copied. */
      move?: boolean;
    }
  | { stream: Readable }
  | { bytes: Uint8Array };

export interface PresignOptions {
  /** How long the link works. */
  ttlMs: number;
  /** The Content-Disposition a download answers with. */
  disposition?: string;
  /** The Content-Type a download answers with. */
  type?: string;
}

export interface BlobPart {
  /** 1-based, in order. */
  part: number;
  etag: string;
  bytes: number;
}

/**
 * Where each kind of file is kept. Callers never build a key themselves, so a store is free to
 * lay files out its own way (the filesystem store: today's folders under the data root).
 * `owner` is an owner or an owner key (`ownerKey` leaves a key as it is).
 */
export interface BlobKeys {
  /** A media's own file: its source, mezzanine or proxy. `name` carries the extension. */
  media(owner: string, mediaId: string, name: string): BlobKey;
  /** A file made from a media and found again by name: cleaned sound, in-betweens, an index. */
  derived(owner: string, mediaId: string, ...name: string[]): BlobKey;
  /** A file of a job's output or a kept frame set; `name` empty for the prefix of them all. */
  output(owner: string, id: string, name: string): BlobKey;
  /** The prefix of every output an owner has, one entry per job or frame set. */
  outputs(owner: string): BlobKey;
  /** The bytes of an upload not imported yet; `name` empty for the upload's prefix. */
  upload(owner: string, uploadId: string, name: string): BlobKey;
  /** The prefix of every upload an owner has, one entry per upload. */
  uploads(owner: string): BlobKey;
  /** The prefix of every blob an owner has. */
  owner(owner: string): BlobKey;
  /** Derived and disposable: kept on this node only, rebuilt when missing. */
  cache(...name: string[]): BlobKey;
}

/**
 * Every file the server keeps: media sources, mezzanines, proxies, derived files, uploads and
 * outputs. Engines never read a blob through this interface; they take local paths from
 * `Scratch`.
 */
export interface BlobStore {
  readonly keys: BlobKeys;
  /**
   * True where blobs are not files on this node (an object store): a blob is read through
   * `Scratch`'s copy of it, clients download from the store's own links (`presignGet`), and
   * shared bytes are counted by holder.
   */
  readonly remote: boolean;

  /** Checks the store can be used as configured, and rejects in plain words when it cannot. */
  ready(): Promise<void>;
  /** Lets go of connections. The store is not used after it. */
  close(): Promise<void>;

  /**
   * Stores bytes under `key`, replacing what was there. `private` keeps them from other users
   * of the machine where the store is one's files (an upload's bytes). `durable` has the bytes
   * safely stored before this answers, for a small file whose loss a crash must not cause (the
   * filesystem store syncs it; a store that always answers after storing has nothing to add).
   */
  put(
    key: BlobKey,
    from: BlobSource,
    options?: { type?: string; private?: boolean; durable?: boolean },
  ): Promise<BlobHead>;
  /** The blob's bytes. Rejects with ENOENT (`isMissing`) when there is none. */
  get(key: BlobKey): Promise<Readable>;
  /** Bytes `start` to `end`, both inclusive, as an HTTP range; `end` omitted reads to the end. */
  getRange(key: BlobKey, start: number, end?: number): Promise<Readable>;
  head(key: BlobKey): Promise<BlobHead | undefined>;
  /** Removes one blob. A missing one is not an error. Shared bytes stay for their other holders. */
  delete(key: BlobKey): Promise<void>;
  /** Removes every blob whose key starts with `prefix` (a folder of them). */
  deletePrefix(prefix: BlobKey): Promise<void>;
  /** Every blob whose key starts with `prefix`, by key. */
  list(prefix: BlobKey): Promise<BlobHead[]>;
  /** A second, independent copy of the bytes under `to`. */
  copy(from: BlobKey, to: BlobKey): Promise<BlobHead>;
  /**
   * The same bytes for a second holder without storing them twice (dedupe). Returns the key the
   * new holder keeps and later deletes: `to` where the store can name shared bytes twice (the
   * filesystem's hard links), `from` where it counts holders instead.
   */
  share(from: BlobKey, to: BlobKey): Promise<BlobKey>;
  /**
   * Hands a blob over to a new holder. Returns the key that holds the bytes afterwards: `to`
   * where the store renames, `from` where a blob never moves (an upload's object becomes the
   * media's source as it is). With `ifAbsent` the blob takes `to` only when nothing is there:
   * of several at once exactly one does, and the others reject with EEXIST (`isExisting`),
   * their `from` left as it was (the filesystem links; an object store puts with
   * `If-None-Match: *`).
   */
  move(from: BlobKey, to: BlobKey, options?: { ifAbsent?: boolean }): Promise<BlobKey>;
  /** Marks a blob, or everything under a prefix, as used now (sliding expiry). */
  touch(key: BlobKey): Promise<void>;
  /**
   * Removes what sits directly under `prefix` (a blob, or a folder of them) and was last
   * written or touched more than `ttlMs` ago. `keep` spares names. Returns the names removed.
   */
  expire(prefix: BlobKey, ttlMs: number, keep?: (name: string) => boolean): Promise<string[]>;
  /** Bytes an owner keeps, shared bytes once. */
  usage(owner: string): Promise<number>;
  /** Removes every blob an owner has, whoever holds it (the account is deleted). */
  forget(owner: string): Promise<void>;
  /**
   * Where what holds a blob is counted apart from the blob (an object store): puts right what a
   * crash between the two left, for one owner. `held` counts the owner's media and unimported
   * uploads naming each media file, `media` is the ids that still have a record, and nothing
   * newer than `graceMs` is judged. Absent where a blob and its holders cannot disagree.
   */
  orphans?(
    owner: string,
    holders: { held: Map<BlobKey, number>; media: Set<string> },
    graceMs: number,
  ): Promise<OrphanReport>;
  /** Bytes under `prefix` that deleting it would free (shared bytes held elsewhere don't count). */
  freeable(prefix: BlobKey): Promise<number>;

  /**
   * A link a client downloads the blob from directly, or undefined where clients reach blobs
   * only through the server's own signed links (the filesystem store, unless given a signer).
   */
  presignGet(key: BlobKey, options: PresignOptions): Promise<string | undefined>;

  /**
   * Starts an upload sent in parts; returns its id. The parts stored are the caller's to remember
   * (the upload's record), as is how many bytes have landed.
   */
  multipartStart(key: BlobKey, options?: { type?: string }): Promise<string>;
  /**
   * Stores one part. Parts are numbered from 1 and sent in order, each of any size: a part
   * continues the blob where the last one ended. `bytes` is the body's length when the caller
   * knows it. `after` is the part before this one as the store returned it, for a caller that
   * keeps it (two senders racing for one part then cannot take each other's). A body that
   * breaks part way may reject with `landed`, the part as far as it was stored.
   *
   * With `anyOrder` the caller cuts the blob into parts of one fixed size itself and sends them
   * in any order, several at once; every part but the last must then be at least 5 MiB. Only an
   * object store takes these, and an upload is sent one way or the other, never both.
   */
  multipartPart(
    key: BlobKey,
    uploadId: string,
    part: number,
    body: Readable,
    options?: { bytes?: number; after?: BlobPart; anyOrder?: boolean },
  ): Promise<BlobPart>;
  /** Makes the parts the blob. */
  multipartComplete(key: BlobKey, uploadId: string, parts: BlobPart[]): Promise<BlobHead>;
  /** Drops the upload and its parts. */
  multipartAbort(key: BlobKey, uploadId: string): Promise<void>;
}
