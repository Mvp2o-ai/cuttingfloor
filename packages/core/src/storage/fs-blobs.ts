import { createWriteStream } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  BlobHead,
  BlobKey,
  BlobKeys,
  BlobPart,
  BlobSource,
  BlobStore,
  PresignOptions,
} from './blobs.ts';
import { isMissing, ownerKey, sweepDir, touch, under } from './fs-util.ts';

/** Today's folders under the data root, so a data root made before the stores needs no change. */
export const FS_BLOB_KEYS: BlobKeys = {
  media: (owner, mediaId, name) => `owners/${ownerKey(owner)}/media/${mediaId}/${name}`,
  derived: (owner, mediaId, ...name) =>
    ['owners', ownerKey(owner), 'media', mediaId, ...name].join('/'),
  output: (owner, id, name) => `owners/${ownerKey(owner)}/outputs/${id}/${name}`,
  outputs: (owner) => `owners/${ownerKey(owner)}/outputs`,
  upload: (owner, uploadId, name) => `owners/${ownerKey(owner)}/uploads/${uploadId}/${name}`,
  uploads: (owner) => `owners/${ownerKey(owner)}/uploads`,
  cache: (...name) => ['cache', ...name].join('/'),
};

export interface FsBlobOptions {
  /**
   * Signs a link for a blob clients may download (the server's own `/outputs/…` links), or
   * answers undefined for one it serves no link for.
   */
  presign?: (key: BlobKey, options: PresignOptions) => Promise<string | undefined>;
}

/**
 * Blobs as files under the data root: a key is the file's place under it. Sharing is a hard
 * link (a copy where the filesystem has none), last use is the file's mtime, and an upload in
 * parts appends to the file in place.
 */
export class FsBlobStore implements BlobStore {
  readonly keys = FS_BLOB_KEYS;
  readonly root: string;
  readonly #presign: FsBlobOptions['presign'];

  constructor(root: string, options: FsBlobOptions = {}) {
    this.root = root;
    this.#presign = options.presign;
  }

  /** The blob's own file. Only the filesystem stores and FsScratch may ask. */
  file(key: BlobKey): string {
    return under(this.root, key);
  }

