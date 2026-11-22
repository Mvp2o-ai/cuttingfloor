import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { BlobKey, BlobPart, BlobStore } from '@cuttingfloor/core';

// An upload that is part way through when its data root is moved: the bytes that arrived go up
// as parts of a multipart upload at the target, and the sender carries on from the last whole
// part. Everything about how the target remembers such an upload is in the two marked functions
// below; the rest of the migration only calls them.

/** The size of every part but the last, as the upload path sends them. */
export const UPLOAD_PART_BYTES = 16 * 1024 ** 2;

/**
 * ===========================================================================================
 * THE ONE PLACE THE OFFSET IS CUT BACK.
 *
 * Where a sender resumes after the move: the bytes received, cut back to a whole number of
 * parts. An object store takes a part smaller than the rest only as the last one, so a part
 * that had not filled when the copy was taken is sent again by the sender (the upload protocol
 * already answers "send from N"). Bytes past the offset are not carried.
 * ===========================================================================================
 */
export function resumableOffset(receivedBytes: number, partBytes = UPLOAD_PART_BYTES): number {
  if (!Number.isInteger(partBytes) || partBytes <= 0) throw new Error('Not a part size');
  if (!Number.isFinite(receivedBytes) || receivedBytes <= 0) return 0;
  return Math.floor(receivedBytes / partBytes) * partBytes;
}

/** One part as carried: what the store answered, and the bytes' own hash. */
export interface CarriedPart extends BlobPart {
  sha256: string;
}

/** What the manifest keeps of an upload carried part way. */
export interface Carried {
  /** The target key the parts belong to. */
  target: BlobKey;
  /** The store's id of the multipart upload. */
  upload_id: string;
  part_bytes: number;
  parts: CarriedPart[];
  /** Where the sender resumes: `resumableOffset` of what the source had. */
  offset: number;
  started_at: string;
}

/**
 * ===========================================================================================
 * THE ONE PLACE THE TARGET'S UPLOAD RECORD IS SHAPED.
 *
 * The upload's record at the target: the source's record, plus where the sender resumes and
 * the multipart upload the carried bytes are in. The upload code on an object store reads its
 * offset and parts from the record (plan: `s3_upload_id`, parts with ETags, `offset`); when
 * that layout exists, this function writes it. On the filesystem store the fields are inert:
 * the offset there is the size of the upload's file, which is exactly the bytes carried.
 * ===========================================================================================
 */
export function partwayRecord<T extends object>(
  record: T,
  carried: Pick<Carried, 'offset' | 'upload_id' | 'parts'>,
): T & { offset: number; multipart: { id: string; parts: BlobPart[] } } {
  return {
    ...record,
    offset: carried.offset,
    multipart: {
      id: carried.upload_id,
      parts: carried.parts.map(({ part, etag, bytes }) => ({ part, etag, bytes })),
    },
  };
}

/** The fields `partwayRecord` adds, which no source record has. */
export const PARTWAY_FIELDS = ['offset', 'multipart'] as const;

async function readRange(
  store: BlobStore,
  key: BlobKey,
  start: number,
  end: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await store.getRange(key, start, end)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Carries the whole parts of a part-way upload to the target. Parts already there from an
 * earlier pass (`prior`, same bytes by hash) are not sent again; if what the source holds no
 * longer starts with them (the sender began again), the earlier multipart upload is dropped and
 * everything is sent anew.
 */
export async function carryPartway(
  source: BlobStore,
  sourceKey: BlobKey,
  target: BlobStore,
  targetKey: BlobKey,
  receivedBytes: number,
  options: {
    prior?: Carried;
    partBytes?: number;
    /** Told of each part's bytes as they are read from the source. */
    onBytes?: (bytes: number) => Promise<void> | void;
  } = {},
): Promise<Carried> {
  const partBytes = options.partBytes ?? UPLOAD_PART_BYTES;
  const offset = resumableOffset(receivedBytes, partBytes);
  const count = offset / partBytes;
  let prior =
    options.prior && options.prior.part_bytes === partBytes && options.prior.target === targetKey
      ? options.prior
      : undefined;
  if (options.prior && !prior) {
    await target.multipartAbort(options.prior.target, options.prior.upload_id).catch(() => {});
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let uploadId = prior?.upload_id;
    if (!uploadId) {
      // Nothing of an earlier, forgotten attempt may be under the key: a store that appends
      // parts in place would add to it.
      await target.delete(targetKey);
      uploadId = await target.multipartStart(targetKey);
    }
    const parts: CarriedPart[] = [];
    let restart = false;
    for (let n = 1; n <= count; n += 1) {
      const bytes = await readRange(source, sourceKey, (n - 1) * partBytes, n * partBytes - 1);
      if (bytes.length !== partBytes) throw new Error('The upload shrank while it was read');
      await options.onBytes?.(bytes.length);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const had = prior?.parts[n - 1];
      if (had) {
        if (had.sha256 === sha256) {
          parts.push(had);
          continue;
        }
        restart = true;
        break;
      }
      const sent = await target.multipartPart(targetKey, uploadId, n, Readable.from([bytes]));
      parts.push({ ...sent, sha256 });
    }
    if (restart || (prior && prior.parts.length > count)) {
      await target.multipartAbort(targetKey, uploadId).catch(() => {});
      prior = undefined;
      continue;
    }
    return {
      target: targetKey,
      upload_id: uploadId,
      part_bytes: partBytes,
      parts,
      offset,
      started_at: prior?.started_at ?? new Date().toISOString(),
    };
  }
  throw new Error('The upload kept changing while it was read');
}
