import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Carried } from './uploads.ts';

// What a migration remembers between passes, in one JSON file beside its reports (never under
// the source data root). It is what makes a second pass cheap: a file whose size, mtime and
// inode are as the manifest has them is not read again. It holds paths, sizes, times and hashes,
// never a record's contents.

export const MANIFEST_VERSION = 1;

export interface BlobEntry {
  size: number;
  mtime_ms: number;
  ino: number;
  /** The bytes' SHA-256, read from the source when this entry was made. */
  sha256: string;
  /** The key the target holds the bytes under (what records there name). */
  target: string;
  /** The source key whose bytes these are, when the target shares them (a hard link at the source). */
  shared_from?: string;
}

export interface PartwayEntry extends Carried {
  size: number;
  mtime_ms: number;
}

export interface RecordEntry {
  size: number;
  mtime_ms: number;
  /** The file's inode: a record replaced by a rename has a new one, whatever its size and time. */
  ino?: number;
  /** The last use written with it, where that is not its mtime (an upload's: see `recordUsedAt`). */
  used_ms?: number;
  /** SHA-256 of the record as written to the target (its JSON, keys sorted). */
  hash: string;
}

export interface LogEntryState {
  size: number;
  mtime_ms: number;
  /** Entries written to the target from this part. */
  entries: number;
}

export interface Manifest {
  version: number;
  /** The source data root and the target this state is for: it is never used for another pair. */
  source: string;
  target: string;
  updated_at: string;
  /** By source key (the file's place under the data root). */
  blobs: Record<string, BlobEntry>;
  /** Uploads carried part way, by the source key of their bytes. */
  partway: Record<string, PartwayEntry>;
  /** By `{collection}|{owner}|{parent}|{id}`. */
  records: Record<string, RecordEntry>;
  /** By the log part's place under the data root. */
  logs: Record<string, LogEntryState>;
  /** The mtime restored on each folder the blob store ages things by, by source folder. */
  folders: Record<string, number>;
  /** Owners the target was given anything for. */
  owners: string[];
  /**
   * How big the source was at the last pass: a source that has shrunk a great deal since (a
   * mistyped mount, an empty folder) is refused before anything is removed for it.
   */
  last_source?: { owners: number; bytes: number; at: string };
}

export function emptyManifest(source: string, target: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    source,
    target,
    updated_at: new Date(0).toISOString(),
    blobs: {},
    partway: {},
    records: {},
    logs: {},
    folders: {},
    owners: [],
  };
}

export const manifestPath = (stateDir: string) => join(stateDir, 'manifest.json');

/** The state folder's manifest, or a new one. Refuses one made for another source or target. */
export async function loadManifest(
  stateDir: string,
  source: string,
  target: string,
): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(manifestPath(stateDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest(source, target);
    throw error;
  }
  const found = JSON.parse(text) as Manifest;
  if (found.version !== MANIFEST_VERSION) {
    throw new Error(
      `The manifest in ${stateDir} is version ${found.version}, not ${MANIFEST_VERSION}`,
    );
  }
  if (found.source !== source || found.target !== target) {
    throw new Error(
      `The state folder ${stateDir} belongs to another migration (${found.source} to ${found.target}). Give this one its own --state folder.`,
    );
  }
  return { ...emptyManifest(source, target), ...found };
}

/** Whole or not at all: temp file, fsync, rename. */
export async function saveManifest(stateDir: string, manifest: Manifest): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  manifest.updated_at = new Date().toISOString();
  const file = manifestPath(stateDir);
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(manifest));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
}

export function recordKey(
  collection: string,
  owner: string | undefined,
  parent: string | undefined,
  id: string,
): string {
  return `${collection}|${owner ?? ''}|${parent ?? ''}|${id}`;
}

export function parseRecordKey(key: string): {
  collection: string;
  owner?: string;
  parent?: string;
  id: string;
} {
  const [collection = '', owner = '', parent = '', ...id] = key.split('|');
  return {
    collection,
    ...(owner ? { owner } : {}),
    ...(parent ? { parent } : {}),
    id: id.join('|'),
  };
}
