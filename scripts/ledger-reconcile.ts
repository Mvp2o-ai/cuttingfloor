// Compares our credit ledger with Kazi's hand-off: each handed account's balance at the split
// against Kazi's, accounts missing either way, and every account's stored balance and totals
// against its entries summed again. Prints each difference; exits 1 when there is any (a
// difference stops the cutover and goes to Ken).
//
//   node scripts/ledger-reconcile.ts <handoff.json>
//
// Reads the record store the environment names (CUTTINGFLOOR_RECORDS=mongo, CUTTINGFLOOR_MONGODB_*).
// Writes nothing.

import { readFile } from 'node:fs/promises';
import { ledgerFromEnv } from '../apps/hosted/src/ledger-store.ts';
import { parseHandoff, reconcile } from '../apps/hosted/src/opening.ts';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node scripts/ledger-reconcile.ts <handoff.json>\n');
  process.exit(2);
}
const handoff = parseHandoff(JSON.parse(await readFile(file, 'utf8')));
const { ledger, close } = ledgerFromEnv();
try {
  const { checked, differences } = await reconcile({ handoff, ledger });
  for (const d of differences) process.stdout.write(`${d.owner}: ${d.what}\n`);
  process.stdout.write(
    `${checked} accounts checked against ${handoff.accounts.length} handed over: ${differences.length} differences\n`,
  );
  if (differences.length) process.exitCode = 1;
} finally {
  await close();
}
