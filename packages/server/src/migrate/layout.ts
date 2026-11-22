import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectionSpec } from '@cuttingfloor/core';
import { KEEP_MS } from '@cuttingfloor/schema';

// What a filesystem data root holds, file by file: which record of which collection, which blob,
// which part of a log, and what is deliberately left behind. Collections come from the specs the
// process has defined (`definedCollections()`), so the walk knows a folder exactly when the
// server does. A file nothing here can name is `unknown`, and the migration refuses to run.

/** What the migration does with one collection. Every defined collection must have one. */
export interface CollectionRule {
  /** Left behind, and why. */
  skip?: string;
  /** Where collections share a folder: the only ids that are this one's. */
  only?: readonly string[];
  /** Where collections share a folder: ids that are another's. */
  except?: readonly string[];
  /**
   * How long a record lives after its last use, where the server sweeps it by age and the spec
   * has no `db.ttlMs` saying so. A record past it is not moved.
   */
  ttlMs?: number;
  /** A record that lives and dies with something else, not by its own age. */
  follows?: 'job' | 'output' | 'media-folder' | 'upload-folder';
}

/**
 * The migration's decision for each collection, by name (and kind). A collection defined in the
 * code and missing here stops the migration: someone has to say whether and how it moves.
 */
export const COLLECTION_RULES: Readonly<Record<string, CollectionRule>> = {
  timelines: { ttlMs: KEEP_MS.timeline },
  blobs: {
    skip: 'an object store’s own count of holders and last uses: no filesystem data root has any, and the target makes its own as files are stored',
  },
  'gone/timeline': {},
  'gone/media': {},
  outputs: { follows: 'output' },
  floor: { only: ['floor'], ttlMs: KEEP_MS.media },
  uploads: { follows: 'upload-folder' },
  calls: {},
  usage: { skip: 'legacy counts nothing reads or writes; the sweep only removes them' },
  funnel: {},
  account_claims: { only: ['free-credits'] },
  account_onboarding: { only: ['onboarding'] },
  account_apps: { only: ['apps'] },
  meter: {},
  support_messages: {},
  jobs: { follows: 'job' },
  job_cancels: { follows: 'job' },
  job_keys: {},
  media: { follows: 'media-folder' },
  media_index: { ttlMs: KEEP_MS.media },
  rights: {},
  ledger_spent: {},
  ledger_links: { only: ['link'] },
  notices: {},
  partners: {},
  keys: {},
  keys_listed: {},
  admin_keys: {},
  admin_keys_listed: {},
  email_slots: { except: ['unsubscribed'] },
  email_unsubscribed: { only: ['unsubscribed'] },
  email_suppressions: {},
  email_log: {},
};

/** Folders and files under the data root that are not moved, and why. */
export const NOT_MOVED_ROOT: Readonly<Record<string, string>> = {
  models: 'downloaded models, fetched again on the new node',
  cache: 'derived and disposable (cached frames)',
  'secret.key': 'the link-signing key, which goes into CUTTINGFLOOR_URL_SECRET by hand',
  code: 'legacy code.run scratch; nothing reads it',
};

/** Folders under an owner's folder that are not moved, and why. */
export const NOT_MOVED_OWNER: Readonly<Record<string, string>> = {
  code: 'legacy code.run scratch; nothing reads it',
};

export const specKey = (spec: CollectionSpec<unknown>) =>
  spec.kind ? `${spec.name}/${spec.kind}` : spec.name;

/**
 * Whether an id is this collection's where collections share a folder (a filesystem store lists
 * every record in the folder under each of them).
 */
export function ownsId(spec: CollectionSpec<unknown>, id: string): boolean {
  const rule = COLLECTION_RULES[specKey(spec)];
  if (rule?.only && !rule.only.includes(id)) return false;
  return !rule?.except?.includes(id);
}

const isLog = (spec: CollectionSpec<unknown>) => spec.fs.ext === '.jsonl';
const OWNER = /^[A-Za-z0-9_-]{1,64}$/;
const PARENT = '\0parent\0';

