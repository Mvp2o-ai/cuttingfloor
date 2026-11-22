import { MongoRecords } from '@cuttingfloor/core';

// The MongoDB the hosted suites test against: the one scripts/test-mongo.sh starts (or CI's
// service container), or the one CUTTINGFLOOR_TEST_MONGODB_URI names. Suites that need it skip
// when there is none, unless CUTTINGFLOOR_REQUIRE_MONGO says it must be there. (The record
// store's own suites in packages/core find it the same way.)

/** A test on the database makes one of its own and drops it: seconds on a busy machine. */
export const MONGO_TEST_TIMEOUT_MS = 60_000;

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
