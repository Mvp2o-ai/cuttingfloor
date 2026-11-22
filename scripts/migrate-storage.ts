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
                            Refused unless the old server is draining with no jobs running. Ending
                            clean, it marks the state folder and the target; any later pass is then
                            refused unless --after-final.
  --after-final             Run a pass after the final one (only to put right a wrong final pass).
  --no-drain-check          --final without reading the old server's draining marker.
  --repair                  Compare the target with the source for everything, whatever the manifest
                            says, and rewrite what differs or is missing there. Lists extras.
  --prune-extras <n>        With --repair: remove up to n things the target holds that the source does not.
  --exclude-owner <owner>   Leave an account alone on both sides (a test account on the new server). Repeatable.
  --reread <all|f|n>        With --verify: read files back from the target and hash them against the
                            manifest (all, a share such as 0.1, or a count). Needs only --state and the
                            target settings: run it on the new server.
  --app-reads <all|n>       Media, outputs and uploads resolved through the server's own readers. Default 20.
  --target-key-fingerprint <fp>  The new server's link-key fingerprint (scripts/url-key-fingerprint.ts
                            there). Required by --final's verify.
  --target-url <url>        The new server's address: a signed download and upload link are fetched from it.
  --allow-shrink            Run although the source holds far less than at the last pass.
  --concurrency <n>         Files moved at once. Default 4. 1 is the gentlest.
  --record-concurrency <n>  Records moved at once. Default 8.
  --bwlimit <rate>          The most to read from the source per second: 20M, 500K, or bytes.
  --allow-deletes <n>       Remove from the target up to n things gone from the source, past the share below.
  --max-delete-fraction <f> Without --allow-deletes, a pass removes at most this share of what it
                            has moved. Default 0.1.
  --links <n|all>           Signed links from job results and the email log to check. Default 200.
  --blob-check <sha|size>   sha (default): a file whose store keeps no hash is read back and hashed.
  --rehash                  Read every source file again instead of trusting the manifest.
  --settle <seconds>        Leave files written less than this ago for the next pass. Default 60.
  --ignore <path>           Leave out a file or folder of the data root by its path under it. Repeatable.
  --list-collections        Print every collection and whether it moves, and exit.

Exit codes: 0 done and the same; 1 a write failed (run again); 2 refused, nothing written (a file
it cannot name, a path import, a collection with no rule, a source that is not a data root or has
shrunk, a pass after the final one, a target a server serves on, --final while the old server is
not drained); 3 the target differs; 4 things changed under the pass and wait for the next (an
unreadable record too); 5 deletes refused; 6 interrupted.
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

/** A count the option must give. */
function whole(name: string, text: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} ${text}: give a whole number`);
  return n;
}

/** all, a share under 1, or a count. */
function sample(name: string, text: string): 'all' | number {
  if (text === 'all') return 'all';
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`--${name} ${text}: give all, a share, or a count`);
  return n;
}

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
      'allow-deletes': { type: 'string' },
      'after-final': { type: 'boolean' },
      'no-drain-check': { type: 'boolean' },
      repair: { type: 'boolean' },
      'prune-extras': { type: 'string' },
      'exclude-owner': { type: 'string', multiple: true },
      reread: { type: 'string' },
      'app-reads': { type: 'string' },
      'target-key-fingerprint': { type: 'string' },
      'target-url': { type: 'string' },
      'allow-shrink': { type: 'boolean' },
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
  // A dropped SSH session stops the pass as SIGINT does: the manifest is saved first.
  process.once('SIGHUP', asked);
  const settle = number('settle', values.settle);
  const options: MigrateOptions = {
    source,
    target,
    stateDir: values.state,
    specs,
    mode: values['dry-run'] ? 'dry-run' : values.verify || values.reread ? 'verify' : 'pass',
    verify: !values['no-verify'],
    final: Boolean(values.final),
    ...(values['allow-deletes'] !== undefined
      ? { allowDeletes: whole('allow-deletes', values['allow-deletes']) }
      : {}),
    afterFinal: Boolean(values['after-final']),
    ...(values['no-drain-check'] ? { drainCheck: false } : {}),
    repair: Boolean(values.repair),
    ...(values['prune-extras'] !== undefined
      ? { pruneExtras: whole('prune-extras', values['prune-extras']) }
      : {}),
    ...(values['exclude-owner'] ? { excludeOwners: values['exclude-owner'] } : {}),
    ...(values.reread !== undefined ? { reread: sample('reread', values.reread) } : {}),
    ...(values['app-reads'] !== undefined
      ? { appReads: sample('app-reads', values['app-reads']) }
      : {}),
    ...(values['target-key-fingerprint']
      ? { targetKeyFingerprint: values['target-key-fingerprint'] }
      : {}),
    ...(values['target-url'] ? { targetUrl: values['target-url'] } : {}),
    // The old server's own key when it signs with CUTTINGFLOOR_URL_SECRET; else its secret.key.
    ...(process.env.CUTTINGFLOOR_SOURCE_URL_SECRET
      ? { sourceUrlSecret: process.env.CUTTINGFLOOR_SOURCE_URL_SECRET }
      : {}),
    allowShrink: Boolean(values['allow-shrink']),
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
