import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type CollectionSpec, definedCollections } from '@cuttingfloor/core';
import { DRAIN_MARKER, type DrainMarker } from '../drain.ts';
import { MIGRATION } from '../live.ts';
import { serverUrlKey } from '../url-key.ts';
import { rereadBlobs, type Sample } from './checks.ts';
import { COLLECTION_RULES, relTag, specKey } from './layout.ts';
import { loadManifest, saveManifest } from './manifest.ts';
import { bytesText, errorText, Interrupted, type PassState, runPass, slot } from './pass.ts';
import { buildPlan, openSource, type Plan } from './plan.ts';
import { type MigrationTarget, within } from './target.ts';
import { differenceTable, findExtras, type VerifyReport, verify } from './verify.ts';

export { COLLECTION_RULES, NOT_MOVED_OWNER, NOT_MOVED_ROOT, readLayout } from './layout.ts';
export { type Manifest, manifestPath } from './manifest.ts';
export { Throttle } from './pass.ts';
export { buildPlan, openSource } from './plan.ts';
export {
  blobTargetFromEnv,
  fsTarget,
  type MigrationTarget,
  s3Target,
  targetFromEnv,
} from './target.ts';
export {
  carryPartway,
  PARTWAY_FIELDS,
  partwayRecord,
  resumableOffset,
  UPLOAD_PART_BYTES,
} from './uploads.ts';
export type { Difference, VerifyReport } from './verify.ts';

// Moves a live filesystem data root into a target record store and blob store, pass by pass.
// scripts/migrate-storage.ts is its command line; scripts/migrate-storage.md is how to run it.

export const EXIT = {
  ok: 0,
  /** A write failed, or the run itself broke. Run it again. */
  failed: 1,
  /** Refused before writing anything: a file it cannot name, a path import, a collection with no rule. */
  refused: 2,
  /** The target differs from the source (or holds a record too big for it). */
  differs: 3,
  /** Things changed under the pass and wait for the next one. Normal while the source is live. */
  waiting: 4,
  /** More had gone from the source than a pass removes unasked. */
  deletesRefused: 5,
  interrupted: 6,
} as const;

