// The split from Kazi's shared ledger: opens each account Kazi hands over in our credit ledger
// with exactly the balance Kazi had, its payments and releases under their own ids, later Stripe
// payments, and turns Kazi's `unmetered` into WorkOS `plan: lifetime` (apps/hosted/src/opening.ts
// says how). Run once at the cutover, inside the image, with production's environment:
//
//   node scripts/ledger-opening.ts <handoff.json>            prints what it would do
//   node scripts/ledger-opening.ts <handoff.json> --apply    does it (safe to run again)
//
// Needs WORKOS_API_KEY, STRIPE_SECRET_KEY and the record store's settings
// (CUTTINGFLOOR_RECORDS=mongo, CUTTINGFLOOR_MONGODB_*). Then run scripts/ledger-reconcile.ts.

import { readFile } from 'node:fs/promises';
import { ledgerFromEnv } from '../apps/hosted/src/ledger-store.ts';
import { importHandoff, parseHandoff } from '../apps/hosted/src/opening.ts';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  process.stderr.write('usage: node scripts/ledger-opening.ts <handoff.json> [--apply]\n');
  process.exit(2);
}
const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const handoff = parseHandoff(JSON.parse(await readFile(file, 'utf8')));
const { records, ledger, close } = ledgerFromEnv();
try {
  const report = await importHandoff({
    handoff,
    ledger,
    records,
    workosKey: need('WORKOS_API_KEY'),
    stripeKey: need('STRIPE_SECRET_KEY'),
    apply: flags.includes('--apply'),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  if (report.problems.length) process.exitCode = 1;
} finally {
  await close();
}
