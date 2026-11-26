import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@cuttingfloor/core';
import { LOW_CREDITS } from '@cuttingfloor/plans';
import { FileLedger } from '../src/ledger.ts';

/** A credit ledger of the test's own, on the filesystem, for tests that never spend on it. */
export function testLedger(): FileLedger {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), 'cf-test-ledger-')));
  return new FileLedger({ records: ws.records, low: LOW_CREDITS });
}