/** A file the server is still writing: it takes its real name by a rename when whole. */
export function isTemp(name: string): boolean {
  return /\.tmp(\.[A-Za-z0-9]{1,8})?$/.test(name) || name.endsWith('.part');
}

/** An id as the stores take one: a single name, not hidden. */
const named = (id: string) => Boolean(id) && !/[/\\\0]/.test(id) && !id.startsWith('.');

export interface FileStat {
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
  nlink: number;
}

interface Base extends FileStat {
  /** The file's place under the data root, `/` between its parts. For a blob, its key. */
  rel: string;
}

export interface RecordItem extends Base {
  type: 'record';
  spec: CollectionSpec<unknown>;
  owner?: string;
  parent?: string;
  id: string;
}

export interface LogItem extends Base {
  type: 'log';
  spec: CollectionSpec<unknown>;
  owner?: string;
  part: string;
}

export interface BlobItem extends Base {
  type: 'blob';
  owner: string;
  area: 'media' | 'uploads' | 'outputs';
  /** The media, upload, job or frame set it belongs to. */
  holder: string;
  /** Its place inside the holder's folder. */
  name: string[];
}

export interface LeftItem extends Base {
  type: 'left';
  owner?: string;
  why: string;
}

export interface UnknownItem {
  type: 'unknown';
  rel: string;
  why: string;
}

export type Item = RecordItem | LogItem | BlobItem | LeftItem;

export interface Layout {
  owners: string[];
  records: RecordItem[];
  logs: LogItem[];
  blobs: BlobItem[];
  left: LeftItem[];
  unknown: UnknownItem[];
  /** mtime of each folder a blob store ages things by: `owners/{o}/uploads/{id}` and `…/outputs/{id}`. */
  folders: Map<string, number>;
  /** Top-level folders and files left behind whole, with why. */
  leftWhole: Array<{ rel: string; why: string }>;
}

interface Shape {
  spec: CollectionSpec<unknown>;
  rule: CollectionRule;
  /** The folder's parts, `PARENT` where the parent's name goes. */
  dir: string[];
}

/** The rule of every collection given, or the names of those that have none. */
export function rulesFor(specs: readonly CollectionSpec<unknown>[]): {
  shapes: Shape[];
  missing: string[];
} {
  const shapes: Shape[] = [];
  const missing: string[] = [];
  for (const spec of specs) {
    const rule = COLLECTION_RULES[specKey(spec)];
    if (!rule) {
      missing.push(specKey(spec));
      continue;
    }
    const dir = (typeof spec.fs.dir === 'function' ? spec.fs.dir(PARENT) : spec.fs.dir)
      .split('/')
      .filter(Boolean);
    if (!dir.length && !rule.only) {
      missing.push(`${specKey(spec)} (kept among an owner's other things: needs its ids named)`);
      continue;
    }
    shapes.push({ spec, rule, dir });
  }
  return { shapes, missing };
}

/** Whether `parts` (a path under the owner's folder, or the root) is a record of this collection. */
function match(
  shape: Shape,
  parts: string[],
): { id: string; parent?: string; log: boolean } | undefined {
  const { spec, rule, dir } = shape;
  const tail = spec.fs.leaf ? 2 : 1;
  if (parts.length !== dir.length + tail) return undefined;
  let parent: string | undefined;
  for (let i = 0; i < dir.length; i += 1) {
    if (dir[i] === PARENT) {
      parent = parts[i];
      if (!parent || !named(parent)) return undefined;
    } else if (dir[i] !== parts[i]) return undefined;
  }
  let id: string;
  if (spec.fs.leaf) {
    if (parts[dir.length + 1] !== spec.fs.leaf) return undefined;
    id = parts[dir.length] ?? '';
  } else {
    const ext = spec.fs.ext ?? '.json';
    const file = parts[dir.length] ?? '';
    if (!file.endsWith(ext)) return undefined;
    id = file.slice(0, -ext.length);
  }
  if (!named(id)) return undefined;
  if (rule.only && !rule.only.includes(id)) return undefined;
  if (rule.except?.includes(id)) return undefined;
  return { id, ...(parent ? { parent } : {}), log: isLog(spec) };
}

