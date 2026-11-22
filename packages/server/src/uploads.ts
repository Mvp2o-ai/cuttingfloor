import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import {
  type BlobKey,
  type BlobPart,
  type Collection,
  defineCollection,
  floorChanged,
  ownerKey,
  randomId,
  type Workspace,
} from '@cuttingfloor/core';
import { readableSize } from '@cuttingfloor/engine';
import { CfError, KEEP_MS, span } from '@cuttingfloor/schema';

/** How long an upload URL works, and how long an unimported upload is kept. */
export const UPLOAD_TTL_MS = KEEP_MS.upload;

interface UploadMeta {
  upload_id: string;
  name: string;
  /** The name of the upload's blob, which carries the file's extension for probing. */
  file: string;
  bytes: number | null;
  complete: boolean;
  created_at: string;
  /** The most this upload takes, when the account's storage left is less than `maxBytes`. */
  max_bytes?: number;
  /** How it was sent: a media.upload link, the account page, or a data: URI. */
  via?: UploadVia;

  // Where files are in an object store, the upload's own state: the store's upload in parts
  // fills the blob, and this record says how far it has got, for whichever server is asked next.
  /** The store's id of the upload in parts filling the blob; '' before the first byte. */
  mpu?: string;
  /** Bytes received in order (PUT, whole or with Content-Range). */
  offset?: number;
  /** The latest in-order part as the store returned it: it names everything stored so far. */
  part?: BlobPart | null;
  /** The request taking in-order bytes now ('' for none), and when it last said it still is. */
  lock?: string;
  lock_at?: number;
  /** Sent as numbered parts of one size instead: that size, the file's size, the parts in. */
  part_bytes?: number;
  parts?: BlobPart[];
  /** Counts writes of `parts`, so two parts landing at once both stay. */
  rev?: number;
}

/** A request that stops saying it is still sending for this long has let go of its upload. */
const LOCK_STALE_MS = 90_000;
const MIB = 1024 ** 2;

/** The size of each numbered part of a file sent in parts: more for a bigger file. */
export function uploadPartBytes(total: number): number {
  const base = total <= 1024 ** 3 ? 16 * MIB : total <= 8 * 1024 ** 3 ? 32 * MIB : 64 * MIB;
  return Math.max(base, Math.ceil(total / 10_000 / MIB) * MIB);
}

/** How a file being sent as numbered parts stands. */
export interface UploadParts {
  upload_id: string;
  part_bytes: number;
  total_bytes: number;
  /** The parts that are in, by number. */
  parts: Array<{ part: number; bytes: number }>;
  received: number;
  complete: boolean;
}

export type UploadVia = 'media.upload' | 'account_page' | 'data_uri';

/** An upload's record: `owners/{owner}/uploads/{upload_id}/upload.json` on the filesystem. */
export const UPLOADS = defineCollection<UploadMeta>({
  name: 'uploads',
  scope: 'owner',
  fs: { dir: 'uploads', leaf: 'upload.json' },
});

export interface UploadState {
  upload_id: string;
  received: number;
  complete: boolean;
}

/** Thrown by `receive` for a request the upload can't take; the HTTP face sends `status`. */
export class UploadRefused extends Error {
  readonly status: number;
  readonly received: number | undefined;
  /** Whether the upload is already complete (a PUT to one that is). */
  readonly complete: boolean;
  constructor(status: number, message: string, received?: number, complete = false) {
    super(message);
    this.status = status;
    this.received = received;
    this.complete = complete;
  }
}

/**
 * Files sent to the server, ahead of media.import. Each upload is a folder under the owner's
 * `uploads/` with its record and its bytes, reached by a signed URL that names the owner and
 * the upload: no other credentials, so any HTTP client can send it. A PUT sends the whole file,
 * or one part with `Content-Range` so a broken upload resumes where it stopped. Unimported
 * uploads go after `KEEP_MS.upload`; an import moves the file into the media.
 */
export class Uploads {
  readonly #ws: Workspace;
  readonly #secret: () => Promise<Buffer>;
  readonly #publicUrl: () => string;
  readonly maxBytes: number;
  readonly #uploadPage: string | undefined;
  /** Uploads taking a request on this server, so two never write one file at once. */
  readonly #busy = new Set<string>();

