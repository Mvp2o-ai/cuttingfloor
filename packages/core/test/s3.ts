import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOBS, type Records, type S3BlobStore, type S3Settings, Workspace } from '../src/index.ts';
import { testRecords } from './mongo.ts';
import type { Stores } from './storage-contract.ts';

// An S3 store for tests: the MinIO scripts/test-s3.sh starts (or CI's), or the one
// CUTTINGFLOOR_TEST_S3_ENDPOINT names. Suites that need it skip when there is none, unless
// CUTTINGFLOOR_REQUIRE_S3 says it must be there. Never a real bucket: each test makes its own.

export const S3_TEST_TIMEOUT_MS = 60_000;

export const TEST_S3 = {
  endpoint: process.env.CUTTINGFLOOR_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9100',
  region: 'us-east-1',
  accessKeyId: process.env.CUTTINGFLOOR_TEST_S3_ACCESS_KEY_ID ?? 'cuttingfloor',
  secretAccessKey: process.env.CUTTINGFLOOR_TEST_S3_SECRET_ACCESS_KEY ?? 'cuttingfloor-test-secret',
};

async function client() {
  const sdk = await import('@aws-sdk/client-s3');
  return {
    sdk,
    s3: new sdk.S3Client({
      endpoint: TEST_S3.endpoint,
      region: TEST_S3.region,
      credentials: { accessKeyId: TEST_S3.accessKeyId, secretAccessKey: TEST_S3.secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 1500, requestTimeout: 5000 },
    }),
  };
}

/** Whether the test store answers. Throws instead when it must and doesn't. */
export async function s3Reachable(): Promise<boolean> {
  const { sdk, s3 } = await client();
  const up = await s3.send(new sdk.ListBucketsCommand({})).then(
    () => true,
    () => false,
  );
  s3.destroy();
  if (!up && process.env.CUTTINGFLOOR_REQUIRE_S3) {
    throw new Error(
      'CUTTINGFLOOR_REQUIRE_S3 is set but no S3 store answers (scripts/test-s3.sh starts one)',
    );
  }
  if (!up) {
    process.stderr.write(
      'No S3 store answers, so the S3 blob store suites are skipped: scripts/test-s3.sh starts one\n',
    );
  }
  return up;
}

/** A bucket of the test's own; `drop` empties and removes it. */
export async function testBucket(): Promise<{ settings: S3Settings; drop(): Promise<void> }> {
  const bucket = `cf-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const { sdk, s3 } = await client();
  await s3.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
  s3.destroy();
  return {
    settings: {
      ...TEST_S3,
      bucket,
      pathStyle: true,
      cacheBytes: 1024 ** 3,
      partBytes: 5 * 1024 ** 2,
      concurrency: 4,
      connections: 32,
    },
    drop: async () => {
      const { sdk, s3 } = await client();
      try {
        for (;;) {
          const page = await s3.send(new sdk.ListObjectsV2Command({ Bucket: bucket }));
          if (!page.Contents?.length) break;
          for (const o of page.Contents) {
            await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: o.Key }));
          }
        }
        const open = await s3.send(new sdk.ListMultipartUploadsCommand({ Bucket: bucket }));
        for (const u of open.Uploads ?? []) {
          await s3
            .send(
              new sdk.AbortMultipartUploadCommand({
                Bucket: bucket,
                Key: u.Key,
                UploadId: u.UploadId,
              }),
            )
            .catch(() => undefined);
        }
        await s3.send(new sdk.DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
      } finally {
        s3.destroy();
      }
    },
  };
}

/** Makes a blob (or a folder of them) look last used `ms` ago: a last-use record set back. */
async function ageBlob(records: Records, key: string, ms: number): Promise<void> {
  const m = /^(?:media|derived|outputs)\/([^/]+)\//.exec(key);
  if (!m) throw new Error(`No owner in ${key}`);
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update(key).digest('hex').slice(0, 40);
  await records
    .collection(BLOBS, { owner: m[1] as string })
    .put(id, { key, used_at: new Date(Date.now() - ms).toISOString() });
}

/**
 * Files in a bucket of the test's own, with the node's cache in a temp folder. Records are on
 * the filesystem, or in MongoDB with `mongo` (a database of the test's own).
 */
export async function s3Stores(
  options: { mongo?: boolean } = {},
): Promise<Stores & { blobs: S3BlobStore; root: string; settings: S3Settings }> {
  const base = await mkdtemp(join(tmpdir(), 'cf-stores-s3-'));
  const root = join(base, 'data');
  const work = join(base, 'work');
  await mkdir(work, { recursive: true });
  const bucket = await testBucket();
  const records = options.mongo ? testRecords({ touchEveryMs: 0 }) : undefined;
  const ws = new Workspace(root, { ...(records ? { records } : {}), s3: bucket.settings });
  return {
    root,
    settings: bucket.settings,
    records: ws.records,
    blobs: ws.blobs as S3BlobStore,
    scratch: ws.scratch,
    work,
    age: {
      // The records contract is not run on these stores; only blobs age here.
      record: async () => undefined,
      parent: async () => undefined,
      blob: (key, ms) => ageBlob(ws.records, key, ms),
    },
    close: async () => {
      await ws.blobs.close();
      await bucket.drop();
      if (records) await records.drop();
      await rm(base, { recursive: true, force: true });
    },
  };
}
