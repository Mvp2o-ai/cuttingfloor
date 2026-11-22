import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectionSpec, RecordEntry } from '@cuttingfloor/core';
import { COLLECTION_RULES, ownerTag, ownsId, relTag, specKey } from './layout.ts';
import type { Manifest } from './manifest.ts';
import { atTarget, hashStream, logEntries, pool, sameTime, slot, stable } from './pass.ts';
import { type Plan, type PlannedRecord, readRecord, type Source } from './plan.ts';
import type { MigrationTarget } from './target.ts';

// Whether the target holds what the source does: every record field by field, every log entry,
// every blob by size and SHA-256, each owner's stored bytes, the folders' ages, and signed links
// already handed out. It reads both sides and writes to neither.

export interface Difference {
  /** `record-missing`, `record-differs`, `record-time`, `record-extra`, `log`, `blob-missing`,
   * `blob-size`, `blob-sha256`, `blob-extra`, `upload-offset`, `usage`, `age`, `link`. */
  kind: string;
  /** The collection or kind of file. */
  of: string;
  /** Which one, as reports name things (owner hashed, ids). */
  where: string;
  detail?: string;
}

export interface VerifyReport {
  checked_at: string;
  records: Record<string, { source: number; target: number; same: number }>;
  logs: { source_entries: number; target_entries: number };
  blobs: Record<string, { source: number; same: number; bytes: number }>;
  owners: Array<{
    owner: string;
    /** `blobs.usage` at the source: everything in the owner's folder, records and all. */
    source_usage: number;
    /** The bytes of the files moved, shared ones once. */
    expected: number;
    /** `blobs.usage` at the target, less its record files. */
    target: number;
  }>;
  links: { found: number; checked: number; dead_at_source: number; broken: number };
  /** Things that changed at the source since the pass, so cannot be compared yet. */
  waiting: Array<{ what: string; why: string }>;
  differences: Difference[];
  notes: string[];
}

export interface VerifyOptions {
  links: number | 'all';
  /** `sha`: read back a blob whose store keeps no hash. `size`: trust its size then. */
  blobCheck: 'sha' | 'size';
  concurrency: number;
  log: (line: string) => void;
}

/**
 * A signed output link as the server writes it (runtime.ts SIGNED_LINK): /outputs/ or /watch/,
 * owner key, id, file name. Only what it names is read; a link is never printed.
 */
const SIGNED_LINK =
  /https?:\/\/[^/\s"\\]+\/(?:outputs|watch)\/([A-Za-z0-9_-]{1,64})\/((?:j|f|m)_[0-9a-z]{26})\/([^/?\s"\\]+)\?exp=\d+&sig=[A-Za-z0-9_-]+/g;

const isLog = (spec: CollectionSpec<unknown>) => spec.fs.ext === '.jsonl';

/** The top-level fields in which two records differ. Names only, never values. */
function fieldsDiffering(a: unknown, b: unknown): string[] {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a)) {
    return stable(a) === stable(b) ? [] : ['(the whole record)'];
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const out: string[] = [];
  for (const field of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (left[field] === undefined && right[field] === undefined) continue;
    if (
      stable(left[field] ?? null) !== stable(right[field] ?? null) ||
      (left[field] === undefined) !== (right[field] === undefined)
    )
      out.push(field);
  }
  return out;
}

