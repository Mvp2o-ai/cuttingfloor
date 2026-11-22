import { createHash, randomBytes } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BlobHead, BlobKey } from './blobs.ts';
import type { FsScratch } from './fs-scratch.ts';
import { isExisting, isMissing } from './fs-util.ts';
import type { S3BlobStore } from './s3-blobs.ts';
import type { Scratch } from './scratch.ts';

export interface S3ScratchOptions {
  /** The cache's folder on this node's disk. Everything in it can be lost. */
  dir: string;
  /** How much the cache may hold before the least recently used goes. */
  maxBytes: number;
  /**
   * Nothing used this recently is removed, whatever the cache holds: an engine handed a path
   * may not have opened it yet. Default one hour.
   */
  graceMs?: number;
}

interface Manifest {
  /** Per file of a folder: the store's tag of what was last fetched or sent, and its local state. */
  files: Record<string, { etag: string; bytes: number; mtimeMs: number }>;
}

const hashed = (text: string, length: number) =>
  createHash('sha256').update(text).digest('hex').slice(0, length);

/**
 * Local paths over an object store: a copy of each blob an engine reads, kept on this node's
 * disk until room is needed.
 *
 *   objects/{key}/{etag}/{name}   a blob as the store held it under that tag
 *   new/{key}/{name}              where an engine writes a blob before `publish` stores it
 *   dirs/{prefix}/…               a folder of blobs, with dirs/{prefix}.json saying what it holds
 *
 * What makes it safe:
 * - A copy is found by the blob's key and the store's tag of its bytes, read from the store on
 *   each `materialize`. A blob written again has a new tag, so its old copy is never served.
 * - A copy takes its place by a rename of a file only this class wrote, whole; a download that
 *   meets a blob rewritten part way fails and starts over, so no file mixes two writings.
 * - Nothing an engine can still write to is ever a copy: `publish` copies a reserved file in.
 * - Requests for one blob at one moment share one download.
 */
export class S3Scratch implements Scratch {
  readonly #blobs: S3BlobStore;
  readonly #local: FsScratch;
  readonly dir: string;
  readonly #maxBytes: number;
  readonly #graceMs: number;
  /** Downloads under way, by the path they fill. */
  readonly #fetching = new Map<string, Promise<string>>();
  readonly #syncing = new Map<string, Promise<string>>();
  /** Reserved paths and the keys they are for. */
  readonly #reserved = new Map<string, BlobKey>();
  /** When each path was last handed out, more exactly than the disk keeps. */
  readonly #used = new Map<string, number>();
  /** Media files never change under a key: their tag is trusted for a minute. */
  readonly #fresh = new Map<BlobKey, { path: string; at: number }>();
  /** Bytes added since the cache was last measured; undefined before the first measure. */
  #added: number | undefined;
  #held = 0;
  #evicting: Promise<void> | undefined;

  constructor(blobs: S3BlobStore, local: FsScratch, options: S3ScratchOptions) {
    this.#blobs = blobs;
    this.#local = local;
    this.dir = options.dir;
    this.#maxBytes = options.maxBytes;
    this.#graceMs = options.graceMs ?? 3_600_000;
  }

