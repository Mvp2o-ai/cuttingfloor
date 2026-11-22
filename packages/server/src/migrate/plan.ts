import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  type BlobKeys,
  type CollectionSpec,
  definedCollections,
  FsBlobStore,
  FsRecords,
  ownerKey,
} from '@cuttingfloor/core';
import { KEEP_MS } from '@cuttingfloor/schema';
import {
  type BlobItem,
  COLLECTION_RULES,
  type FileStat,
  type Layout,
  type LogItem,
  type RecordItem,
  readLayout,
  relTag,
  specKey,
  type UnknownItem,
} from './layout.ts';
import { recordKey } from './manifest.ts';

// What one pass over a source data root would move: every live record, log part and blob, with
// where each goes, and everything it leaves (expired, without an owner record, being written).
// Building it reads the source and writes nothing anywhere.

/** The source data root, read through the filesystem stores. Nothing here ever writes to it. */
export interface Source {
  root: string;
  records: FsRecords;
  blobs: FsBlobStore;
}

export function openSource(root: string): Source {
  return { root, records: new FsRecords(root), blobs: new FsBlobStore(root) };
}

export interface PlannedRecord {
  item: RecordItem;
  /** Its key in the manifest. */
  key: string;
}

export interface PlannedBlob {
  item: BlobItem;
  /** What it is, for counts: `media:source`, `media:analysis`, `upload`, `output:export`… */
  kind: string;
  /** The key it takes at the target (before sharing, which may name another). */
  targetKey: string;
  /** An upload still arriving: its whole parts are carried, not the file. */
  partway: boolean;
  /** Left for the next pass, and why. */
  wait?: string;
}

export interface PlannedLog {
  item: LogItem;
  ttlMs: number | undefined;
}

export interface Skipped {
  rel: string;
  what: string;
  why: 'expired' | 'orphan';
  size: number;
}

export interface Plan {
  now: number;
  layout: Layout;
  specs: readonly CollectionSpec<unknown>[];
  records: PlannedRecord[];
  blobs: PlannedBlob[];
  logs: PlannedLog[];
  skipped: Skipped[];
  /** Folders whose own age the blob store sweeps by, with where each is at the target. */
  folders: Array<{ rel: string; target: string; mtimeMs: number }>;
  /** Media whose file is a path outside the data root (local mode): cannot exist on hosted. */
  pathImports: string[];
  /** Records that could not be read whole (changing under the read, or not JSON). */
  unreadable: Array<{ rel: string; why: string }>;
  unknown: UnknownItem[];
  missingRules: string[];
  /** Where any source blob key goes at the target. */
  mapKey(key: string): string;
  /** Uploads still arriving, by `{owner}/{upload_id}`: the name of the file their bytes are in. */
  arriving: Map<string, string>;
  /** Jobs still working, by `{owner}/{job_id}`. */
  working: Set<string>;
  /**
   * Everything the source has, moved or not (past its time, without its record, unreadable):
   * record keys (as the manifest keys them) and blob keys. Only what is not here has gone from
   * the source, and only that is ever removed from the target: something that expired at the
   * source and is still there is left for the target's own sweep.
   */
  present: { records: Set<string>; blobs: Set<string> };
  /** Each upload's clock: the later of its record's and its folder's last write, by `{owner}/{id}`. */
  uploadTimes: Map<string, number>;
  /** Owner keys left alone on both sides (`excludeOwners`). */
  excluded: Set<string>;
}

export interface PlanOptions {
  now?: number;
  /** How long frames kept for download last (the server's `outputUrlTtlMs`). */
  outputTtlMs?: number;
  /** A blob written less than this ago is left for the next pass. 0 takes everything. */
  settleMs?: number;
  ignore?: readonly string[];
  /**
   * Accounts the migration leaves alone on both sides (a test account made on the new server):
   * not read at the source, never compared, removed or pruned at the target.
   */
  excludeOwners?: readonly string[];
}

const UPLOAD_KEEP_MS = KEEP_MS.upload + 3_600_000;

/** A file's stat; undefined only when it is not there. Any other failure is thrown. */
async function fileStat(path: string): Promise<FileStat | undefined> {
  return lstat(path).then(
    (s) => ({ size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev, nlink: s.nlink }),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
}

export type ReadRecord =
  | { state: 'ok'; value: unknown; stat: FileStat }
  | { state: 'gone' }
  | { state: 'unreadable'; why: string };

/**
 * A source record, read whole: its file is the same before and after the read (the server
 * replaces a record by renaming a new file over it, so a read sees one version or the other).
 * Never counts as a use: the source's clocks are not ours to move.
 */
export async function readRecord(source: Source, item: RecordItem): Promise<ReadRecord> {
  const file = join(source.root, ...item.rel.split('/'));
  const collection = source.records.collection(item.spec, {
    ...(item.owner ? { owner: item.owner } : {}),
    ...(item.parent ? { parent: item.parent } : {}),
  });
  let why = 'kept changing';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = await fileStat(file);
    if (!before) return { state: 'gone' };
    let value: unknown;
    try {
      value = await collection.get(item.id);
    } catch (error) {
      why = error instanceof SyntaxError ? 'not JSON' : 'could not be read';
      continue;
    }
    const after = await fileStat(file);
    if (value === undefined || !after) return { state: 'gone' };
    if (after.mtimeMs === before.mtimeMs && after.size === before.size && after.ino === before.ino)
      return { state: 'ok', value, stat: after };
  }
  return { state: 'unreadable', why };
}