export async function verify(
  source: Source,
  target: MigrationTarget,
  plan: Plan,
  manifest: Manifest,
  options: VerifyOptions,
): Promise<VerifyReport> {
  const report: VerifyReport = {
    checked_at: new Date().toISOString(),
    records: {},
    logs: { source_entries: 0, target_entries: 0 },
    blobs: {},
    owners: [],
    links: { found: 0, checked: 0, dead_at_source: 0, broken: 0 },
    waiting: [],
    differences: [],
    notes: [],
  };
  const differ = (kind: string, of: string, where: string, detail?: string) =>
    report.differences.push({ kind, of, where, ...(detail ? { detail } : {}) });
  const wait = (what: string, why: string) => report.waiting.push({ what, why });
  const { log } = options;

  // ---- Records ---------------------------------------------------------------------------

  const moving = plan.specs.filter((spec) => !isLog(spec));
  const sourceByScope = new Map<string, PlannedRecord[]>();
  const scopeOf = (spec: CollectionSpec<unknown>, owner?: string, parent?: string) =>
    `${specKey(spec)}|${owner ?? ''}|${parent ?? ''}`;
  for (const r of plan.records) {
    const at = scopeOf(r.item.spec, r.item.owner, r.item.parent);
    const list = sourceByScope.get(at) ?? [];
    list.push(r);
    sourceByScope.set(at, list);
  }
  const targetOwners = await target.records.owners();
  const owners = [...new Set([...plan.layout.owners, ...manifest.owners, ...targetOwners])].sort();
  const scopes: Array<{ spec: CollectionSpec<unknown>; owner?: string; parent?: string }> = [];
  for (const spec of moving) {
    // A collection left behind on purpose has nothing at either side to compare.
    if (COLLECTION_RULES[specKey(spec)]?.skip) continue;
    const grouped = typeof spec.fs.dir === 'function';
    for (const owner of spec.scope === 'owner' ? owners : [undefined]) {
      if (!grouped) {
        scopes.push({ spec, ...(owner ? { owner } : {}) });
        continue;
      }
      const parents = new Set(await target.records.parents(spec, owner ? { owner } : {}));
      for (const r of plan.records) {
        if (r.item.spec === spec && r.item.owner === owner && r.item.parent) {
          parents.add(r.item.parent);
        }
      }
      for (const parent of parents) scopes.push({ spec, parent, ...(owner ? { owner } : {}) });
    }
  }
  const mediaFiles = new Map<string, string>();
  const linksFound = new Map<string, { owner: string; id: string; name: string }>();
  await pool(scopes, options.concurrency, async ({ spec, owner, parent }) => {
    const name = specKey(spec);
    const counts = slot(report.records, name, () => ({ source: 0, target: 0, same: 0 }));
    const there = new Map<string, RecordEntry<unknown>>(
      (
        await target.records
          .collection(spec, { ...(owner ? { owner } : {}), ...(parent ? { parent } : {}) })
          .find()
      )
        .filter((entry) => ownsId(spec, entry.id))
        .map((entry) => [entry.id, entry]),
    );
    counts.target += there.size;
    const here = sourceByScope.get(scopeOf(spec, owner, parent)) ?? [];
    const seen = new Set<string>();
    for (const r of here) {
      const { item } = r;
      const where = `${relTag(item.rel)}`;
      seen.add(item.id);
      const read = await readRecord(source, item);
      if (read.state === 'gone') continue;
      counts.source += 1;
      if (read.state === 'unreadable') {
        wait(`${name} ${where}`, `the record ${read.why}`);
        continue;
      }
      if (name === 'jobs' || name === 'email_log') {
        for (const m of JSON.stringify(read.value).matchAll(SIGNED_LINK)) {
          const [, linkOwner = '', id = '', file = ''] = m;
          let decoded = file;
          try {
            decoded = decodeURIComponent(file);
          } catch {}
          linksFound.set(`${linkOwner}/${id}/${decoded}`, { owner: linkOwner, id, name: decoded });
        }
      }
      const known = manifest.records[r.key];
      if (!known || known.mtime_ms !== read.stat.mtimeMs) {
        wait(`${name} ${where}`, known ? 'changed at the source since the pass' : 'not moved yet');
        continue;
      }
      const mapped = atTarget(item, read.value, manifest, plan);
      if ('wait' in mapped) {
        wait(`${name} ${where}`, mapped.wait);
        continue;
      }
      if (name === 'media' && item.owner) {
        const file = (mapped.value as { file?: unknown }).file;
        if (typeof file === 'string') mediaFiles.set(`${item.owner}/${item.id}`, file);
      }
      const got = there.get(item.id);
      if (!got) {
        differ('record-missing', name, where);
        continue;
      }
      const fields = fieldsDiffering(mapped.value, got.value);
      if (fields.length) differ('record-differs', name, where, `fields: ${fields.join(', ')}`);
      else if (!sameTime(got.usedAt.getTime(), read.stat.mtimeMs)) {
        differ(
          'record-time',
          name,
          where,
          `last use ${new Date(read.stat.mtimeMs).toISOString()} at the source, ${got.usedAt.toISOString()} at the target`,
        );
      } else counts.same += 1;
    }
    for (const id of there.keys()) {
      if (seen.has(id)) continue;
      differ(
        'record-extra',
        name,
        `${owner ? `${ownerTag(owner)}/` : ''}${parent ? `${parent}/` : ''}${id.length > 34 ? `${id.slice(0, 12)}…` : id}`,
      );
    }
  });
  for (const [name, c] of Object.entries(report.records).sort()) {
    log(
      `verify records ${name}: ${c.source} at the source, ${c.target} at the target, ${c.same} the same`,
    );
  }

  // ---- Logs ------------------------------------------------------------------------------

  const logSpecs = plan.specs.filter(isLog);
  for (const spec of logSpecs) {
    const ttlMs = spec.db?.ttlMs;
    for (const owner of spec.scope === 'owner' ? owners : [undefined]) {
      const parts = plan.logs.filter((l) => l.item.spec === spec && l.item.owner === owner);
      const want = new Map<string, number>();
      let moved = true;
      for (const part of parts) {
        const file = join(source.root, ...part.item.rel.split('/'));
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of await source.blobs.get(part.item.rel))
            chunks.push(chunk as Buffer);
        } catch {
          continue;
        }
        const now = await lstat(file).catch(() => undefined);
        const known = manifest.logs[part.item.rel];
        if (!now || !known || known.size !== now.size || known.mtime_ms !== now.mtimeMs) {
          moved = false;
          break;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        for (const { entry } of logEntries(text, now.mtime, ttlMs, plan.now)) {
          const key = stable(entry);
          want.set(key, (want.get(key) ?? 0) + 1);
        }
      }
      const where = `${specKey(spec)}${owner ? ` ${ownerTag(owner)}` : ''}`;
      if (!moved) {
        wait(where, 'the log grew at the source since the pass');
        continue;
      }
      const got = new Map<string, number>();
      for (const entry of await target.records.log(spec, owner ? { owner } : {}).read()) {
        const at = Date.parse(String((entry as { at?: unknown } | null)?.at));
        if (ttlMs !== undefined && !Number.isNaN(at) && at + ttlMs < plan.now) continue;
        const key = stable(entry);
        got.set(key, (got.get(key) ?? 0) + 1);
      }
      let missing = 0;
      let extra = 0;
      let wanted = 0;
      let had = 0;
      for (const [key, n] of want) {
        wanted += n;
        missing += Math.max(0, n - (got.get(key) ?? 0));
      }
      for (const [key, n] of got) {
        had += n;
        extra += Math.max(0, n - (want.get(key) ?? 0));
      }
      report.logs.source_entries += wanted;
      report.logs.target_entries += had;
      if (missing || extra) {
        differ(
          'log',
          specKey(spec),
          where,
          `${missing} entries missing, ${extra} extra at the target`,
        );
      }
    }
  }
  if (logSpecs.length) {
    log(
      `verify logs: ${report.logs.source_entries} entries at the source, ${report.logs.target_entries} at the target`,
    );
  }

  // ---- Blobs -----------------------------------------------------------------------------

  const expected = new Set<string>();
  const waitingOwners = new Set<string>();
  const shas = new Map<string, Promise<string>>();
  const usage = new Map<string, { bytes: number; seen: Set<string> }>();
  const count = (owner: string, link: string, bytes: number) => {
    const u = usage.get(owner) ?? { bytes: 0, seen: new Set<string>() };
    usage.set(owner, u);
    if (u.seen.has(link)) return;
    u.seen.add(link);
    u.bytes += bytes;
  };
  await pool(plan.blobs, options.concurrency, async (b) => {
    const { item, kind } = b;
    const where = relTag(item.rel);
    // Its place at the target is its own, whether or not its bytes are there yet.
    expected.add(b.targetKey);
    const counts = slot(report.blobs, kind, () => ({ source: 0, same: 0, bytes: 0 }));
    counts.source += 1;
    counts.bytes += item.size;
    const now = await lstat(join(source.root, ...item.rel.split('/'))).catch(() => undefined);
    if (!now) return;
    const moved = (e: { size: number; mtime_ms: number } | undefined) =>
      Boolean(e && e.size === now.size && e.mtime_ms === now.mtimeMs);
    if (b.partway) {
      const carried = manifest.partway[item.rel];
      if (carried) expected.add(carried.target);
      if (!carried || !moved(carried)) {
        waitingOwners.add(item.owner);
        wait(where, carried ? 'the upload grew at the source since the pass' : 'not moved yet');
        return;
      }
      const sent = carried.parts.reduce((sum, part) => sum + part.bytes, 0);
      const head = await target.blobs.head(carried.target);
      if (sent !== carried.offset || (head && head.bytes !== carried.offset)) {
        differ(
          'upload-offset',
          kind,
          where,
          `the sender resumes at ${carried.offset}; the target holds ${head ? head.bytes : sent} bytes`,
        );
      } else counts.same += 1;
      if (head) count(item.owner, `p:${item.rel}`, head.bytes);
      return;
    }
    const entry = manifest.blobs[item.rel];
    if (entry) expected.add(entry.target);
    if (b.wait || !entry || !moved(entry)) {
      waitingOwners.add(item.owner);
      wait(where, b.wait ?? (entry ? 'changed at the source since the pass' : 'not moved yet'));
      return;
    }
    count(item.owner, item.nlink > 1 ? `${item.dev}:${item.ino}` : `f:${item.rel}`, item.size);
    const head = await target.blobs.head(entry.target);
    if (!head) return void differ('blob-missing', kind, where);
    if (head.bytes !== item.size) {
      return void differ(
        'blob-size',
        kind,
        where,
        `${item.size} bytes at the source, ${head.bytes} at the target`,
      );
    }
    if (head.sha256 === undefined && options.blobCheck === 'size') {
      counts.same += 1;
      return;
    }
    let sha = shas.get(entry.target);
    if (!sha) {
      sha = head.sha256
        ? Promise.resolve(head.sha256)
        : target.blobs.get(entry.target).then((s) => hashStream(s));
      shas.set(entry.target, sha);
    }
    if ((await sha) !== entry.sha256) differ('blob-sha256', kind, where);
    else counts.same += 1;
  });
  for (const [kind, c] of Object.entries(report.blobs).sort()) {
    log(`verify blobs ${kind}: ${c.source} at the source, ${c.same} the same at the target`);
  }

  // ---- Each owner's files: nothing extra, and the same stored bytes -----------------------

  const recordFiles = await target.recordFiles(plan.specs);
  for (const owner of owners) {
    const prefix = target.blobs.keys.owner(owner);
    let recordBytes = 0;
    for (const head of await target.blobs.list(prefix)) {
      const size = recordFiles.get(head.key);
      if (size !== undefined) {
        // What `usage` leaves out of its count already.
        if (!/^owners\/[^/]+\/(calls|outputs-index)\//.test(head.key)) recordBytes += size;
        continue;
      }
      if (!expected.has(head.key)) differ('blob-extra', 'blob', relTag(head.key));
    }
    if (!plan.layout.owners.includes(owner)) continue;
    const row = {
      owner: ownerTag(owner),
      source_usage: await source.blobs.usage(owner),
      expected: usage.get(owner)?.bytes ?? 0,
      target: (await target.blobs.usage(owner)) - recordBytes,
    };
    report.owners.push(row);
    if (waitingOwners.has(owner)) continue;
    if (row.expected !== row.target) {
      differ(
        'usage',
        'owner',
        row.owner,
        `${row.expected} bytes moved, ${row.target} stored at the target`,
      );
    }
  }
  log(
    `verify owners: ${report.owners.length} checked, ${report.differences.filter((d) => d.kind === 'usage').length} with other stored bytes at the target`,
  );

  // ---- Ages --------------------------------------------------------------------------------

  if (target.getBlobTime) {
    for (const folder of plan.folders) {
      const there = await target.getBlobTime(folder.target);
      const holds = plan.blobs.some((b) => b.item.rel.startsWith(`${folder.rel}/`) && !b.wait);
      if (manifest.folders[folder.rel] !== folder.mtimeMs) {
        if (holds) wait(relTag(folder.rel), 'changed at the source since the pass');
      } else if (there ? !sameTime(there.getTime(), folder.mtimeMs) : holds) {
        differ(
          'age',
          'folder',
          relTag(folder.rel),
          `written ${new Date(folder.mtimeMs).toISOString()} at the source, ${there?.toISOString() ?? 'missing'} at the target`,
        );
      }
    }
  } else {
    report.notes.push(
      'The target blob store cannot say how old a file is, so the ages of uploads and kept frames were not compared.',
    );
  }

  // ---- Links already handed out --------------------------------------------------------------

  const live = new Set(plan.blobs.map((b) => b.item.rel));
  const all = [...linksFound.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, link]) => link);
  report.links.found = all.length;
  const take = options.links === 'all' ? all.length : Math.min(all.length, options.links);
  const sample =
    take >= all.length
      ? all
      : all.filter(
          (_, i) =>
            Math.floor((i * take) / all.length) !== Math.floor(((i - 1) * take) / all.length),
        );
  for (const link of sample) {
    report.links.checked += 1;
    const where = `${ownerTag(link.owner)}/${link.id}`;
    let key: string | undefined;
    if (link.id.startsWith('m_')) key = mediaFiles.get(`${link.owner}/${link.id}`);
    else {
      const rel = `owners/${link.owner}/outputs/${link.id}/${link.name}`;
      if (live.has(rel)) {
        key = manifest.blobs[rel]?.target;
        if (!key) {
          wait(`link ${where}`, 'its file is not moved yet');
          continue;
        }
      }
    }
    if (!key) {
      report.links.dead_at_source += 1;
      continue;
    }
    if (!(await target.blobs.head(key))) {
      report.links.broken += 1;
      differ(
        'link',
        'link',
        where,
        'a link already handed out names a file the target does not hold',
      );
    }
  }
  log(
    `verify links: ${report.links.found} found in job results and the email log, ${report.links.checked} checked, ${report.links.dead_at_source} to files the source no longer keeps, ${report.links.broken} broken`,
  );
  return report;
}

/** The differences as a short table: how many of each kind, in what. */
export function differenceTable(differences: readonly Difference[]): string[] {
  const rows = new Map<string, { n: number; first: string }>();
  for (const d of differences) {
    const key = `${d.kind}\0${d.of}`;
    const row = rows.get(key) ?? { n: 0, first: `${d.where}${d.detail ? ` (${d.detail})` : ''}` };
    row.n += 1;
    rows.set(key, row);
  }
  const lines = ['kind             of                    count  first'];
  for (const [key, row] of [...rows].sort()) {
    const [kind = '', of = ''] = key.split('\0');
    lines.push(`${kind.padEnd(16)} ${of.padEnd(21)} ${String(row.n).padStart(5)}  ${row.first}`);
  }
  return lines;
}
