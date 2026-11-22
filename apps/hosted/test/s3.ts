import type { S3BlobStore, S3Settings } from '@cuttingfloor/core';

// The S3 store the hosted suites test against: the MinIO scripts/test-s3.sh starts (or CI's), or
// the one CUTTINGFLOOR_TEST_S3_ENDPOINT names. Suites that need it skip when there is none,
// unless CUTTINGFLOOR_REQUIRE_S3 says it must be there. Never a real bucket: each test server
// makes one of its own. (The blob store's own suites in packages/core find it the same way.)

export const S3_TEST_TIMEOUT_MS = 120_000;

const ENDPOINT = process.env.CUTTINGFLOOR_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9100';

/** Whether the test store answers. Throws instead when it must and doesn't. */
export async function s3Reachable(): Promise<boolean> {
  const up = await fetch(ENDPOINT, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );
  if (!up && process.env.CUTTINGFLOOR_REQUIRE_S3) {
    throw new Error(
      'CUTTINGFLOOR_REQUIRE_S3 is set but no S3 store answers (scripts/test-s3.sh starts one)',
    );
  }
  if (!up) {
    process.stderr.write(
      'No S3 store answers, so the S3 suites are skipped: scripts/test-s3.sh starts one\n',
    );
  }
  return up;
}

/** Settings for a bucket of the test's own (not made yet: `makeBucket` does). */
export function testS3(bucket?: string): S3Settings {
  return {
    endpoint: ENDPOINT,
    region: 'us-east-1',
    accessKeyId: process.env.CUTTINGFLOOR_TEST_S3_ACCESS_KEY_ID ?? 'cuttingfloor',
    secretAccessKey:
      process.env.CUTTINGFLOOR_TEST_S3_SECRET_ACCESS_KEY ?? 'cuttingfloor-test-secret',
    bucket:
      bucket ?? `cf-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    pathStyle: true,
    cacheBytes: 1024 ** 3,
    partBytes: 5 * 1024 ** 2,
    concurrency: 4,
    connections: 32,
  };
}

export async function makeBucket(blobs: unknown): Promise<void> {
  await (blobs as S3BlobStore).createBucket();
}