  /** Files are in an object store: an upload's state is its record, not a file's size. */
  get #remote(): boolean {
    return this.#ws.blobs.remote;
  }

  constructor(
    ws: Workspace,
    options: {
      secret: () => Promise<Buffer>;
      publicUrl: () => string;
      maxBytes: number;
      /** Hosted: the account page's file drop, offered when an upload has gone. */
      uploadPage?: string;
    },
  ) {
    this.#ws = ws;
    this.#uploadPage = options.uploadPage;
    this.#secret = options.secret;
    this.#publicUrl = options.publicUrl;
    this.maxBytes = options.maxBytes;
  }

  /**
   * Starts an upload: its record, and the signed URL to PUT the file to. `room` is the account's
   * storage left, when it has a cap; the upload takes no more than that.
   */
  async create(
    owner: string,
    name: string,
    bytes: number | undefined,
    room?: number,
    via: UploadVia = 'media.upload',
  ): Promise<{ upload_id: string; url: string; expires_at: string; max_bytes: number }> {
    return this.#create(owner, name, bytes, room, via);
  }

  async #create(
    owner: string,
    name: string,
    bytes: number | undefined,
    room: number | undefined,
    via: UploadVia,
  ): Promise<{ upload_id: string; url: string; expires_at: string; max_bytes: number }> {
    if (bytes !== undefined && bytes > this.maxBytes) {
      throw new CfError(
        'bad_request',
        `${name} is ${readableSize(bytes)}; uploads take up to ${readableSize(this.maxBytes)}`,
        {
          hint: 'Export a smaller file (lower bitrate or shorter), or import it from a URL',
        },
      );
    }
    const id = randomId('u_');
    const ext = extname(name)
      .slice(0, 8)
      .replace(/[^.\w]/g, '');
    const meta: UploadMeta = {
      upload_id: id,
      name,
      file: `data${ext}`,
      bytes: bytes ?? null,
      complete: false,
      created_at: new Date().toISOString(),
      ...(room !== undefined && room < this.maxBytes ? { max_bytes: room } : {}),
      via,
      ...(this.#remote ? { mpu: '', offset: 0, part: null, lock: '', lock_at: 0, rev: 0 } : {}),
    };
    await this.#records(owner).put(id, meta);
    await floorChanged(this.#ws, owner);
    const exp = Date.now() + UPLOAD_TTL_MS;
    const path = `/uploads/${ownerKey(owner)}/${id}`;
    return {
      upload_id: id,
      url: `${this.#publicUrl()}${path}?exp=${exp}&sig=${await this.#sign(path, exp)}`,
      expires_at: new Date(exp).toISOString(),
      max_bytes: meta.max_bytes ?? this.maxBytes,
    };
  }

  /**
   * The signed URL of an unfinished upload again, so a sender that lost it (a phone that closed
   * the page) carries on from the bytes already here. It ends when the upload does.
   */
  async resume(
    owner: string,
    uploadId: string,
  ): Promise<{ upload_id: string; url: string; expires_at: string; max_bytes: number }> {
    const key = ownerKey(owner);
    const meta = /^u_[0-9a-z]{26}$/.test(uploadId) ? await this.#meta(key, uploadId) : undefined;
    const exp = meta ? Date.parse(meta.created_at) + UPLOAD_TTL_MS : 0;
    if (!meta || exp <= Date.now())
      throw new CfError('not_found', `No upload ${uploadId}`, {
        hint: 'It has expired or was never started; send the file again',
      });
    if (meta.complete)
      throw new CfError('bad_request', `${meta.name} is already sent`, {
        hint: 'It waits for the agent to import it',
      });
    const path = `/uploads/${key}/${uploadId}`;
    return {
      upload_id: uploadId,
      url: `${this.#publicUrl()}${path}?exp=${exp}&sig=${await this.#sign(path, exp)}`,
      expires_at: new Date(exp).toISOString(),
      max_bytes: meta.max_bytes ?? this.maxBytes,
    };
  }

  /** An upload whose bytes are already here (a data: URI), complete at once. */
  async put(owner: string, name: string, bytes: Buffer): Promise<string> {
    const { upload_id } = await this.create(owner, name, bytes.length, undefined, 'data_uri');
    const key = ownerKey(owner);
    const meta = await this.#meta(key, upload_id);
    if (!meta) throw new CfError('engine_error', `Upload ${upload_id} vanished`);
    await this.#ws.blobs.put(this.#blob(key, meta), { bytes }, { private: true });
    await this.#records(key).put(upload_id, { ...meta, bytes: bytes.length, complete: true });
    await floorChanged(this.#ws, owner);
    return upload_id;
  }

  /** The upload a signed URL names, or undefined when the URL is invalid or expired. */
  async verify(
    pathname: string,
    exp: string | null,
    sig: string | null,
  ): Promise<{ owner: string; id: string } | undefined> {
    const m = /^\/uploads\/([A-Za-z0-9_-]{1,64})\/(u_[0-9a-z]{26})$/.exec(pathname);
    if (!m || !exp || !sig || !(Number(exp) > Date.now())) return undefined;
    const expected = Buffer.from(await this.#sign(pathname, Number(exp)), 'base64url');
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return { owner: m[1] ?? '', id: m[2] ?? '' };
  }

  /** How much of an upload has arrived (`owner` is the key in the URL). */
  async state(owner: string, id: string): Promise<UploadState | undefined> {
    const meta = await this.#meta(owner, id);
    if (!meta) return undefined;
    return { upload_id: id, received: await this.#size(owner, meta), complete: meta.complete };
  }

  /**
   * Takes one PUT. Without `range` the body is the whole file and replaces anything sent before;
   * with it, the body is the part starting at `range.start`, which must be where the upload
   * stands. The upload is complete when the bytes reach the total the request gives (the
   * range's total, or the Content-Length of a whole-file PUT).
   */
  async receive(
    owner: string,
    id: string,
    body: Readable,
    request: {
      length: number | null;
      range: { start: number; total: number | null } | null;
      /** The sent file's own name (the upload page gives it), recorded over the one given. */
      name?: string;
    },
  ): Promise<UploadState> {
    if (this.#remote) return this.#receiveRemote(owner, id, body, request);
    let meta = await this.#meta(owner, id);
    if (!meta) throw new UploadRefused(404, 'no such upload, or it expired');
    if (meta.complete) {
      throw new UploadRefused(
        409,
        'this upload is complete; import it',
        await this.#size(owner, meta),
        true,
      );
    }
    const key = `${owner}/${id}`;
    if (this.#busy.has(key)) throw new UploadRefused(409, 'another request is sending this upload');
    this.#busy.add(key);
    try {
      const received = await this.#size(owner, meta);
      const start = request.range?.start ?? 0;
      if (request.range && start !== received) {
        throw new UploadRefused(409, `the upload has ${received} bytes; send from there`, received);
      }
      const named = request.name?.trim().slice(0, 200);
      if (named && !/[/\\]/.test(named) && named !== meta.name) {
        // Before any byte lands, the file also takes the sent name's extension.
        const ext = extname(named)
          .slice(0, 8)
          .replace(/[^.\w]/g, '');
        meta = { ...meta, name: named, ...(received === 0 ? { file: `data${ext}` } : {}) };
        await this.#records(owner).put(id, meta);
      }
      const total = request.range ? request.range.total : request.length;
      const limit = meta.max_bytes ?? this.maxBytes;
      const tooBig =
        meta.max_bytes === undefined
          ? `This file is too big: uploads take up to ${readableSize(limit)}`
          : `This file is too big: the account's storage has room for ${readableSize(limit)} more. Older files expire on their own, or ask in the chat to delete some`;
      if ((total ?? 0) > limit || start + (request.length ?? 0) > limit) {
        throw new UploadRefused(413, tooBig, received);
      }
      const blob = this.#blob(owner, meta);
      let size = start;
      const counted = async function* (source: Readable) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > limit) throw new UploadRefused(413, tooBig);
          yield chunk;
        }
      };
      try {
        const { blobs } = this.#ws;
        // A part continues the blob where it stands; a whole file replaces it. The filesystem
        // store appends in place, so what has landed is the blob's size.
        if (request.range) {
          await blobs.multipartPart(
            blob,
            await blobs.multipartStart(blob),
            1,
            Readable.from(counted(body)),
          );
        } else await blobs.put(blob, { stream: Readable.from(counted(body)) });
      } catch (error) {
        if (error instanceof UploadRefused) throw error;
        // A broken connection keeps what arrived, for the client to resume from.
        throw new UploadRefused(
          400,
          'the upload stopped part way; resume it',
          await this.#size(owner, meta),
        );
      }
      // A whole-file PUT sent without a length ends when its body does.
      const complete = request.range || total !== null ? size === total : true;
      if (complete) {
        await this.#records(owner).put(id, { ...meta, bytes: size, complete: true });
        await floorChanged(this.#ws, owner);
      }
      return { upload_id: id, received: size, complete };
    } finally {
      this.#busy.delete(key);
    }
  }

  /**
   * A complete upload's blob and name, for media.import; `file` is the blob as a local file on
   * this node, to read, where blobs are files here.
   */
  async take(
    owner: string,
    id: string,
  ): Promise<{ blob: BlobKey; file?: string; name: string; via?: UploadVia }> {
    const key = ownerKey(owner);
    const meta = await this.#meta(key, id);
    if (!meta) {
      throw new CfError('not_found', `Upload ${id} not found`, {
        hint: `A staged file goes ${span(KEEP_MS.upload)} after staging, and each imports once.${this.#uploadPage ? ` ${this.#uploadPage} stages files too.` : ''}`,
      });
    }
    if (!meta.complete) {
      const received = await this.#size(key, meta);
      throw new CfError(
        'media_not_ready',
        `Upload ${id} has ${received} bytes and isn't complete`,
        {
          hint: 'The file is still arriving',
        },
      );
    }
    const blob = this.#blob(key, meta);
    return {
      blob,
      // In an object store the blob is not fetched to be taken: the import reads it once.
      ...(this.#remote ? {} : { file: await this.#ws.scratch.materialize(blob) }),
      name: meta.name,
      ...(meta.via ? { via: meta.via } : {}),
    };
  }

  /** The owner's uploads not yet imported, newest first. */
  async list(owner: string): Promise<
    Array<{
      upload_id: string;
      name: string;
      received_bytes: number;
      bytes: number | null;
      complete: boolean;
      created_at: string;
      expires_at: string;
    }>
  > {
    const key = ownerKey(owner);
    const out = [];
    for (const id of await this.#records(key).ids()) {
      if (!/^u_[0-9a-z]{26}$/.test(id)) continue;
      const meta = await this.#meta(key, id);
      if (!meta) continue;
      const expires = Date.parse(meta.created_at) + UPLOAD_TTL_MS;
      if (expires <= Date.now()) continue;
      out.push({
        upload_id: id,
        name: meta.name,
        received_bytes: await this.#size(key, meta),
        bytes: meta.bytes,
        complete: meta.complete,
        created_at: meta.created_at,
        expires_at: new Date(expires).toISOString(),
      });
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Forgets an upload once imported. `taken`: its blob is now a media's own file where it is
   * (an object store never moves one), so only the record goes.
   */
  async remove(owner: string, id: string, options: { taken?: boolean } = {}): Promise<void> {
    const { blobs } = this.#ws;
    if (this.#remote) {
      const meta = await this.#meta(owner, id);
      if (meta?.mpu && !meta.complete) {
        await blobs.multipartAbort(this.#blob(owner, meta), meta.mpu).catch(() => undefined);
      }
    }
    if (!options.taken) await blobs.deletePrefix(blobs.keys.upload(owner, id, ''));
    await this.#records(owner).delete(id);
    await floorChanged(this.#ws, owner);
  }

  /** The blobs the owner's uploads hold (sent or still arriving), for the orphan sweep. */
  async held(owner: string): Promise<BlobKey[]> {
    const out: BlobKey[] = [];
    for (const { value } of await this.#records(owner).find()) out.push(this.#blob(owner, value));
    return out;
  }

  async sweep(): Promise<void> {
    const { records, blobs } = this.#ws;
    for (const owner of await records.owners()) {
      // An hour past the URL's life, so a PUT that was still running finishes first. An upload
      // goes whole, its record with its bytes, by when either was last written.
      const ttl = UPLOAD_TTL_MS + 3_600_000;
      if (this.#remote) {
        // The record is the upload's clock (every part received writes it); an imported
        // upload has no record, so a media's file that began as one is never met here.
        const found = await this.#records(owner)
          .find()
          .catch(() => []);
        for (const { id, usedAt } of found) {
          if (usedAt.getTime() >= Date.now() - ttl) continue;
          await this.remove(owner, id).catch(() => undefined);
        }
        continue;
      }
      const gone = await blobs.expire(blobs.keys.uploads(owner), ttl);
      // On the filesystem that was the record too. Kept apart from the bytes, a record goes
      // with them here, and one that never got a byte by its own age. One that can't be read
      // or removed is left for the next sweep: a sweep never stops at a bad entry.
      if (this.#ws.recordsWithFiles) continue;
      const uploads = this.#records(owner);
      for (const id of gone) await uploads.delete(id).catch(() => undefined);
      const kept = await uploads.find().catch(() => []);
      for (const { id, value, usedAt } of kept) {
        if (usedAt.getTime() >= Date.now() - ttl) continue;
        try {
          if (!(await blobs.head(this.#blob(owner, value)))) await uploads.delete(id);
        } catch {}
      }
    }
  }

  #records(owner: string): Collection<UploadMeta> {
    return this.#ws.records.collection(UPLOADS, { owner });
  }

  /** The key of the upload's bytes (`owner` is an owner or its key). */
  #blob(owner: string, meta: UploadMeta): BlobKey {
    return this.#ws.blobs.keys.upload(owner, meta.upload_id, meta.file);
  }

  async #meta(owner: string, id: string): Promise<UploadMeta | undefined> {
    return this.#records(owner).get(id);
  }

  async #size(owner: string, meta: UploadMeta): Promise<number> {
    if (this.#remote) {
      if (meta.complete) return meta.bytes ?? 0;
      if (meta.parts) return meta.parts.reduce((sum, p) => sum + p.bytes, 0);
      return meta.offset ?? 0;
    }
    return (await this.#ws.blobs.head(this.#blob(owner, meta)))?.bytes ?? 0;
  }

  /**
   * One PUT where files are in an object store. The same answers as on the filesystem, from the
   * record instead of a file: bytes go straight into the store's upload in parts (which keeps
   * what does not fill a part beside the blob), and the record moves on by compare-and-set, so
   * of two senders, or two servers, one takes each stretch and the other is told where the
   * upload stands.
   */
  async #receiveRemote(
    owner: string,
    id: string,
    body: Readable,
    request: {
      length: number | null;
      range: { start: number; total: number | null } | null;
      name?: string;
    },
  ): Promise<UploadState> {
    const { blobs } = this.#ws;
    const uploads = this.#records(owner);
    let meta = await this.#meta(owner, id);
    if (!meta) throw new UploadRefused(404, 'no such upload, or it expired');
    if (meta.complete) {
      throw new UploadRefused(409, 'this upload is complete; import it', meta.bytes ?? 0, true);
    }
    if (meta.parts) {
      throw new UploadRefused(
        409,
        'this upload is being sent in parts; send the rest of its parts',
        await this.#size(owner, meta),
      );
    }
    if (meta.lock === undefined || meta.offset === undefined) {
      // A record laid down without its state (by an older server): it starts from nothing.
      await uploads.update(id, {
        set: { mpu: meta.mpu ?? '', offset: meta.offset ?? 0, lock: '', lock_at: 0, rev: 0 },
      });
      meta = (await this.#meta(owner, id)) ?? meta;
    }
    const received = meta.offset ?? 0;
    const start = request.range?.start ?? 0;
    if (request.range && start !== received) {
      throw new UploadRefused(409, `the upload has ${received} bytes; send from there`, received);
    }
    const busy = () => new UploadRefused(409, 'another request is sending this upload');
    if (meta.lock && Date.now() - (meta.lock_at ?? 0) < LOCK_STALE_MS) throw busy();
    const token = randomBytes(9).toString('base64url');
    // Taken only from the state just read: another sender in between loses nothing.
    const mine = await uploads.compareAndSet(
      id,
      { lock: meta.lock ?? '', lock_at: meta.lock_at ?? 0, offset: received },
      { lock: token, lock_at: Date.now() },
    );
    if (!mine) throw busy();
    const beat = setInterval(
      () => void uploads.compareAndSet(id, { lock: token }, { lock_at: Date.now() }).catch(() => 0),
      20_000,
    );
    /** Lets go, moving the record on; false when another request took the upload over. */
    const settle = (set: Partial<UploadMeta>) =>
      uploads.compareAndSet(id, { lock: token }, { ...set, lock: '', lock_at: 0 });
    try {
      const named = request.name?.trim().slice(0, 200);
      if (named && !/[/\\]/.test(named) && named !== meta.name) {
        // Before any byte lands, the file also takes the sent name's extension.
        const ext = extname(named)
          .slice(0, 8)
          .replace(/[^.\w]/g, '');
        const renamed = { name: named, ...(received === 0 ? { file: `data${ext}` } : {}) };
        // A blob's key never changes once its upload in parts has begun.
        if (received === 0 && meta.mpu) {
          await blobs.multipartAbort(this.#blob(owner, meta), meta.mpu).catch(() => undefined);
          meta = { ...meta, mpu: '' };
          await uploads.compareAndSet(id, { lock: token }, { mpu: '' });
        }
        meta = { ...meta, ...renamed };
        await uploads.compareAndSet(id, { lock: token }, renamed);
      }
      const total = request.range ? request.range.total : request.length;
      const limit = meta.max_bytes ?? this.maxBytes;
      const tooBig =
        meta.max_bytes === undefined
          ? `This file is too big: uploads take up to ${readableSize(limit)}`
          : `This file is too big: the account's storage has room for ${readableSize(limit)} more. Older files expire on their own, or ask in the chat to delete some`;
      if ((total ?? 0) > limit || start + (request.length ?? 0) > limit) {
        throw new UploadRefused(413, tooBig, received);
      }
      const blob = this.#blob(owner, meta);
      // A whole file replaces anything sent before: its upload in parts starts again.
      let mpu = meta.mpu ?? '';
      let after = meta.part ?? undefined;
      if (!request.range && mpu) {
        await blobs.multipartAbort(blob, mpu).catch(() => undefined);
        mpu = '';
      }
      if (!request.range) after = undefined;
      let size = start;
      let refused: UploadRefused | undefined;
      const counted = async function* (source: Readable) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > limit) {
            refused = new UploadRefused(413, tooBig);
            throw refused;
          }
          yield chunk;
        }
      };
      let part: BlobPart | undefined;
      let broken = false;
      try {
        mpu ||= await blobs.multipartStart(blob);
        part = await blobs.multipartPart(
          blob,
          mpu,
          (after?.part ?? 0) + 1,
          Readable.from(counted(body)),
          {
            ...(request.length === null ? {} : { bytes: request.length }),
            ...(after ? { after } : {}),
          },
        );
      } catch (error) {
        if (refused) {
          await settle(request.range ? {} : { mpu, offset: 0, part: null });
          throw refused;
        }
        if (error instanceof UploadRefused) throw error;
        // A broken connection keeps what arrived, for the client to resume from.
        part = (error as { landed?: BlobPart }).landed;
        broken = true;
      }
      const landed = start + (part?.bytes ?? 0);
      if (broken) {
        const kept = part
          ? await settle({ mpu, part, offset: landed })
          : await settle(request.range ? { mpu } : { mpu, offset: 0, part: null });
        const now = kept
          ? part
            ? landed
            : request.range
              ? received
              : 0
          : await this.#offset(owner, id);
        throw new UploadRefused(400, 'the upload stopped part way; resume it', now);
      }
      // A whole-file PUT sent without a length ends when its body does.
      const complete = request.range || total !== null ? landed === total : true;
      if (complete) {
        await blobs.multipartComplete(blob, mpu, part ? [part] : []);
        const done = await settle({
          bytes: landed,
          complete: true,
          mpu: '',
          part: null,
          offset: landed,
        });
        if (!done) throw this.#overtaken(await this.#meta(owner, id));
        await floorChanged(this.#ws, owner);
      } else if (!(await settle({ mpu, part: part ?? null, offset: landed }))) {
        throw this.#overtaken(await this.#meta(owner, id));
      }
      return { upload_id: id, received: landed, complete };
    } catch (error) {
      // Whatever went wrong, this request no longer holds the upload.
      await uploads.compareAndSet(id, { lock: token }, { lock: '', lock_at: 0 }).catch(() => 0);
      throw error;
    } finally {
      clearInterval(beat);
    }
  }

  async #offset(owner: string, id: string): Promise<number> {
    const meta = await this.#meta(owner, id);
    return meta ? this.#size(owner, meta) : 0;
  }

  /** Another request took the upload over while this one was sending: where it stands now. */
  #overtaken(meta: UploadMeta | undefined): UploadRefused {
    if (!meta) return new UploadRefused(404, 'no such upload, or it expired');
    if (meta.complete) {
      return new UploadRefused(409, 'this upload is complete; import it', meta.bytes ?? 0, true);
    }
    const at = meta.offset ?? 0;
    return new UploadRefused(409, `the upload has ${at} bytes; send from there`, at);
  }

  /**
   * How a file being sent as numbered parts stands; with `total` (the file's size) it is set up
   * to be sent that way, the first time. Undefined where files are not in an object store: the
   * file is then sent with PUT.
   */
  async parts(
    owner: string,
    id: string,
    total?: number,
    name?: string,
  ): Promise<UploadParts | undefined> {
    if (!this.#remote) return undefined;
    const uploads = this.#records(owner);
    for (let turn = 0; turn < 5; turn += 1) {
      let meta = await this.#meta(owner, id);
      if (!meta) throw new UploadRefused(404, 'no such upload, or it expired');
      if (meta.parts && meta.part_bytes && meta.bytes !== null) {
        if (total !== undefined && total !== meta.bytes && !meta.complete) {
          throw new UploadRefused(
            409,
            `this upload is of a file of ${meta.bytes} bytes; start a new one for another file`,
          );
        }
        return this.#partsOf(meta);
      }
      if (meta.complete) {
        return {
          upload_id: id,
          part_bytes: meta.bytes ?? 0,
          total_bytes: meta.bytes ?? 0,
          parts: [],
          received: meta.bytes ?? 0,
          complete: true,
        };
      }
      if (total === undefined) {
        throw new UploadRefused(400, 'say the size of the file: GET …/parts?bytes=<size>');
      }
      if ((meta.offset ?? 0) > 0 || meta.lock) {
        throw new UploadRefused(
          409,
          `the upload has ${meta.offset ?? 0} bytes sent in order; send the rest with PUT and Content-Range`,
          meta.offset ?? 0,
        );
      }
      const limit = meta.max_bytes ?? this.maxBytes;
      if (total > limit) {
        throw new UploadRefused(
          413,
          meta.max_bytes === undefined
            ? `This file is too big: uploads take up to ${readableSize(limit)}`
            : `This file is too big: the account's storage has room for ${readableSize(limit)} more. Older files expire on their own, or ask in the chat to delete some`,
          0,
        );
      }
      const named = name?.trim().slice(0, 200);
      if (named && !/[/\\]/.test(named) && named !== meta.name) {
        const ext = extname(named)
          .slice(0, 8)
          .replace(/[^.\w]/g, '');
        meta = { ...meta, name: named, file: `data${ext}` };
      }
      const blob = this.#blob(owner, meta);
      const mpu = await this.#ws.blobs.multipartStart(blob);
      // One of several first requests sets it up; the others read what it set.
      const set = await uploads.compareAndSet(
        id,
        { rev: meta.rev ?? 0, offset: meta.offset ?? 0, lock: '' },
        {
          name: meta.name,
          file: meta.file,
          mpu,
          bytes: total,
          part_bytes: uploadPartBytes(total),
          parts: [],
          rev: (meta.rev ?? 0) + 1,
        },
      );
      if (!set) await this.#ws.blobs.multipartAbort(blob, mpu).catch(() => undefined);
    }
    throw new UploadRefused(409, 'another request is setting this upload up; ask again');
  }

  #partsOf(meta: UploadMeta): UploadParts {
    const parts = [...(meta.parts ?? [])].sort((a, b) => a.part - b.part);
    return {
      upload_id: meta.upload_id,
      part_bytes: meta.part_bytes ?? 0,
      total_bytes: meta.bytes ?? 0,
      parts: parts.map((p) => ({ part: p.part, bytes: p.bytes })),
      received: meta.complete ? (meta.bytes ?? 0) : parts.reduce((sum, p) => sum + p.bytes, 0),
      complete: meta.complete,
    };
  }

  /**
   * Takes one numbered part of a file set up with `parts`. Its body goes straight into the
   * store; sent again, a part replaces itself. Parts arrive in any order, several at once, on
   * any server.
   */
  async receivePart(
    owner: string,
    id: string,
    part: number,
    body: Readable,
    length: number | null,
  ): Promise<UploadParts> {
    const uploads = this.#records(owner);
    const meta = await this.#meta(owner, id);
    if (!this.#remote || !meta) throw new UploadRefused(404, 'no such upload, or it expired');
    if (meta.complete) {
      throw new UploadRefused(409, 'this upload is complete; import it', meta.bytes ?? 0, true);
    }
    if (!meta.parts || !meta.part_bytes || meta.bytes === null || !meta.mpu) {
      throw new UploadRefused(409, 'set the upload up first: GET …/parts?bytes=<size>');
    }
    const count = Math.max(1, Math.ceil(meta.bytes / meta.part_bytes));
    const expected = part === count ? meta.bytes - (count - 1) * meta.part_bytes : meta.part_bytes;
    if (!Number.isInteger(part) || part < 1 || part > count) {
      throw new UploadRefused(400, `this file has parts 1 to ${count}`);
    }
    if (length !== expected) {
      throw new UploadRefused(
        400,
        `part ${part} is ${expected} bytes; send it with that Content-Length`,
      );
    }
    let stored: BlobPart;
    try {
      stored = await this.#ws.blobs.multipartPart(this.#blob(owner, meta), meta.mpu, part, body, {
        bytes: expected,
        anyOrder: true,
      });
    } catch {
      throw new UploadRefused(400, `part ${part} stopped part way; send it again`);
    }
    for (let turn = 0; turn < 200; turn += 1) {
      const now = await this.#meta(owner, id);
      if (!now) throw new UploadRefused(404, 'no such upload, or it expired');
      if (now.complete) return this.#partsOf(now);
      if (now.mpu !== meta.mpu) break;
      const parts = [...(now.parts ?? []).filter((p) => p.part !== part), stored];
      if (
        await uploads.compareAndSet(id, { rev: now.rev ?? 0 }, { parts, rev: (now.rev ?? 0) + 1 })
      ) {
        return this.#partsOf({ ...now, parts });
      }
    }
    throw new UploadRefused(409, `part ${part} could not be recorded; send it again`);
  }

  /** Makes the parts the file, once every one is in. Asked again, it says the same. */
  async completeParts(owner: string, id: string): Promise<UploadState & { missing?: number[] }> {
    const uploads = this.#records(owner);
    const meta = await this.#meta(owner, id);
    if (!this.#remote || !meta) throw new UploadRefused(404, 'no such upload, or it expired');
    if (meta.complete) return { upload_id: id, received: meta.bytes ?? 0, complete: true };
    if (!meta.parts || !meta.part_bytes || meta.bytes === null || !meta.mpu) {
      throw new UploadRefused(409, 'this upload is not being sent in parts');
    }
    const count = Math.max(1, Math.ceil(meta.bytes / meta.part_bytes));
    const have = new Set(meta.parts.map((p) => p.part));
    const missing = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !have.has(n));
    const received = meta.parts.reduce((sum, p) => sum + p.bytes, 0);
    if (missing.length) return { upload_id: id, received, complete: false, missing };
    try {
      await this.#ws.blobs.multipartComplete(this.#blob(owner, meta), meta.mpu, meta.parts);
    } catch (error) {
      // Two requests completing at once: the one that lost finds it complete.
      const now = await this.#meta(owner, id);
      if (now?.complete) return { upload_id: id, received: now.bytes ?? 0, complete: true };
      throw error;
    }
    await uploads.update(id, { set: { complete: true, mpu: '', parts: [], offset: meta.bytes } });
    await floorChanged(this.#ws, owner);
    return { upload_id: id, received: meta.bytes, complete: true };
  }

  async #sign(path: string, exp: number): Promise<string> {
    return createHmac('sha256', await this.#secret())
      .update(`upload\n${path}\n${exp}`)
      .digest('base64url');
  }
}
