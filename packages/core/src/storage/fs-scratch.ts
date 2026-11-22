import { copyFile, cp, mkdir, mkdtemp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BlobKey } from './blobs.ts';
import type { FsBlobStore } from './fs-blobs.ts';
import type { Scratch } from './scratch.ts';

/**
 * Local paths over the filesystem blob store: a blob's local file is its own file under the
 * data root, so nothing is copied to read it and writing to a reserved path stores it.
 */
export class FsScratch implements Scratch {
  readonly #blobs: FsBlobStore;

  constructor(blobs: FsBlobStore) {
    this.#blobs = blobs;
  }

  async materialize(key: BlobKey): Promise<string> {
    return this.#blobs.file(key);
  }

  async reserve(key: BlobKey): Promise<string> {
    const file = this.#blobs.file(key);
    await mkdir(dirname(file), { recursive: true });
    return file;
  }

  async publish(
    localPath: string,
    key: BlobKey,
    options: { move?: boolean } = {},
  ): Promise<BlobKey> {
    const file = this.#blobs.file(key);
    if (localPath === file) return key;
    await mkdir(dirname(file), { recursive: true });
    if (options.move) await rename(localPath, file);
    else await copyFile(localPath, file);
    return key;
  }

  /** The folder itself, which may not exist yet: the engine makes it as it writes. */
  async materializeDir(prefix: BlobKey, _options?: { only?: string[] }): Promise<string> {
    return this.#blobs.file(prefix);
  }

  async publishDir(
    localDir: string,
    prefix: BlobKey,
    _options?: { only?: string[] },
  ): Promise<void> {
    const dir = this.#blobs.file(prefix);
    if (localDir === dir) return;
    await cp(localDir, dir, { recursive: true });
  }

  keyOf(localPath: string): BlobKey | undefined {
    return this.#blobs.keyOf(localPath);
  }

  temp(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
  }
}
