import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type CollectionSpec, definedCollections } from '@cuttingfloor/core';
import { COLLECTION_RULES, relTag, specKey } from './layout.ts';
import { loadManifest, saveManifest } from './manifest.ts';
import { bytesText, errorText, Interrupted, type PassState, runPass, slot } from './pass.ts';
import { buildPlan, openSource, type Plan } from './plan.ts';
import { type MigrationTarget, within } from './target.ts';
import { differenceTable, type VerifyReport, verify } from './verify.ts';

export { COLLECTION_RULES, NOT_MOVED_OWNER, NOT_MOVED_ROOT, readLayout } from './layout.ts';
export { type Manifest, manifestPath } from './manifest.ts';
export { Throttle } from './pass.ts';
export { buildPlan, openSource } from './plan.ts';
export { blobTargetFromEnv, fsTarget, type MigrationTarget, targetFromEnv } from './target.ts';
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
  concurrency?: number;
  recordConcurrency?: number;
  bytesPerSecond?: number;
  allowDeletes?: boolean;
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
  };
  records: PassState['records'];
  blobs: PassState['blobs'];
  logs: PassState['logs'];
  deletes: PassState['deletes'];
  oversize: PassState['oversize'];
  failed: PassState['failed'];
  waiting: Array<{ what: string; why: string }>;
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
    whole: plan.layout.leftWhole.map(({ rel, why }) => ({ path: rel, why })),
    files: {},
    expired: {},
    orphans: {},
  };
  for (const left of plan.layout.left) tally(out.files, left.why, left.size);
  for (const s of plan.skipped)
    tally(s.why === 'expired' ? out.expired : out.orphans, s.what, s.size);
  return out;
}

export async function migrate(options: MigrateOptions): Promise<MigrateSummary> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const mode = options.mode ?? 'pass';
  const sourceRoot = resolve(options.source);
  const stateDir = resolve(options.stateDir);
  if (within(sourceRoot, stateDir)) {
    throw new Error('The state folder is inside the source data root, which is only ever read');
  }
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

  log(`${mode}: ${sourceRoot} -> ${target.name}`);
  let plan = await buildPlan(source, target.blobs.keys, { ...planOptions, now: now() });
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
  for (const { rel, why } of plan.layout.leftWhole) log(`not moved: ${rel} (${why})`);
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

  const manifest = await loadManifest(stateDir, sourceRoot, target.name);
  let state: PassState | undefined;
  if (mode !== 'verify') {
    try {
      state = await runPass(source, target, plan, manifest, {
        dryRun: mode === 'dry-run',
        concurrency: Math.max(1, options.concurrency ?? 4),
        recordConcurrency: Math.max(1, options.recordConcurrency ?? 8),
        ...(options.bytesPerSecond ? { bytesPerSecond: options.bytesPerSecond } : {}),
        allowDeletes: options.allowDeletes ?? false,
        maxDeleteFraction: options.maxDeleteFraction ?? 0.1,
        rehash: options.rehash ?? false,
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
      return finish(state.oversize.length ? 'differs' : 'ok');
    }
  }

  let report: VerifyReport | undefined;
  if (mode === 'verify' || options.verify !== false) {
    // The source as it is now: what changed during the pass waits, and is not called a difference.
    plan = await buildPlan(source, target.blobs.keys, { ...planOptions, now: now() });
    report = await verify(source, target, plan, manifest, {
      links: options.links ?? 200,
      blobCheck: options.blobCheck ?? 'sha',
      concurrency: Math.max(1, options.recordConcurrency ?? 8),
      log,
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
  const waiting = [...summary.waiting, ...(report?.waiting ?? [])];
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
