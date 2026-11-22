import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BlobStore } from './storage/blobs.ts';
import { type FsBlobOptions, FsBlobStore } from './storage/fs-blobs.ts';
import { FsRecords } from './storage/fs-records.ts';
import { FsScratch } from './storage/fs-scratch.ts';
import {
  isMissing,
  listDir,
  ownerKey,
  readJson,
  sweepDir,
  touch,
  writeJson,
} from './storage/fs-util.ts';
import type { Records } from './storage/records.ts';
import type { Scratch } from './storage/scratch.ts';

/**
 * Everything durable the server keeps, behind three stores: `records` (every record), `blobs`
 * (every file) and `scratch` (this node's local paths for engines). Nothing here is a project
 * the user keeps; every record and file has a TTL.
 *
 * On the filesystem (local mode, tests, and hosted until its stores move) all three sit on one
 * data root (`/data` in the image), laid out as it always was:
 *
 *   owners/{owner}/timelines/{timeline_id}.json   24 h after last use
 *   owners/{owner}/media/{media_id}/…             7 d after last use
 *   owners/{owner}/jobs/{job_id}.json             7 d after finishing
 *   owners/{owner}/outputs/{job_id}/…             7 d
 *   owners/{owner}/calls/{day}.{node}.jsonl       30 d (what each call did, no arguments)
 *   owners/{owner}/floor.json                     7 d (the cursor /v1/floor.changes waits on)
 *   cache/…                                       derived, disposable
 *
 * The path and file methods below are the filesystem's own, for callers not yet moved onto the
 * stores; new code takes `records`, `blobs` and `scratch`.
 */
export class Workspace {
  readonly root: string;
  readonly records: Records;
  readonly blobs: BlobStore;
  readonly scratch: Scratch;

  /**
   * False when the records are in another store than the files: removing a folder of files
   * then removes no record with it.
   */
  readonly recordsWithFiles: boolean;

  /**
   * `records` puts the records in another store (a database) while the files stay under the
   * data root; without it they are the JSON files they always were.
   */
  constructor(root: string, options: FsBlobOptions & { records?: Records } = {}) {
    // Absolute from the start: a relative data root (`./data`) means the folder under the
    // directory the server started in, whatever a later path is compared against.
    this.root = resolve(root);
    const { records, ...blobOptions } = options;
    const blobs = new FsBlobStore(this.root, blobOptions);
    // Blob fields are written as paths under the root as it was given, as they always were.
    this.records = records ?? new FsRecords(this.root, { pathsFrom: root });
    this.recordsWithFiles = !records;
    this.blobs = blobs;
    this.scratch = new FsScratch(blobs);
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  /** Directory for one owner's data. Owner strings are hashed unless already safe. */
  ownerDir(owner: string, ...parts: string[]): string {
    return this.path('owners', ownerKey(owner), ...parts);
  }

  readJson<T>(file: string, options: { touch?: boolean } = {}): Promise<T | undefined> {
    return readJson<T>(file, options);
  }

  /**
   * Crash-safe write: temp file, fsync, rename. With `exclusive`, an existing file is left alone
   * and the call returns false.
   */
  writeJson(file: string, value: unknown, options: { exclusive?: boolean } = {}): Promise<boolean> {
    return writeJson(file, value, options);
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  list(dir: string): Promise<string[]> {
    return listDir(dir);
  }

  owners(): Promise<string[]> {
    return this.records.owners();
  }

  /** Deletes entries of `dir` whose mtime is older than `ttlMs`. Returns how many went. */
  async sweep(dir: string, ttlMs: number, keep?: (name: string) => boolean): Promise<number> {
    return (await sweepDir(dir, ttlMs, keep)).length;
  }
}

export { isMissing, ownerKey, touch };
