// The split from Kazi's shared ledger: opens each account in Kazi's hand-off (`kazi-handoff/1`)
// in our credit ledger at exactly its balance, enters its App Store and Stripe payments under
// their own ids, keeps its App Store token, and turns Kazi's `unmetered` into WorkOS
// `plan: lifetime` (apps/hosted/src/opening.ts says how). Run 1 at the switch; run 2, on a later
// export, adds only payments it hasn't seen and reports any other change. Run it inside the image
// with production's environment:
//
//   node scripts/ledger-opening.ts <kazi-handoff.json>            prints what it would do
//   node scripts/ledger-opening.ts <kazi-handoff.json> --apply    does it (safe to run again)
//
// Needs WORKOS_API_KEY and the record store's settings (CUTTINGFLOOR_RECORDS=mongo,
// CUTTINGFLOOR_MONGODB_*). Exits 1 on any mismatch: those go to Ken. Then run
// scripts/ledger-reconcile.ts.

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
    apply: flags.includes('--apply'),
    log: (line) => process.stdout.write(`${line}\n`),
  });
  if (report.mismatches.length) process.exitCode = 1;
} finally {
  await close();
}
