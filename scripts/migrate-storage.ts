// Moves a live filesystem data root into the target record store and blob store. Run it inside
// the old server's container, as often as needed while that server keeps serving, then once more
// after writes stop. The runbook, with every command and exit code, is scripts/migrate-storage.md.
//
//   node scripts/migrate-storage.ts --state /state --target-dir /target --dry-run
//
// The source is only ever read. Nothing printed or written to a report holds a record's
// contents, an email, a key or a token: ids, counts, sizes and hashed owner keys only.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { hostedCollections } from '../apps/hosted/src/collections.ts';
import { Workspace } from '../packages/core/src/index.ts';
import { configFromEnv } from '../packages/server/src/index.ts';
import {
  EXIT,
  type MigrateOptions,
  migrate,
  rulesText,
  targetFromEnv,
} from '../packages/server/src/migrate/index.ts';
import { within } from '../packages/server/src/migrate/target.ts';

const HELP = `node scripts/migrate-storage.ts --state <dir> [--target-dir <dir>] [options]

  --source <dir>            The data root to move. Default: CUTTINGFLOOR_DATA, else /data. Only read.
  --state <dir>             Where the manifest and reports are kept between passes. Not under the source.
  --target-dir <dir>        The data root files are moved into (the filesystem blob target).
                            Records go beside them, or to MongoDB with CUTTINGFLOOR_RECORDS=mongo
                            and the server's own CUTTINGFLOOR_MONGODB_* settings.
  --dry-run                 Say what a pass would do, and touch nothing.
  --verify                  Only compare the target with the source.
  --no-verify               Do not compare after the pass.
  --final                   Writes have stopped at the source: take everything, leave nothing waiting.
  --concurrency <n>         Files moved at once. Default 4. 1 is the gentlest.
  --record-concurrency <n>  Records moved at once. Default 8.
  --bwlimit <rate>          The most to read from the source per second: 20M, 500K, or bytes.
  --allow-deletes           Remove from the target whatever has gone from the source, however much.
  --max-delete-fraction <f> Without --allow-deletes, a pass removes at most this share of what it
                            has moved. Default 0.1.
  --links <n|all>           Signed links from job results and the email log to check. Default 200.
  --blob-check <sha|size>   sha (default): a file whose store keeps no hash is read back and hashed.
  --rehash                  Read every source file again instead of trusting the manifest.
  --settle <seconds>        Leave files written less than this ago for the next pass. Default 60.
  --ignore <path>           Leave out a file or folder of the data root by its path under it. Repeatable.
  --list-collections        Print every collection and whether it moves, and exit.

Exit codes: 0 done and the same; 1 a write failed (run again); 2 refused, nothing written (a file
it cannot name, a path import, a collection with no rule); 3 the target differs; 4 things changed
under the pass and wait for the next; 5 deletes refused; 6 interrupted.
`;

function rate(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)(?:i?B)?(?:\/s)?$/i.exec(text.trim());
  if (!m) throw new Error(`--bwlimit ${text}: give a rate such as 20M or 500K`);
  const unit = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[(m[2] ?? '').toUpperCase()] ?? 1;
  return Math.floor(Number(m[1]) * unit);
}

const number = (name: string, text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} ${text}: not a number`);
  return n;
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      state: { type: 'string' },
      'target-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      verify: { type: 'boolean' },
      'no-verify': { type: 'boolean' },
      final: { type: 'boolean' },
      concurrency: { type: 'string' },
      'record-concurrency': { type: 'string' },
      bwlimit: { type: 'string' },
      'allow-deletes': { type: 'boolean' },
      'max-delete-fraction': { type: 'string' },
      links: { type: 'string' },
      'blob-check': { type: 'string' },
      rehash: { type: 'boolean' },
      settle: { type: 'string' },
      ignore: { type: 'string', multiple: true },
      'part-bytes': { type: 'string' },
      'abort-after': { type: 'string' },
      'list-collections': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return EXIT.ok;
  }
  const source = resolve(values.source ?? process.env.CUTTINGFLOOR_DATA ?? '/data');
  // Defines every collection a hosted server keeps. A Workspace only names the data root.
  const specs = hostedCollections(new Workspace(source));
  if (values['list-collections']) {
    process.stdout.write(`${rulesText(specs).join('\n')}\n`);
    return EXIT.ok;
  }
  if (!values.state) throw new Error('--state is needed: a folder for the manifest and reports');
  const targetDir = values['target-dir'];
  if (targetDir && (within(source, targetDir) || within(targetDir, source))) {
    throw new Error('--target-dir and the source data root must be apart');
  }
  const blobCheck = values['blob-check'] ?? 'sha';
  if (blobCheck !== 'sha' && blobCheck !== 'size') throw new Error('--blob-check is sha or size');
  const links = values.links === 'all' ? 'all' : number('links', values.links);
  const target = targetFromEnv(process.env, { ...(targetDir ? { targetDir } : {}) });
  const stop = new AbortController();
  const asked = () => {
    process.stderr.write('Stopping after what is in flight…\n');
    stop.abort();
  };
  process.once('SIGINT', asked);
  process.once('SIGTERM', asked);
  const settle = number('settle', values.settle);
  const options: MigrateOptions = {
    source,
    target,
    stateDir: values.state,
    specs,
    mode: values['dry-run'] ? 'dry-run' : values.verify ? 'verify' : 'pass',
    verify: !values['no-verify'],
    final: Boolean(values.final),
    allowDeletes: Boolean(values['allow-deletes']),
    rehash: Boolean(values.rehash),
    blobCheck,
    // Frames kept for download last as long as the server's links do.
    outputTtlMs: configFromEnv(process.env).outputUrlTtlMs,
    signal: stop.signal,
    ...(values.concurrency ? { concurrency: number('concurrency', values.concurrency) ?? 4 } : {}),
    ...(values['record-concurrency']
      ? { recordConcurrency: number('record-concurrency', values['record-concurrency']) ?? 8 }
      : {}),
    ...(values.bwlimit ? { bytesPerSecond: rate(values.bwlimit) } : {}),
    ...(values['max-delete-fraction']
      ? { maxDeleteFraction: number('max-delete-fraction', values['max-delete-fraction']) ?? 0.1 }
      : {}),
    ...(links !== undefined ? { links } : {}),
    ...(settle !== undefined ? { settleMs: settle * 1000 } : {}),
    ...(values.ignore ? { ignore: values.ignore } : {}),
    ...(values['part-bytes'] ? { partBytes: number('part-bytes', values['part-bytes']) ?? 0 } : {}),
    ...(values['abort-after']
      ? { abortAfter: number('abort-after', values['abort-after']) ?? 0 }
      : {}),
  };
  try {
    const summary = await migrate(options);
    return summary.exit_code;
  } finally {
    await target.close().catch(() => undefined);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    // Never the error itself beyond its message: a driver's may carry an address.
    process.stderr.write(
      `migrate-storage: ${String(error.message).replace(/mongodb(\+srv)?:\/\/\S+/g, 'mongodb://…')}\n`,
    );
    process.exitCode = EXIT.failed;
  },
);
