import { createHmac, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isMissing, ownerKey, randomId, type Workspace } from '@cuttingfloor/core';
import { CfError } from '@cuttingfloor/schema';

/** How long an upload URL works, and how long an unimported upload is kept. */
export const UPLOAD_TTL_MS = 24 * 3_600_000;

interface UploadMeta {
  upload_id: string;
  name: string;
  /** The file's data, in the upload's folder; named with the file's extension for probing. */
  file: string;
  bytes: number | null;
  complete: boolean;
  created_at: string;
  /** The most this upload takes, when the account's storage left is less than `maxBytes`. */
  max_bytes?: number;
}

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
 * uploads go after a day; an import moves the file into the media.
 */
export class Uploads {
  readonly #ws: Workspace;
  readonly #secret: () => Promise<Buffer>;
  readonly #publicUrl: () => string;
  readonly maxBytes: number;
  /** Uploads taking a request on this server, so two never write one file at once. */
  readonly #busy = new Set<string>();

  constructor(
    ws: Workspace,
    options: { secret: () => Promise<Buffer>; publicUrl: () => string; maxBytes: number },
  ) {
    this.#ws = ws;
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
  ): Promise<{ upload_id: string; url: string; expires_at: string; max_bytes: number }> {
    if (bytes !== undefined && bytes > this.maxBytes) {
      throw new CfError(
        'bad_request',
        `${name} is ${bytes} bytes; uploads take up to ${this.maxBytes}`,
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
    };
    await this.#ws.writeJson(this.#record(ownerKey(owner), id), meta);
    const exp = Date.now() + UPLOAD_TTL_MS;
    const path = `/uploads/${ownerKey(owner)}/${id}`;
    return {
      upload_id: id,
      url: `${this.#publicUrl()}${path}?exp=${exp}&sig=${await this.#sign(path, exp)}`,
      expires_at: new Date(exp).toISOString(),
      max_bytes: meta.max_bytes ?? this.maxBytes,
    };
  }

  /** An upload whose bytes are already here (a data: URI), complete at once. */
  async put(owner: string, name: string, bytes: Buffer): Promise<string> {
    const { upload_id } = await this.create(owner, name, bytes.length);
    const key = ownerKey(owner);
    const meta = await this.#meta(key, upload_id);
    if (!meta) throw new CfError('engine_error', `Upload ${upload_id} vanished`);
    await writeFile(join(this.#dir(key, upload_id), meta.file), bytes, { mode: 0o600 });
    await this.#ws.writeJson(this.#record(key, upload_id), {
      ...meta,
      bytes: bytes.length,
      complete: true,
    });
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
    request: { length: number | null; range: { start: number; total: number | null } | null },
  ): Promise<UploadState> {
    const meta = await this.#meta(owner, id);
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
      const total = request.range ? request.range.total : request.length;
      const limit = meta.max_bytes ?? this.maxBytes;
      const tooBig =
        meta.max_bytes === undefined
          ? `uploads take up to ${limit} bytes`
          : `the account's storage has room for ${limit} more bytes; let older files expire or move to a bigger plan`;
      if ((total ?? 0) > limit || start + (request.length ?? 0) > limit) {
        throw new UploadRefused(413, tooBig, received);
      }
      const file = join(this.#dir(owner, id), meta.file);
      let size = start;
      const counted = async function* (source: Readable) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > limit) throw new UploadRefused(413, tooBig);
          yield chunk;
        }
      };
      try {
        await pipeline(
          body,
          counted,
          createWriteStream(file, { flags: request.range ? 'a' : 'w' }),
        );
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
        await this.#ws.writeJson(this.#record(owner, id), { ...meta, bytes: size, complete: true });
      }
      return { upload_id: id, received: size, complete };
    } finally {
      this.#busy.delete(key);
    }
  }

  /** A complete upload's file and name, for media.import. */
  async take(owner: string, id: string): Promise<{ file: string; name: string }> {
    const key = ownerKey(owner);
    const meta = await this.#meta(key, id);
    if (!meta) {
      throw new CfError('not_found', `Upload ${id} not found`, {
        hint: 'Uploads expire a day after media.upload, and each imports once; call media.upload again',
      });
    }
    if (!meta.complete) {
      const received = await this.#size(key, meta);
      throw new CfError(
        'media_not_ready',
        `Upload ${id} has ${received} bytes and isn't complete`,
        {
          hint: 'Finish the PUT to its url (resume a broken one with Content-Range from the bytes received), then import it',
        },
      );
    }
    return { file: join(this.#dir(key, id), meta.file), name: meta.name };
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
    for (const id of await this.#ws.list(this.#ws.path('owners', key, 'uploads'))) {
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
    await this.#ws.remove(this.#dir(ownerKey(owner), id));
  }

  async sweep(): Promise<void> {
    for (const owner of await this.#ws.owners()) {
      // An hour past the URL's life, so a PUT that was still running finishes first.
      await this.#ws.sweep(this.#ws.path('owners', owner, 'uploads'), UPLOAD_TTL_MS + 3_600_000);
    }
  }

  #dir(owner: string, id: string): string {
    return this.#ws.path('owners', owner, 'uploads', id);
  }

  #record(owner: string, id: string): string {
    return join(this.#dir(owner, id), 'upload.json');
  }

  async #meta(owner: string, id: string): Promise<UploadMeta | undefined> {
    return this.#ws.readJson<UploadMeta>(this.#record(owner, id));
  }

  async #size(owner: string, meta: UploadMeta): Promise<number> {
    try {
      return (await stat(join(this.#dir(owner, meta.upload_id), meta.file))).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  async #sign(path: string, exp: number): Promise<string> {
    return createHmac('sha256', await this.#secret())
      .update(`upload\n${path}\n${exp}`)
      .digest('base64url');
  }
}
