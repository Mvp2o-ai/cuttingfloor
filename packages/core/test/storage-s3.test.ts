import { describe } from 'vitest';
import { s3Reachable, s3Stores } from './s3.ts';
import { blobStoreContract, scratchContract } from './storage-contract.ts';

const up = await s3Reachable();

describe.skipIf(!up)('S3 blobs', () => {
  blobStoreContract('S3 (MinIO)', () => s3Stores());
  scratchContract('S3 (MinIO)', () => s3Stores());
});
