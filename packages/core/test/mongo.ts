import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoRecords, type MongoRecordsOptions, ownerKey, Workspace } from '../src/index.ts';
import type { Stores } from './storage-contract.ts';

// A MongoDB for tests: the one scripts/test-mongo.sh starts (or CI's service container), or the
// one CUTTINGFLOOR_TEST_MONGODB_URI names. Suites that need it skip when there is none, unless
// CUTTINGFLOOR_REQUIRE_MONGO says it must be there.

export const TEST_MONGODB_URI =
  process.env.CUTTINGFLOOR_TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?directConnection=true';

/** Whether the test database answers. Throws instead when it must and doesn't. */
export async function mongoReachable(): Promise<boolean> {
  const probe = new MongoRecords({ uri: TEST_MONGODB_URI, db: 'cf_probe', connectTimeoutMs: 1500 });
  const up = await probe.database().then(
    () => true,
    () => false,
  );
  await probe.close();
  if (!up && process.env.CUTTINGFLOOR_REQUIRE_MONGO) {
    throw new Error(
      'CUTTINGFLOOR_REQUIRE_MONGO is set but no MongoDB answers (scripts/test-mongo.sh starts one)',
    );
  }
  if (!up) {
    process.stderr.write(
      'No MongoDB answers, so the Mongo store suites are skipped: scripts/test-mongo.sh starts one\n',
    );
  }
  return up;
}

/** A name for a database of the test's own. */
export function testDatabase(): string {
  return `cf_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A Mongo record store on a database of its own; `drop` removes the database and closes. */
export function testRecords(
  options: Partial<MongoRecordsOptions> = {},
): MongoRecords & { drop(): Promise<void> } {
  const records = new MongoRecords({ uri: TEST_MONGODB_URI, db: testDatabase(), ...options });
  return Object.assign(records, {
    drop: async () => {
      await records.idle();
      await (await records.database()).dropDatabase();
      await records.close();
    },
  });
}

/**
 * Records in MongoDB, files on the filesystem: the stores a hosted server runs on between the
 * two moves. A touch always writes here, as the contract's reads of last use expect; the hourly
 * limit is tested on its own.
 */
export async function mongoStores(): Promise<Stores> {
  const base = await mkdtemp(join(tmpdir(), 'cf-stores-mongo-'));
  const root = join(base, 'data');
  const work = join(base, 'work');
  await mkdir(work, { recursive: true });
  const records = testRecords({ touchEveryMs: 0 });
  const ws = new Workspace(root, { records });
  const back = async (filter: Record<string, unknown>, name: string, ms: number) => {
    const db = await records.database();
    await db.collection(name).updateMany(filter, { $set: { used_at: new Date(Date.now() - ms) } });
  };
  return {
    records,
    blobs: ws.blobs,
    scratch: ws.scratch,
    work,
    age: {
      record: (spec, scope, id, ms) =>
        back(
          {
            id,
            ...(scope.owner ? { owner: ownerKey(scope.owner) } : {}),
            ...(scope.parent ? { parent: scope.parent } : {}),
          },
          spec.name,
          ms,
        ),
      parent: (spec, scope, parent, ms) =>
        back({ parent, ...(scope.owner ? { owner: ownerKey(scope.owner) } : {}) }, spec.name, ms),
      blob: async (key, ms) => {
        const at = new Date(Date.now() - ms);
        await utimes(join(root, key), at, at);
      },
    },
    close: async () => {
      await records.drop();
      await rm(base, { recursive: true, force: true });
    },
  };
}