/** Where a blob under an owner's folder goes, through the target's own key functions. */
function mapParts(
  keys: BlobKeys,
  owner: string,
  area: string,
  holder: string,
  name: string[],
  own: boolean,
): string {
  if (area === 'uploads') return keys.upload(owner, holder, name.join('/'));
  if (area === 'outputs') return keys.output(owner, holder, name.join('/'));
  return own && name.length === 1
    ? keys.media(owner, holder, name[0] as string)
    : keys.derived(owner, holder, ...name);
}

/** The blob fields of a record, by field, as the source store reads them (keys, or paths). */
export function blobFields(spec: CollectionSpec<unknown>, value: unknown): Array<[string, string]> {
  if (!spec.blobs?.length || !value || typeof value !== 'object') return [];
  const out: Array<[string, string]> = [];
  for (const field of spec.blobs) {
    const ref = (value as Record<string, unknown>)[field];
    if (typeof ref === 'string' && ref) out.push([field, ref]);
  }
  return out;
}

export async function buildPlan(
  source: Source,
  targetKeys: BlobKeys,
  options: PlanOptions & { specs?: readonly CollectionSpec<unknown>[] } = {},
): Promise<Plan> {
  const now = options.now ?? Date.now();
  const specs = options.specs ?? definedCollections();
  const outputTtlMs = options.outputTtlMs ?? KEEP_MS.job;
  const settleMs = options.settleMs ?? 0;
  const excluded = new Set((options.excludeOwners ?? []).map((o) => ownerKey(o)));
  const layout = await readLayout(source.root, specs, {
    ignore: [...(options.ignore ?? []), ...[...excluded].map((key) => `owners/${key}`)],
  });

  const plan: Plan = {
    now,
    layout,
    specs,
    records: [],
    blobs: [],
    logs: [],
    skipped: [],
    folders: [],
    pathImports: [],
    unreadable: [],
    unknown: layout.unknown,
    missingRules: layout.missingRules,
    mapKey: (key) => key,
    arriving: new Map(),
    working: new Set(),
    present: {
      records: new Set(
        layout.records.map((r) => recordKey(specKey(r.spec), r.owner, r.parent, r.id)),
      ),
      blobs: new Set(layout.blobs.map((b) => b.rel)),
    },
    uploadTimes: new Map(),
    excluded,
  };
  if (plan.unknown.length || plan.missingRules.length) return plan;

  // The records other things live and die with, read first.
  const jobs = new Map<string, { live: boolean; working: boolean }>();
  const media = new Map<string, { live: boolean }>();
  const uploads = new Map<string, { live: boolean; complete: boolean; file?: string }>();
  const outputKinds = new Map<string, string>();
  /** Keys a media record names as its own file, mezzanine or proxy. */
  const own = new Set<string>();
  const values = new Map<RecordItem, ReadRecord>();
  const drivers = new Set(['jobs', 'media', 'uploads', 'outputs']);
  for (const item of layout.records) {
    if (!drivers.has(item.spec.name) || item.spec.kind) continue;
    const read = await readRecord(source, item);
    values.set(item, read);
    if (read.state !== 'ok') continue;
    const at = `${item.owner}/${item.id}`;
    const value = read.value as Record<string, unknown>;
    if (item.spec.name === 'jobs') {
      const working = value.status === 'working';
      const ends = Date.parse(String(value.lastUpdatedAt)) + Number(value.ttlMs);
      jobs.set(at, { working, live: working || !(ends < now) });
      if (working) plan.working.add(at);
    } else if (item.spec.name === 'media') {
      media.set(at, { live: !(read.stat.mtimeMs + KEEP_MS.media < now) });
      for (const [field, ref] of blobFields(item.spec, value)) {
        if (isAbsolute(ref)) plan.pathImports.push(`${relTag(item.rel)} (${field})`);
        else own.add(ref);
      }
    } else if (item.spec.name === 'uploads') {
      const folder = layout.folders.get(`owners/${item.owner}/uploads/${item.id}`);
      const complete = value.complete === true;
      // The later of the two: every byte received writes the folder, every state change the record.
      const used = Math.max(folder ?? 0, read.stat.mtimeMs);
      plan.uploadTimes.set(at, used);
      uploads.set(at, {
        live: !(used + UPLOAD_KEEP_MS < now),
        complete,
        ...(typeof value.file === 'string' ? { file: value.file } : {}),
      });
      if (!complete && typeof value.file === 'string') plan.arriving.set(at, value.file);
    } else if (typeof value.kind === 'string') outputKinds.set(at, value.kind);
  }

  /** Whether an output's files are kept: a job's with its job, frames by their folder's age. */
  const outputLive = (owner: string, id: string): 'live' | 'expired' | 'orphan' => {
    if (id.startsWith('f_')) {
      const folder = layout.folders.get(`owners/${owner}/outputs/${id}`);
      if (folder === undefined) return 'orphan';
      return folder + outputTtlMs < now ? 'expired' : 'live';
    }
    const job = jobs.get(`${owner}/${id}`);
    return job ? (job.live ? 'live' : 'expired') : 'orphan';
  };

  plan.mapKey = (key) => {
    const m = /^owners\/([^/]+)\/(media|uploads|outputs)\/([^/]+)\/(.+)$/.exec(key);
    if (!m) return key;
    const [, owner, area, holder, rest] = m as unknown as [string, string, string, string, string];
    return mapParts(targetKeys, owner, area, holder, rest.split('/'), own.has(key));
  };

  for (const item of layout.records) {
    const rule = COLLECTION_RULES[specKey(item.spec)] ?? {};
    const what = specKey(item.spec);
    const read = values.get(item);
    if (read?.state === 'gone') continue;
    if (read?.state === 'unreadable') {
      plan.unreadable.push({ rel: item.rel, why: read.why });
      continue;
    }
    const at = `${item.owner}/${item.id}`;
    let state: 'live' | 'expired' | 'orphan' = 'live';
    if (rule.follows === 'job') {
      const job = jobs.get(at);
      state = job ? (job.live ? 'live' : 'expired') : 'orphan';
    } else if (rule.follows === 'media-folder') state = media.get(at)?.live ? 'live' : 'expired';
    else if (rule.follows === 'upload-folder') state = uploads.get(at)?.live ? 'live' : 'expired';
    else if (rule.follows === 'output') state = outputLive(item.owner ?? '', item.id);
    else {
      const ttlMs = rule.ttlMs ?? item.spec.db?.ttlMs;
      if (ttlMs !== undefined && item.mtimeMs + ttlMs < now) state = 'expired';
    }
    if (state !== 'live') {
      plan.skipped.push({ rel: item.rel, what, why: state, size: item.size });
      continue;
    }
    plan.records.push({ item, key: recordKey(what, item.owner, item.parent, item.id) });
  }

  for (const item of layout.logs) {
    const ttlMs = item.spec.db?.ttlMs;
    if (ttlMs !== undefined && item.mtimeMs + ttlMs < now) {
      plan.skipped.push({
        rel: item.rel,
        what: specKey(item.spec),
        why: 'expired',
        size: item.size,
      });
    } else plan.logs.push({ item, ttlMs });
  }

  const liveFolders = new Set<string>();
  for (const item of layout.blobs) {
    const at = `${item.owner}/${item.holder}`;
    let state: 'live' | 'expired' | 'orphan';
    let kind: string;
    let partway = false;
    let wait: string | undefined;
    if (item.area === 'media') {
      const record = media.get(at);
      state = record ? (record.live ? 'live' : 'expired') : 'orphan';
      const first = item.name[0] ?? '';
      if (own.has(item.rel)) kind = 'media:own';
      else if (first === 'analyses') kind = 'media:analysis';
      else if (item.name.length > 1) kind = `media:${first}`;
      else kind = 'media:other';
    } else if (item.area === 'uploads') {
      const record = uploads.get(at);
      state = record ? (record.live ? 'live' : 'expired') : 'orphan';
      partway = Boolean(record && !record.complete && record.file === item.name.join('/'));
      kind = partway ? 'upload:part-way' : 'upload';
    } else {
      state = outputLive(item.owner, item.holder);
      kind = `output:${outputKinds.get(at) ?? (item.holder.startsWith('f_') ? 'frames' : 'job')}`;
      if (plan.working.has(at)) wait = 'its job is still working';
    }
    if (state !== 'live') {
      plan.skipped.push({ rel: item.rel, what: kind, why: state, size: item.size });
      continue;
    }
    if (!partway && !wait && settleMs > 0 && item.mtimeMs > now - settleMs) {
      wait = 'written moments ago';
    }
    if (item.area !== 'media') liveFolders.add(`owners/${item.owner}/${item.area}/${item.holder}`);
    plan.blobs.push({
      item,
      kind,
      targetKey: plan.mapKey(item.rel),
      partway,
      ...(wait ? { wait } : {}),
    });
  }
  // An upload with a record and no bytes yet has a folder too.
  for (const [at, upload] of uploads) {
    if (upload.live) liveFolders.add(`owners/${at.replace('/', '/uploads/')}`);
  }
  for (const rel of liveFolders) {
    const mtimeMs = layout.folders.get(rel);
    if (mtimeMs === undefined) continue;
    const [, owner = '', area, holder = ''] = rel.split('/');
    const target =
      area === 'uploads'
        ? targetKeys.upload(owner, holder, '')
        : targetKeys.output(owner, holder, '');
    plan.folders.push({ rel, target: target.replace(/\/+$/, ''), mtimeMs });
  }
  return plan;
}