export interface MigrateOptions {
  /** The source data root. Only ever read. */
  source: string;
  target: MigrationTarget;
  /** Where the manifest and reports are kept. Never under the source. */
  stateDir: string;
  /** Default: every collection defined in this process. */
  specs?: readonly CollectionSpec<unknown>[];
  mode?: 'pass' | 'dry-run' | 'verify';
  /** Verify after a pass. Default true. */
  verify?: boolean;
  /** Writes have stopped at the source: nothing may be left waiting. */
  final?: boolean;
  /**
   * A pass after the final one ended clean, which is refused without this: by then the source
   * has stopped and its clocks say everything is expiring. Only to put right a final pass that
   * was wrong, before any traffic moves.
   */
  afterFinal?: boolean;
  /**
   * The final pass reads the source server's draining marker (`draining` in its data root) and
   * refuses while it is missing, stale or says jobs still run. False skips that (tests; a source
   * no server runs on).
   */
  drainCheck?: boolean;
  /** Compare the target with the source for everything, and rewrite what differs. */
  repair?: boolean;
  /** With `repair`: remove at most this many things the target holds that the source does not. */
  pruneExtras?: number;
  /** Accounts left alone on both sides (a test account on the new server). */
  excludeOwners?: readonly string[];
  /**
   * Verify by reading files back from the target and hashing them against the manifest: all,
   * a share (under 1) or a count. Needs only the state folder and the target, not the source.
   */
  reread?: Sample;
  /** Media, outputs and uploads resolved through the app's own readers at the target. Default 20. */
  appReads?: Sample;
  /** The new server's link-key fingerprint (scripts/url-key-fingerprint.ts there). */
  targetKeyFingerprint?: string;
  /** The new server's address, to fetch a signed download and upload link from. */
  targetUrl?: string;
  /** The key the source server signs with, when it is CUTTINGFLOOR_URL_SECRET (else secret.key). */
  sourceUrlSecret?: string;
  /** Run although the source holds far less than at the last pass. */
  allowShrink?: boolean;
  concurrency?: number;
  recordConcurrency?: number;
  bytesPerSecond?: number;
  /** The most things this pass may remove from the target, however large a share that is. */
  allowDeletes?: number;
  maxDeleteFraction?: number;
  links?: number | 'all';
  blobCheck?: 'sha' | 'size';
  settleMs?: number;
  outputTtlMs?: number;
  partBytes?: number;
  ignore?: readonly string[];
  rehash?: boolean;
  abortAfter?: number;
  signal?: AbortSignal;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MigrateSummary {
  mode: 'pass' | 'dry-run' | 'verify';
  started_at: string;
  ended_at: string;
  source: string;
  target: string;
  exit_code: number;
  exit: keyof typeof EXIT;
  refused?: {
    unknown: Array<{ path: string; why: string }>;
    no_rule: string[];
    path_imports: string[];
    /** Why the run was refused, when it was for something other than the files above. */
    why?: string;
  };
  records: PassState['records'];
  blobs: PassState['blobs'];
  logs: PassState['logs'];
  deletes: PassState['deletes'];
  oversize: PassState['oversize'];
  failed: PassState['failed'];
  waiting: Array<{ what: string; why: string }>;
  /** Records that could not be read whole: waiting, and nothing of theirs is removed. */
  unreadable: Array<{ what: string; why: string }>;
  extras?: { records: number; blobs: number; pruned: number };
  reread?: { checked: number; bytes: number };
  not_moved: {
    whole: Array<{ path: string; why: string }>;
    files: Record<string, { files: number; bytes: number }>;
    expired: Record<string, { files: number; bytes: number }>;
    orphans: Record<string, { files: number; bytes: number }>;
  };
  verify?: VerifyReport;
  notes: string[];
  /** Where the full reports were written. */
  files: { summary: string; verify?: string; manifest: string };
}

function notMoved(plan: Plan): MigrateSummary['not_moved'] {
  const tally = (
    into: Record<string, { files: number; bytes: number }>,
    key: string,
    size: number,
  ) => {
    const row = slot(into, key, () => ({ files: 0, bytes: 0 }));
    row.files += 1;
    row.bytes += size;
  };
  const out: MigrateSummary['not_moved'] = {
    whole: plan.layout.leftWhole.map(({ rel, why }) => ({ path: relTag(rel), why })),
    files: {},
    expired: {},
    orphans: {},
  };
  for (const left of plan.layout.left) tally(out.files, left.why, left.size);
  for (const s of plan.skipped)
    tally(s.why === 'expired' ? out.expired : out.orphans, s.what, s.size);
  return out;
}

/** The state folder's own mark of a final pass that ended clean. */
const FINAL_MARK = 'final.json';
/** A draining marker older than this is a server that stopped keeping it. */
const DRAIN_FRESH_MS = 2 * 60_000;
/** A source this much smaller than at the last pass (accounts, or bytes) is refused. */
const SHRINK_FRACTION = 0.2;

/** Whether the state folder can be written, before any work: a pass that cannot save is lost. */
async function writable(stateDir: string): Promise<void> {
  const probe = join(stateDir, `.write-check-${process.pid}`);
  try {
    await mkdir(stateDir, { recursive: true });
    await writeFile(probe, 'x', { mode: 0o600 });
    await rm(probe, { force: true });
  } catch (error) {
    throw new Error(
      `The state folder ${stateDir} cannot be written (${(error as NodeJS.ErrnoException).code ?? 'error'}): give it to the user the migration runs as (the image runs as uid 1000: chown -R 1000:1000 it)`,
    );
  }
}

/** The key the source signs links with: the one given, else its data root's secret.key. */
async function sourceKey(root: string, secret: string | undefined): Promise<Buffer | undefined> {
  return serverUrlKey({ urlSecret: secret, dataDir: root }).catch(() => undefined);
}

export async function migrate(options: MigrateOptions): Promise<MigrateSummary> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const mode = options.mode ?? 'pass';
  const sourceRoot = resolve(options.source);
  const stateDir = resolve(options.stateDir);
  if (within(sourceRoot, stateDir)) {
    throw new Error('The state folder is inside the source data root, which is only ever read');
  }
  await writable(stateDir);
  const { target } = options;
  const started = new Date();
  const now = options.now ?? Date.now;
  const source = openSource(sourceRoot);
  const specs = options.specs ?? definedCollections();
  const planOptions = {
    specs,
    ...(options.outputTtlMs !== undefined ? { outputTtlMs: options.outputTtlMs } : {}),
    settleMs: options.final ? 0 : (options.settleMs ?? 60_000),
    ...(options.ignore ? { ignore: options.ignore } : {}),
    ...(options.excludeOwners ? { excludeOwners: options.excludeOwners } : {}),
  };
  const files: MigrateSummary['files'] = {
    summary: join(stateDir, `summary-${mode}.json`),
    manifest: join(stateDir, 'manifest.json'),
  };
  const summary: MigrateSummary = {
    mode,
    started_at: started.toISOString(),
    ended_at: started.toISOString(),
    source: sourceRoot,
    target: target.name,
    exit_code: 0,
    exit: 'ok',
    records: {},
    blobs: {},
    logs: {},
    deletes: { planned: 0, done: 0, refused: false, of: 0 },
    oversize: [],
    failed: [],
    waiting: [],
    unreadable: [],
    not_moved: { whole: [], files: {}, expired: {}, orphans: {} },
    notes: [],
    files,
  };
  const finish = async (exit: keyof typeof EXIT): Promise<MigrateSummary> => {
    summary.exit = exit;
    summary.exit_code = EXIT[exit];
    summary.ended_at = new Date().toISOString();
    await mkdir(stateDir, { recursive: true });
    await writeFile(files.summary, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    log(`${mode} ended: ${exit} (exit ${summary.exit_code}). Summary: ${files.summary}`);
    return summary;
  };
  const refuse = (why: string) => {
    summary.refused = { unknown: [], no_rule: [], path_imports: [], why };
    log(`Refused: ${why}`);
    return finish('refused');
  };

  // ---- Reading the bucket back, beside it: the manifest and the target only ----------------

  if (mode === 'verify' && options.reread !== undefined) {
    const manifest = await loadManifest(stateDir, sourceRoot, target.name);
    if (!Object.keys(manifest.blobs).length) {
      return refuse(
        `the manifest in ${stateDir} names no files: copy the state folder from the old server`,
      );
    }
    log(`reread: files in ${target.name} against the hashes taken from the source`);
    const back = await rereadBlobs(target.blobs, manifest, {
      sample: options.reread,
      concurrency: Math.max(1, options.concurrency ?? 8),
      log,
    });
    summary.reread = { checked: back.checked, bytes: back.bytes };
    summary.verify = {
      checked_at: new Date().toISOString(),
      records: {},
      logs: { source_entries: 0, target_entries: 0 },
      blobs: {},
      owners: [],
      links: { found: 0, checked: 0, dead_at_source: 0, broken: 0 },
      waiting: [],
      differences: back.differences,
      notes: [],
    };
    log(
      `reread: ${back.checked} files, ${bytesText(back.bytes)} read back, ${back.differences.length} not as at the source`,
    );
    for (const line of differenceTable(back.differences))
      if (back.differences.length) log(`  ${line}`);
    return finish(back.differences.length ? 'differs' : 'ok');
  }

  log(`${mode}: ${sourceRoot} -> ${target.name}`);

  // ---- Whether this run may write at all ----------------------------------------------------

  if (options.final && options.verify === false) {
    return refuse(
      'the final pass is only clean once it is verified (records, files, links and the link-signing key): --final does not take --no-verify',
    );
  }
  if (mode !== 'verify') {
    const marks = target.records.collection(MIGRATION);
    // A mark that cannot be read stops the run: unread is not the same as not there.
    const live = await marks.get('live');
    if (live) {
      return refuse(
        `a server serves on the target (node ${live.node ?? '?'}, live since ${live.since ?? '?'}): a pass never writes into a store in use. Start that same node with CUTTINGFLOOR_STANDBY=1, which removes its mark, before passing again.`,
      );
    }
    const finalHere = await readFile(join(stateDir, FINAL_MARK), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const finalThere = await marks.get('final');
    if ((finalHere || finalThere) && !options.afterFinal) {
      return refuse(
        `the final pass already ended clean (${finalThere?.finished_at ?? 'in this state folder'}). The source stops changing at the switch, so a later pass would treat what it holds as expiring. Remove the cron. Only to put right a wrong final pass, before traffic moves: --after-final.`,
      );
    }
    if (options.final && options.drainCheck !== false) {
      const text = await readFile(join(sourceRoot, DRAIN_MARKER), 'utf8').catch(() => undefined);
      // The server rewrites the marker as it drains: one read part way is read as not there yet.
      let marker: DrainMarker | undefined;
      try {
        marker = text ? (JSON.parse(text) as DrainMarker) : undefined;
      } catch {
        marker = undefined;
      }
      const age = marker ? now() - Date.parse(marker.at) : Number.POSITIVE_INFINITY;
      if (!marker) {
        return refuse(
          'the source server is not draining (no draining marker in its data root): touch drain in the data root, wait for its jobs to end, then run --final',
        );
      }
      if (!(age < DRAIN_FRESH_MS)) {
        return refuse(
          `the source server's draining marker is ${Math.round(age / 1000)} s old: the server is not running or not keeping it`,
        );
      }
      if (marker.jobs_running > 0) {
        return refuse(
          `the source server still runs ${marker.jobs_running} jobs: wait until GET /healthz/drain says 0`,
        );
      }
    }
  }

  let plan: Plan;
  try {
    plan = await buildPlan(source, target.blobs.keys, { ...planOptions, now: now() });
  } catch (error) {
    // A folder or file that cannot be listed or read (not merely absent): nothing is done on a
    // half-seen source, least of all removing what it seems to lack.
    log(`The source could not be read: ${errorText(error)}`);
    summary.failed.push({ what: 'reading the source', why: errorText(error) });
    return finish('failed');
  }
  summary.not_moved = notMoved(plan);
  if (plan.unknown.length || plan.missingRules.length || plan.pathImports.length) {
    summary.refused = {
      unknown: plan.unknown.map((u) => ({ path: relTag(u.rel), why: u.why })),
      no_rule: plan.missingRules,
      path_imports: plan.pathImports,
    };
    for (const u of plan.unknown) log(`UNKNOWN ${relTag(u.rel)}: ${u.why}`);
    for (const name of plan.missingRules) {
      log(`NO RULE for collection ${name}: say in COLLECTION_RULES whether and how it moves`);
    }
    for (const where of plan.pathImports) {
      log(`PATH IMPORT ${where}: a media whose file is outside the data root cannot be moved`);
    }
    log(
      'Refused: nothing was written. Every file in the data root must be one the migration can name (--ignore <path> leaves one out, by name).',
    );
    return finish('refused');
  }

  // ---- Whether the source is a real data root, as large as it was ---------------------------

  const sourceBytes = plan.layout.blobs.reduce((sum, b) => sum + b.size, 0);
  const isRoot =
    (await stat(join(sourceRoot, 'owners')).then(
      (s) => s.isDirectory(),
      () => false,
    )) &&
    ((await stat(join(sourceRoot, 'secret.key')).then(
      () => true,
      () => false,
    )) ||
      (await stat(join(sourceRoot, 'keys')).then(
        (s) => s.isDirectory(),
        () => false,
      )));
  if (!plan.layout.owners.length || !isRoot) {
    return refuse(
      `${sourceRoot} does not look like a server's data root (${plan.layout.owners.length} accounts; it needs owners/ and secret.key or keys/). Check the -v mount: Docker makes an empty folder for a path that does not exist.`,
    );
  }
  const manifest = await loadManifest(stateDir, sourceRoot, target.name);
  const last = manifest.last_source;
  if (last && !options.allowShrink) {
    const fewer = last.owners && plan.layout.owners.length < last.owners * (1 - SHRINK_FRACTION);
    const smaller = last.bytes && sourceBytes < last.bytes * (1 - SHRINK_FRACTION);
    if (fewer || smaller) {
      return refuse(
        `the source holds ${plan.layout.owners.length} accounts and ${bytesText(sourceBytes)}, against ${last.owners} and ${bytesText(last.bytes)} at the last pass (${last.at}). Check the mount; if it is right, --allow-shrink.`,
      );
    }
  }

  for (const { rel, why } of plan.layout.leftWhole) log(`not moved: ${relTag(rel)} (${why})`);
  for (const [why, row] of Object.entries(summary.not_moved.files)) {
    log(`not moved: ${row.files} files, ${bytesText(row.bytes)} (${why})`);
  }
  for (const [kind, rows] of [
    ['expired at the source', summary.not_moved.expired],
    ['without the record they belong to', summary.not_moved.orphans],
  ] as const) {
    for (const [what, row] of Object.entries(rows)) {
      log(`not moved: ${what}: ${row.files} files, ${bytesText(row.bytes)} (${kind})`);
    }
  }
  // A record that cannot be read whole is never dropped quietly: it waits, and nothing of it
  // (its record, its files, what depends on it) is removed from the target meanwhile.
  summary.unreadable = plan.unreadable.map((u) => ({
    what: relTag(u.rel),
    why: `the record ${u.why}`,
  }));
  for (const u of summary.unreadable) log(`UNREADABLE ${u.what}: ${u.why}`);

  let state: PassState | undefined;
  if (mode !== 'verify') {
    try {
      state = await runPass(source, target, plan, manifest, {
        dryRun: mode === 'dry-run',
        concurrency: Math.max(1, options.concurrency ?? 4),
        recordConcurrency: Math.max(1, options.recordConcurrency ?? 8),
        ...(options.bytesPerSecond ? { bytesPerSecond: options.bytesPerSecond } : {}),
        ...(options.allowDeletes !== undefined ? { allowDeletes: options.allowDeletes } : {}),
        maxDeleteFraction: options.maxDeleteFraction ?? 0.1,
        rehash: options.rehash ?? false,
        final: Boolean(options.final),
        repair: Boolean(options.repair),
        ...(options.partBytes ? { partBytes: options.partBytes } : {}),
        ...(options.abortAfter !== undefined ? { abortAfter: options.abortAfter } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        log,
        save: () => saveManifest(stateDir, manifest),
      });
    } catch (error) {
      if (mode !== 'dry-run') await saveManifest(stateDir, manifest);
      if (error instanceof Interrupted) {
        log('Interrupted: what was done is kept, and the next run carries on from it.');
        return finish('interrupted');
      }
      log(`The pass broke: ${errorText(error)}`);
      summary.failed.push({ what: 'the pass', why: errorText(error) });
      return finish('failed');
    }
    Object.assign(summary, {
      records: state.records,
      blobs: state.blobs,
      logs: state.logs,
      deletes: state.deletes,
      oversize: state.oversize,
      failed: state.failed,
      waiting: state.waiting,
    });
    summary.notes.push(...state.notes);
    for (const o of state.oversize) {
      log(
        `TOO BIG for the target: ${o.collection} ${o.id}, ${bytesText(o.bytes)} (a record holds up to 16 MB)`,
      );
    }
    for (const f of state.failed.slice(0, 20)) log(`FAILED ${f.what}: ${f.why}`);
    if (mode === 'dry-run') {
      for (const [kind, c] of Object.entries(state.blobs).sort()) {
        log(
          `dry run blobs ${kind}: ${c.files ?? 0} files, ${bytesText(c.bytes ?? 0)}; ${c.to_copy ?? 0} to copy (${bytesText(c.to_copy_bytes ?? 0)}), ${c.to_share ?? 0} to share, ${c.to_carry ?? 0} uploads to carry, ${c.unchanged ?? 0} unchanged, ${c.waiting ?? 0} left for a later pass`,
        );
      }
      return finish(
        state.oversize.length ? 'differs' : summary.unreadable.length ? 'waiting' : 'ok',
      );
    }
    manifest.last_source = {
      owners: plan.layout.owners.length,
      bytes: sourceBytes,
      at: new Date().toISOString(),
    };
    await saveManifest(stateDir, manifest);
  }

  // ---- Repair: what the target holds that the source does not --------------------------------

  if (options.repair && mode === 'pass') {
    const found = await findExtras(target, plan, manifest);
    summary.extras = { records: found.records.length, blobs: found.blobs.length, pruned: 0 };
    log(`extras at the target: ${found.records.length} records, ${found.blobs.length} files`);
    const total = found.records.length + found.blobs.length;
    if (total && options.pruneExtras !== undefined) {
      if (total > options.pruneExtras) {
        log(`extras NOT removed: ${total} is more than --prune-extras ${options.pruneExtras}`);
        summary.deletes.refused = true;
      } else {
        for (const r of found.records) {
          await target.records
            .collection(r.spec, {
              ...(r.owner ? { owner: r.owner } : {}),
              ...(r.parent ? { parent: r.parent } : {}),
            })
            .delete(r.id);
        }
        for (const key of found.blobs) await target.blobs.delete(key);
        summary.extras.pruned = total;
        log(`extras removed: ${total}`);
      }
    }
  }

  let report: VerifyReport | undefined;
  if (mode === 'verify' || options.verify !== false) {
    // The source as it is now: what changed during the pass waits, and is not called a difference.
    plan = await buildPlan(source, target.blobs.keys, { ...planOptions, now: now() });
    const key = await sourceKey(sourceRoot, options.sourceUrlSecret);
    report = await verify(source, target, plan, manifest, {
      links: options.links ?? 200,
      blobCheck: options.blobCheck ?? 'sha',
      concurrency: Math.max(1, options.recordConcurrency ?? 8),
      log,
      appReads: options.appReads ?? 20,
      targetWorkspace: target.workspace(),
      ...(key ? { sourceKey: key } : {}),
      ...(options.targetKeyFingerprint
        ? { targetKeyFingerprint: options.targetKeyFingerprint }
        : {}),
      ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}),
      requireKeyCheck: Boolean(options.final),
    });
    summary.verify = report;
    summary.notes.push(...report.notes);
    files.verify = join(stateDir, 'verify-report.json');
    await mkdir(stateDir, { recursive: true });
    await writeFile(files.verify, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if (report.differences.length) {
      log(`verify: ${report.differences.length} DIFFERENCES`);
      for (const line of differenceTable(report.differences)) log(`  ${line}`);
    } else log('verify: the target holds what the source does');
    log(`verify report: ${files.verify}`);
  }

  for (const note of summary.notes) log(`note: ${note}`);
  const waiting = [...summary.waiting, ...summary.unreadable, ...(report?.waiting ?? [])];
  if (waiting.length) {
    log(`${waiting.length} things changed under the pass and wait for the next one, such as:`);
    for (const w of waiting.slice(0, 10)) log(`  ${w.what}: ${w.why}`);
  }
  if (summary.failed.length) return finish('failed');
  // Ahead of the differences it causes: what was not removed shows as extra at the target.
  if (summary.deletes.refused) return finish('deletesRefused');
  if (report?.differences.length || summary.oversize.length) return finish('differs');
  if (waiting.length && options.final) {
    log('This was the final pass, and the source was still changing: writes have not stopped.');
    return finish('differs');
  }
  if (waiting.length) return finish('waiting');
  if (options.final && mode === 'pass') {
    // Marked twice, so neither a lost state folder nor another one runs a pass after this.
    const mark = { source: sourceRoot, finished_at: new Date().toISOString() };
    await writeFile(join(stateDir, FINAL_MARK), `${JSON.stringify(mark)}\n`, { mode: 0o600 });
    await target.records.collection(MIGRATION).put('final', mark);
    log('final pass ended clean: marked, and any later pass is refused');
  }
  return finish('ok');
}

/** Every collection the migration has a rule for and whether it moves, for the runbook and `--help`. */
export function rulesText(
  specs: readonly CollectionSpec<unknown>[] = definedCollections(),
): string[] {
  return specs.map((spec) => {
    const rule = COLLECTION_RULES[specKey(spec)];
    return `${specKey(spec)}: ${rule ? (rule.skip ? `not moved (${rule.skip})` : 'moved') : 'NO RULE'}`;
  });
}
