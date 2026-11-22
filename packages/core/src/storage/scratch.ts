import type { BlobKey } from './blobs.ts';

/**
 * This node's local disk, the only place engines (ffmpeg, melt, whisper, workers) read and
 * write. They take local paths from here and never from the data root.
 */
export interface Scratch {
  /** A local file holding the blob's bytes, to read. Never written to. */
  materialize(key: BlobKey): Promise<string>;
  /**
   * A local path to write a new blob's bytes at, its folder made. `publish` then stores it. On
   * the filesystem this is the blob's own file, so writing it is storing it.
   */
  reserve(key: BlobKey): Promise<string>;
  /** Stores a local file as `key` and returns the key. A path from `reserve(key)` costs nothing. */
  publish(localPath: string, key: BlobKey, options?: { move?: boolean }): Promise<BlobKey>;
  /**
   * A local folder standing for every blob under `prefix`, for an engine that keeps a set of
   * files together (a search index, stems). `publishDir` stores what the engine wrote there.
   * With `only`, just those names (paths under the folder) are brought up to date, or stored:
   * for a folder of many large files of which a caller needs one, or none yet (`only: []`, a
   * folder to write in). On the filesystem the folder is the blobs' own, whatever is asked.
   */
  materializeDir(prefix: BlobKey, options?: { only?: string[] }): Promise<string>;
  publishDir(localDir: string, prefix: BlobKey, options?: { only?: string[] }): Promise<void>;
  /** The key of a local path that is already a blob's own file here, or undefined. */
  keyOf(localPath: string): BlobKey | undefined;
  /** A folder for work in progress, on this node only. The caller removes it. */
  temp(prefix: string): Promise<string>;
}
