import { MongoRecords, type Records, Workspace } from '@cuttingfloor/core';
import { LOW_CREDITS } from '@cuttingfloor/plans';
import { configFromEnv } from '@cuttingfloor/server';
import { FileLedger, type Ledger, MongoLedger } from './ledger.ts';

/**
 * The record store and credit ledger the environment names, as the server would open them
 * (CUTTINGFLOOR_RECORDS, CUTTINGFLOOR_MONGODB_*, CUTTINGFLOOR_DATA): for the one-off scripts.
 */
export function ledgerFromEnv(env: NodeJS.ProcessEnv = process.env): {
  records: Records;
  ledger: Ledger;
  close: () => Promise<void>;
} {
  const config = configFromEnv(env);
  if (config.records) {
    const records = new MongoRecords({ uri: config.records.uri, db: config.records.db });
    return {
      records,
      ledger: new MongoLedger({ db: () => records.database(), low: LOW_CREDITS }),
      close: () => records.close(),
    };
  }
  const records = new Workspace(config.dataDir).records;
  return {
    records,
    ledger: new FileLedger({ records, low: LOW_CREDITS }),
    close: async () => undefined,
  };
}