/**
 * Walks a data root and names every file in it. Reads nothing but folder listings and file
 * stats, so it leaves no trace on the source. A file that vanishes between its listing and its
 * stat is simply not there.
 */
export async function readLayout(
  root: string,
  specs: readonly CollectionSpec<unknown>[],
  options: { ignore?: readonly string[] } = {},
): Promise<Layout & { missingRules: string[] }> {
  const { shapes, missing } = rulesFor(specs);
  const ownerShapes = shapes.filter((s) => s.spec.scope === 'owner');
  const globalShapes = shapes.filter((s) => s.spec.scope === 'global');
  const out: Layout & { missingRules: string[] } = {
    owners: [],
    records: [],
    logs: [],
    blobs: [],
    left: [],
    unknown: [],
    folders: new Map(),
    leftWhole: [],
    missingRules: missing,
  };
  const ignored = (rel: string) =>
    (options.ignore ?? []).some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));

  const classify = (
    scoped: Shape[],
    parts: string[],
    rel: string,
    stat: FileStat,
    owner: string | undefined,
  ): boolean => {
    const found = scoped
      .map((shape) => ({ shape, hit: match(shape, parts) }))
      .filter((m): m is { shape: Shape; hit: NonNullable<ReturnType<typeof match>> } =>
        Boolean(m.hit),
      );
    if (!found.length) return false;
    if (found.length > 1) {
      out.unknown.push({
        type: 'unknown',
        rel,
        why: `claimed by ${found.map((f) => specKey(f.shape.spec)).join(' and ')}`,
      });
      return true;
    }
    const { shape, hit } = found[0] as (typeof found)[number];
    const base = { rel, ...stat, ...(owner ? { owner } : {}) };
    if (shape.rule.skip) out.left.push({ type: 'left', ...base, why: shape.rule.skip });
    else if (hit.log) out.logs.push({ type: 'log', ...base, spec: shape.spec, part: hit.id });
    else {
      out.records.push({
        type: 'record',
        ...base,
        spec: shape.spec,
        id: hit.id,
        ...(hit.parent ? { parent: hit.parent } : {}),
      });
    }
    return true;
  };

  /** Every file under `dir`, with its path parts under `from`. */
  async function* files(dir: string, parts: string[]): AsyncGenerator<[string[], FileStat]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = [...parts, e.name];
      if (e.isDirectory()) yield* files(join(dir, e.name), next);
      else {
        const s = await lstat(join(dir, e.name)).catch(() => undefined);
        if (!s) continue;
        if (!s.isFile()) {
          yield [next, { size: -1, mtimeMs: 0, ino: 0, dev: 0, nlink: 0 }];
          continue;
        }
        yield [next, { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino, dev: s.dev, nlink: s.nlink }];
      }
    }
  }

  const top = await readdir(root, { withFileTypes: true });
  for (const e of top.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (ignored(e.name)) {
      out.leftWhole.push({ rel: e.name, why: 'ignored by --ignore' });
      continue;
    }
    const why = NOT_MOVED_ROOT[e.name];
    if (why) {
      out.leftWhole.push({ rel: e.name, why });
      continue;
    }
    if (e.name === 'owners' && e.isDirectory()) continue;
    if (!e.isDirectory()) {
      out.unknown.push({ type: 'unknown', rel: e.name, why: 'a file in the data root' });
      continue;
    }
    if (!globalShapes.some((s) => s.dir[0] === e.name)) {
      out.unknown.push({ type: 'unknown', rel: `${e.name}/`, why: 'a folder no collection has' });
      continue;
    }
    for await (const [parts, stat] of files(join(root, e.name), [e.name])) {
      const rel = parts.join('/');
      if (ignored(rel)) continue;
      const name = parts[parts.length - 1] ?? '';
      if (stat.size < 0) out.unknown.push({ type: 'unknown', rel, why: 'not a regular file' });
      else if (isTemp(name)) out.left.push({ type: 'left', rel, ...stat, why: 'being written' });
      else if (!classify(globalShapes, parts, rel, stat, undefined)) {
        out.unknown.push({ type: 'unknown', rel, why: 'no collection keeps a record here' });
      }
    }
  }

  const ownerNames = await readdir(join(root, 'owners'), { withFileTypes: true }).catch(() => []);
  for (const o of ownerNames.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const ownerRel = `owners/${o.name}`;
    if (ignored(ownerRel)) {
      out.leftWhole.push({ rel: ownerRel, why: 'ignored by --ignore' });
      continue;
    }
    if (!o.isDirectory() || !OWNER.test(o.name)) {
      out.unknown.push({ type: 'unknown', rel: ownerRel, why: 'not an owner folder' });
      continue;
    }
    const owner = o.name;
    out.owners.push(owner);
    const ownerDir = join(root, 'owners', owner);
    for await (const [parts, stat] of files(ownerDir, [])) {
      const rel = `${ownerRel}/${parts.join('/')}`;
      if (ignored(rel) || ignored(`${ownerRel}/${parts[0]}`)) continue;
      const name = parts[parts.length - 1] ?? '';
      const area = parts[0] ?? '';
      const leftWhy = NOT_MOVED_OWNER[area];
      if (stat.size < 0) out.unknown.push({ type: 'unknown', rel, why: 'not a regular file' });
      else if (leftWhy && parts.length > 1) {
        out.left.push({ type: 'left', rel, owner, ...stat, why: leftWhy });
      } else if (isTemp(name)) {
        out.left.push({ type: 'left', rel, owner, ...stat, why: 'being written' });
      } else if (classify(ownerShapes, parts, rel, stat, owner)) {
        // A record, a log part, or a legacy record left behind.
      } else if (
        (area === 'media' || area === 'uploads' || area === 'outputs') &&
        parts.length >= 3 &&
        named(parts[1] ?? '')
      ) {
        out.blobs.push({
          type: 'blob',
          rel,
          owner,
          area,
          holder: parts[1] as string,
          name: parts.slice(2),
          ...stat,
        });
      } else out.unknown.push({ type: 'unknown', rel, why: 'nothing the server keeps here' });
    }
    for (const area of ['uploads', 'outputs']) {
      const holders = await readdir(join(ownerDir, area), { withFileTypes: true }).catch(() => []);
      for (const h of holders) {
        if (!h.isDirectory()) continue;
        const s = await lstat(join(ownerDir, area, h.name)).catch(() => undefined);
        if (s) out.folders.set(`${ownerRel}/${area}/${h.name}`, s.mtimeMs);
      }
    }
  }
  return out;
}