  /** The key of a file under the data root, or undefined for one outside it. */
  keyOf(path: string): BlobKey | undefined {
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith('..') || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) {
      return undefined;
    }
    return rel.split(sep).join('/');
  }

  async put(key: BlobKey, from: BlobSource): Promise<BlobHead> {
    const file = this.file(key);
    await mkdir(dirname(file), { recursive: true });
    if ('file' in from) {
      if (from.file !== file) {
        if (from.move) await rename(from.file, file);
        else await copyFile(from.file, file);
      }
    } else if ('bytes' in from) {
      await writeFile(file, from.bytes, { mode: 0o600 });
    } else {
      await pipeline(from.stream, createWriteStream(file, { flags: 'w' }));
    }
    return this.#head(key, file);
  }

  async get(key: BlobKey): Promise<Readable> {
    return this.#read(key, {});
  }

  async getRange(key: BlobKey, start: number, end?: number): Promise<Readable> {
    return this.#read(key, { start, ...(end === undefined ? {} : { end }) });
  }

  async #read(key: BlobKey, range: { start?: number; end?: number }): Promise<Readable> {
    const file = this.file(key);
    // Opened first, so a missing blob rejects here and not later as a stream error.
    const handle = await open(file, 'r');
    return handle.createReadStream({ ...range, autoClose: true });
  }

  async head(key: BlobKey): Promise<BlobHead | undefined> {
    try {
      return await this.#head(key, this.file(key));
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  async #head(key: BlobKey, file: string): Promise<BlobHead> {
    const s = await stat(file);
    if (!s.isFile()) throw Object.assign(new Error(`Not a blob: ${key}`), { code: 'ENOENT' });
    return { key, bytes: s.size, modifiedAt: s.mtime, refs: s.nlink };
  }

  async delete(key: BlobKey): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async deletePrefix(prefix: BlobKey): Promise<void> {
    await rm(this.file(prefix), { recursive: true, force: true });
  }

  async list(prefix: BlobKey): Promise<BlobHead[]> {
    const dir = this.file(prefix);
    let entries: { name: string; parentPath: string; isFile(): boolean }[];
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
      throw error;
    }
    const heads: BlobHead[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const key = this.keyOf(join(e.parentPath, e.name));
      const head = key ? await this.head(key) : undefined;
      if (head) heads.push(head);
    }
    return heads.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async copy(from: BlobKey, to: BlobKey): Promise<BlobHead> {
    const dest = this.file(to);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(this.file(from), dest);
    return this.#head(to, dest);
  }

  async share(from: BlobKey, to: BlobKey): Promise<BlobKey> {
    const src = this.file(from);
    const dest = this.file(to);
    await mkdir(dirname(dest), { recursive: true });
    await rm(dest, { force: true });
    await link(src, dest).catch(() => copyFile(src, dest));
    return to;
  }

  async move(from: BlobKey, to: BlobKey): Promise<BlobKey> {
    const dest = this.file(to);
    await mkdir(dirname(dest), { recursive: true });
    await rename(this.file(from), dest);
    return to;
  }

  async touch(key: BlobKey): Promise<void> {
    await touch(this.file(key));
  }

  async expire(
    prefix: BlobKey,
    ttlMs: number,
    keep?: (name: string) => boolean,
  ): Promise<string[]> {
    return sweepDir(this.file(prefix), ttlMs, keep);
  }

  /**
   * Every file under the owner's folder, records included, a shared one once. The server's own
   * call log is not theirs and does not count.
   */
  async usage(owner: string): Promise<number> {
    const root = join(this.root, 'owners', ownerKey(owner));
    let entries: { name: string; parentPath: string; isFile(): boolean }[];
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    let total = 0;
    // Media that share a file (the same bytes imported twice) hold it once.
    const seen = new Set<number>();
    for (const e of entries) {
      if (!e.isFile() || e.parentPath === join(root, 'calls')) continue;
      // A file swept between the listing and its stat no longer counts.
      total += await stat(join(e.parentPath, e.name)).then(
        (s) => {
          if (s.nlink < 2) return s.size;
          if (seen.has(s.ino)) return 0;
          seen.add(s.ino);
          return s.size;
        },
        () => 0,
      );
    }
    return total;
  }

  async freeable(prefix: BlobKey): Promise<number> {
    let total = 0;
    const entries = await readdir(this.file(prefix), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      // A file another holder shares (a hard link) stays on disk with it.
      total += await stat(join(e.parentPath, e.name)).then(
        (x) => (x.nlink > 1 ? 0 : x.size),
        () => 0,
      );
    }
    return total;
  }

  async presignGet(key: BlobKey, options: PresignOptions): Promise<string | undefined> {
    return this.#presign?.(key, options);
  }

  // An upload in parts appends each part to the blob's file as it arrives, so the bytes
  // received are the file's size and a broken part keeps what landed.

  async multipartStart(_key: BlobKey): Promise<string> {
    return 'append';
  }

  async multipartPart(
    key: BlobKey,
    _uploadId: string,
    part: number,
    body: Readable,
  ): Promise<BlobPart> {
    const file = this.file(key);
    await mkdir(dirname(file), { recursive: true });
    const before = await stat(file).then(
      (s) => s.size,
      () => 0,
    );
    await pipeline(body, createWriteStream(file, { flags: 'a' }));
    const bytes = (await stat(file)).size - before;
    return { part, bytes, etag: `${part}-${bytes}` };
  }

  async multipartComplete(key: BlobKey): Promise<BlobHead> {
    return this.#head(key, this.file(key));
  }

  async multipartAbort(key: BlobKey): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}