  #isLocal(key: BlobKey): boolean {
    return key === 'cache' || key.startsWith('cache/');
  }

  #objectPath(key: BlobKey, etag: string): string {
    const k = hashed(key, 32);
    return join(this.dir, 'objects', k.slice(0, 2), k, hashed(etag, 16), basename(key));
  }

  #use(path: string): void {
    const now = Date.now();
    this.#used.set(path, now);
    // Kept on the disk too, for a server started later. Never awaited: a hint, not a fact.
    const at = new Date(now);
    void utimes(path, at, at).catch(() => undefined);
  }

  async materialize(key: BlobKey): Promise<string> {
    if (this.#isLocal(key)) return this.#local.materialize(key);
    const known = this.#fresh.get(key);
    if (known && Date.now() - known.at < 60_000 && (await exists(known.path))) {
      this.#use(known.path);
      return known.path;
    }
    for (let attempt = 1; ; attempt += 1) {
      const head = await this.#blobs.stat(key);
      // A path that names nothing, as a missing blob's file is on the filesystem.
      if (!head) return join(this.dir, 'objects', 'none', hashed(key, 32), basename(key));
      const path = this.#objectPath(key, head.etag ?? `${head.bytes}-${head.modifiedAt.getTime()}`);
      try {
        const file = await this.#fetched(key, head, path);
        if (key.startsWith('media/')) this.#fresh.set(key, { path: file, at: Date.now() });
        return file;
      } catch (error) {
        // Written again while it was being read: read what is there now.
        if (attempt < 3 && (isExisting(error) || isMissing(error))) continue;
        throw error;
      }
    }
  }

  async #fetched(key: BlobKey, head: BlobHead, path: string): Promise<string> {
    const have = await stat(path).catch(() => undefined);
    if (have?.isFile() && have.size === head.bytes) {
      this.#use(path);
      return path;
    }
    let fetching = this.#fetching.get(path);
    if (!fetching) {
      fetching = this.#download(key, head, path).finally(() => this.#fetching.delete(path));
      this.#fetching.set(path, fetching);
    }
    return fetching;
  }

  async #download(key: BlobKey, head: BlobHead, path: string): Promise<string> {
    await mkdir(dirname(path), { recursive: true });
    const part = `${path}.${randomBytes(6).toString('hex')}.part`;
    try {
      await this.#fetch(key, head, part);
      await rename(part, path);
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
    this.#use(path);
    this.#grew(head.bytes);
    return path;
  }

  /** The blob's bytes into `file`: one read when small, else ranges side by side. */
  async #fetch(key: BlobKey, head: BlobHead, file: string): Promise<void> {
    const etag = head.etag ? { etag: head.etag } : {};
    const size = this.#blobs.partBytes;
    if (head.bytes <= 2 * size) {
      await pipeline(await this.#blobs.read(key, etag), createWriteStream(file));
      const got = (await stat(file)).size;
      if (got !== head.bytes) throw new Error(`A read of ${key} ended at ${got} of ${head.bytes}`);
      return;
    }
    const handle = await open(file, 'w');
    try {
      const starts: number[] = [];
      for (let at = 0; at < head.bytes; at += size) starts.push(at);
      let next = 0;
      const run = async () => {
        while (next < starts.length) {
          const start = starts[next++] as number;
          const end = Math.min(head.bytes, start + size) - 1;
          let at = start;
          for await (const chunk of await this.#blobs.read(key, { start, end, ...etag })) {
            const bytes = chunk as Buffer;
            await handle.write(bytes, 0, bytes.length, at);
            at += bytes.length;
          }
          if (at !== end + 1) throw new Error(`A read of ${key} ended at ${at} of ${end + 1}`);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(this.#blobs.concurrency, starts.length) }, run),
      );
    } finally {
      await handle.close();
    }
  }

  async reserve(key: BlobKey): Promise<string> {
    if (this.#isLocal(key)) return this.#local.reserve(key);
    const path = join(this.dir, 'new', hashed(key, 32), basename(key));
    await mkdir(dirname(path), { recursive: true });
    this.#reserved.set(path, key);
    this.#used.set(path, Date.now());
    return path;
  }

  async publish(
    localPath: string,
    key: BlobKey,
    options: { move?: boolean } = {},
  ): Promise<BlobKey> {
    if (this.#isLocal(key)) return this.#local.publish(localPath, key, options);
    const head = await this.#blobs.put(key, { file: localPath });
    this.#fresh.delete(key);
    if (head.etag) {
      // Kept as this node's copy, so the next read costs nothing. A file given up is renamed
      // in; one the caller keeps is copied, so nothing it does later can change the copy.
      const path = this.#objectPath(key, head.etag);
      try {
        await mkdir(dirname(path), { recursive: true });
        const part = `${path}.${randomBytes(6).toString('hex')}.part`;
        if (options.move) {
          await rename(localPath, part).catch(async () => {
            await copyFile(localPath, part);
            await rm(localPath, { force: true });
          });
        } else await copyFile(localPath, part, constants.COPYFILE_FICLONE);
        // Only what was sent: a file its writer changed meanwhile is not the blob.
        if ((await stat(part)).size === head.bytes) {
          await rename(part, path);
          this.#use(path);
          this.#grew(head.bytes);
        } else await rm(part, { force: true });
      } catch {
        // No copy kept; the next read fetches it.
        if (options.move) await rm(localPath, { force: true });
      }
    } else if (options.move) await rm(localPath, { force: true });
    return key;
  }

  #mirror(prefix: BlobKey): { dir: string; manifest: string } {
    const name = hashed(prefix.replace(/\/+$/, ''), 32);
    return {
      dir: join(this.dir, 'dirs', name),
      manifest: join(this.dir, 'dirs', `${name}.json`),
    };
  }

  async #manifest(file: string): Promise<Manifest> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as Manifest;
    } catch {
      return { files: {} };
    }
  }

  /**
   * The folder as the store holds it now: blobs new or written again are fetched, and files it
   * fetched or sent before that the store no longer has are removed. Files an engine wrote
   * there and has not published are left alone.
   */
  async materializeDir(prefix: BlobKey, options: { only?: string[] } = {}): Promise<string> {
    if (this.#isLocal(prefix)) return this.#local.materializeDir(prefix);
    const { dir } = this.#mirror(prefix);
    // One at a time per folder: its manifest is read, changed and written whole.
    const before = this.#syncing.get(dir) ?? Promise.resolve('');
    const syncing = before.catch(() => '').then(() => this.#sync(prefix, options.only));
    this.#syncing.set(dir, syncing);
    void syncing
      .catch(() => undefined)
      .finally(() => {
        if (this.#syncing.get(dir) === syncing) this.#syncing.delete(dir);
      });
    return syncing;
  }

  async #sync(prefix: BlobKey, only: string[] | undefined): Promise<string> {
    const { dir, manifest: file } = this.#mirror(prefix);
    await mkdir(dir, { recursive: true });
    const folder = `${prefix.replace(/\/+$/, '')}/`;
    this.#use(dir);
    if (only && !only.length) return dir;
    const manifest = await this.#manifest(file);
    // The whole folder as the store lists it, or just the names asked for.
    const listed: BlobHead[] = [];
    if (only) {
      for (const name of only) {
        const head = await this.#blobs.stat(`${folder}${name}`);
        if (head) listed.push(head);
      }
    } else listed.push(...(await this.#blobs.list(folder)));
    const names = new Set<string>();
    let changed = false;
    for (const head of listed) {
      const name = head.key.slice(folder.length);
      names.add(name);
      const local = join(dir, ...name.split('/'));
      const had = manifest.files[name];
      const tag = head.etag ?? `${head.bytes}-${head.modifiedAt.getTime()}`;
      if (had?.etag === tag) {
        const s = await stat(local).catch(() => undefined);
        if (s?.isFile() && s.size === head.bytes) continue;
      }
      await mkdir(dirname(local), { recursive: true });
      const part = `${local}.${randomBytes(6).toString('hex')}.part`;
      try {
        await this.#fetch(head.key, head, part);
        await rename(part, local);
      } catch (error) {
        await rm(part, { force: true });
        // Gone or written again since the listing: the next call sees it as it is then.
        if (isMissing(error) || isExisting(error)) continue;
        throw error;
      }
      manifest.files[name] = { etag: tag, bytes: head.bytes, mtimeMs: (await stat(local)).mtimeMs };
      this.#grew(head.bytes);
      changed = true;
    }
    for (const name of only ?? Object.keys(manifest.files)) {
      if (names.has(name) || !manifest.files[name]) continue;
      await rm(join(dir, ...name.split('/')), { force: true });
      delete manifest.files[name];
      changed = true;
    }
    if (changed) await this.#saveManifest(file, manifest);
    return dir;
  }

  async #saveManifest(file: string, manifest: Manifest): Promise<void> {
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(manifest));
    await rename(temp, file);
  }

  /** Sends every file of the folder that is new or has changed since it was fetched or sent. */
  async publishDir(
    localDir: string,
    prefix: BlobKey,
    options: { only?: string[] } = {},
  ): Promise<void> {
    if (this.#isLocal(prefix)) return this.#local.publishDir(localDir, prefix);
    const { dir, manifest: file } = this.#mirror(prefix);
    const mirrored = localDir === dir;
    const send = async () => {
      const manifest = mirrored ? await this.#manifest(file) : { files: {} };
      const folder = prefix.replace(/\/+$/, '');
      let names: string[];
      if (options.only) names = options.only;
      else {
        let entries: { name: string; parentPath: string; isFile(): boolean }[];
        try {
          entries = await readdir(localDir, { recursive: true, withFileTypes: true });
        } catch (error) {
          if (isMissing(error)) return '';
          throw error;
        }
        names = entries
          .filter((e) => e.isFile())
          .map((e) => relative(localDir, join(e.parentPath, e.name)).split(sep).join('/'));
      }
      let changed = false;
      for (const name of names) {
        const local = join(localDir, ...name.split('/'));
        const s = await stat(local).catch(() => undefined);
        if (!s?.isFile()) continue;
        const had = manifest.files[name];
        if (had && had.bytes === s.size && had.mtimeMs === s.mtimeMs) continue;
        const head = await this.#blobs.put(`${folder}/${name}`, { file: local });
        manifest.files[name] = { etag: head.etag ?? '', bytes: s.size, mtimeMs: s.mtimeMs };
        changed = true;
      }
      if (mirrored && changed) await this.#saveManifest(file, manifest);
      if (mirrored) this.#use(dir);
      return '';
    };
    if (!mirrored) {
      await send();
      return;
    }
    // In turn with the folder's fetches: one manifest, one writer.
    const before = this.#syncing.get(dir) ?? Promise.resolve('');
    const sending = before.catch(() => '').then(send);
    this.#syncing.set(dir, sending);
    try {
      await sending;
    } finally {
      if (this.#syncing.get(dir) === sending) this.#syncing.delete(dir);
    }
  }

  /** Only a path this node reserved is a blob's own file here. */
  keyOf(localPath: string): BlobKey | undefined {
    return this.#reserved.get(localPath);
  }

  temp(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
  }

  /** Counts bytes in; past the cap, the cache is measured and the least recently used go. */
  #grew(bytes: number): void {
    if (this.#added === undefined) {
      // First use since the server started: what an earlier run left counts too.
      this.#added = 0;
      void this.evict().catch(() => undefined);
      return;
    }
    this.#added += bytes;
    if (this.#held + this.#added > this.#maxBytes) void this.evict().catch(() => undefined);
  }

  /**
   * Measures the cache and, over the cap, removes what was used longest ago until it fits:
   * object copies and reserved files one by one, a folder whole. Nothing used within the grace
   * period goes, so the cache can stand over its cap while everything in it is in use.
   */
  evict(): Promise<void> {
    this.#evicting ??= this.#evict().finally(() => {
      this.#evicting = undefined;
    });
    return this.#evicting;
  }

  async #evict(): Promise<void> {
    interface Unit {
      path: string;
      bytes: number;
      used: number;
      folder: boolean;
    }
    const units: Unit[] = [];
    const walk = async (dir: string, add: (path: string, bytes: number, used: number) => void) => {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isFile()) continue;
        const path = join(e.parentPath, e.name);
        const s = await lstat(path).catch(() => undefined);
        if (s) add(path, s.size, Math.max(s.mtimeMs, s.atimeMs));
      }
    };
    for (const sub of ['objects', 'new']) {
      await walk(join(this.dir, sub), (path, bytes, used) =>
        units.push({ path, bytes, used: Math.max(used, this.#used.get(path) ?? 0), folder: false }),
      );
    }
    const dirs = join(this.dir, 'dirs');
    for (const name of await readdir(dirs).catch(() => [])) {
      if (name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const unit: Unit = {
        path: join(dirs, name),
        bytes: 0,
        used: this.#used.get(join(dirs, name)) ?? 0,
        folder: true,
      };
      await walk(unit.path, (_path, bytes, used) => {
        unit.bytes += bytes;
        unit.used = Math.max(unit.used, used);
      });
      units.push(unit);
    }
    let total = units.reduce((sum, u) => sum + u.bytes, 0);
    const now = Date.now();
    for (const unit of units.sort((a, b) => a.used - b.used)) {
      if (total <= this.#maxBytes) break;
      if (now - unit.used < this.#graceMs) break;
      // A download still landing is its request's to finish.
      if (unit.path.endsWith('.part') && now - unit.used < 6 * 3_600_000) continue;
      await rm(unit.path, { recursive: true, force: true });
      if (unit.folder) await rm(`${unit.path}.json`, { force: true });
      this.#used.delete(unit.path);
      this.#reserved.delete(unit.path);
      total -= unit.bytes;
    }
    this.#held = total;
    this.#added = 0;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}