/** An owner's key as reports show it: never the key itself. */
export function ownerTag(owner: string): string {
  return `o:${createHash('sha256').update(owner).digest('hex').slice(0, 10)}`;
}

/** An id as reports show it: whole when it is one of the server's own, else its first characters. */
export function idTag(id: string): string {
  if (/^[a-z]_[0-9a-z]{26}(\.[a-z]{1,8})?$/.test(id) || id.length <= 16) return id;
  return `${id.slice(0, 12)}…`;
}

/** A file's place as reports show it: the owner hashed, ids kept, a user's own file name hashed. */
export function relTag(rel: string): string {
  const parts = rel.split('/');
  if (parts[0] !== 'owners' || parts.length < 2) {
    return parts.map((p, i) => (i === parts.length - 1 ? idTag(p) : p)).join('/');
  }
  const [, owner, area, holder, ...rest] = parts as [string, string, ...string[]];
  const shown = [ownerTag(owner)];
  if (area !== undefined) shown.push(holder === undefined ? idTag(area) : area);
  if (holder !== undefined) shown.push(idTag(holder));
  if (rest.length) {
    if (area === 'outputs') {
      const file = rest.join('/');
      const ext = /\.[A-Za-z0-9]{1,8}$/.exec(file)?.[0] ?? '';
      shown.push(`#${createHash('sha256').update(file).digest('hex').slice(0, 8)}${ext}`);
    } else shown.push(...rest.map(idTag));
  }
  return shown.join('/');
}
