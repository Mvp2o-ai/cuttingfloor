import { createHmac, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import {
  type BlobKey,
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
    await this.#ws.blobs.put(this.#blob(key, meta), { bytes });
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
   * this node, to read.
   */
  async take(
    owner: string,
    id: string,
  ): Promise<{ blob: BlobKey; file: string; name: string; via?: UploadVia }> {
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
      file: await this.#ws.scratch.materialize(blob),
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

  /** Forgets an upload once imported. */
  async remove(owner: string, id: string): Promise<void> {
    const { blobs } = this.#ws;
    await blobs.deletePrefix(blobs.keys.upload(owner, id, ''));
    await this.#records(owner).delete(id);
    await floorChanged(this.#ws, owner);
  }

  async sweep(): Promise<void> {
    const { records, blobs } = this.#ws;
    for (const owner of await records.owners()) {
      // An hour past the URL's life, so a PUT that was still running finishes first. An upload
      // goes whole, its record with its bytes, by when either was last written.
      await blobs.expire(blobs.keys.uploads(owner), UPLOAD_TTL_MS + 3_600_000);
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
    return (await this.#ws.blobs.head(this.#blob(owner, meta)))?.bytes ?? 0;
  }

  async #sign(path: string, exp: number): Promise<string> {
    return createHmac('sha256', await this.#secret())
      .update(`upload\n${path}\n${exp}`)
      .digest('base64url');
  }
}
