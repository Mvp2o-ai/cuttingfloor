import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsBlobStore } from '@cuttingfloor/core';
import {
  carryPartway,
  partwayRecord,
  resumableOffset,
  Throttle,
  UPLOAD_PART_BYTES,
} from '@cuttingfloor/server/migrate';
import { afterAll, describe, expect, it } from 'vitest';

// An upload part way through when its data root is moved: where the sender resumes, and the
// parts that are carried.

const MIB = 1024 ** 2;
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function stores() {
  const dir = await mkdtemp(join(tmpdir(), 'cf-partway-'));
  dirs.push(dir);
  return { source: new FsBlobStore(join(dir, 'a')), target: new FsBlobStore(join(dir, 'b')) };
}

describe('where a part-way upload resumes', () => {
  it('is the bytes received cut back to whole 16 MiB parts', () => {
    expect(UPLOAD_PART_BYTES).toBe(16 * MIB);
    expect(resumableOffset(0)).toBe(0);
    expect(resumableOffset(1)).toBe(0);
    expect(resumableOffset(16 * MIB - 1)).toBe(0);
    expect(resumableOffset(16 * MIB)).toBe(16 * MIB);
    expect(resumableOffset(16 * MIB + 1)).toBe(16 * MIB);
    expect(resumableOffset(40 * MIB)).toBe(32 * MIB);
    expect(resumableOffset(48 * MIB)).toBe(48 * MIB);
    // 5 GiB and a bit: 320 whole parts.
    expect(resumableOffset(5 * 1024 * MIB + 12_345)).toBe(320 * 16 * MIB);
    // Never more than was received, never less than a part short of it, always whole parts.
    for (const received of [3, 16 * MIB + 7, 123_456_789, 9_999_999_999]) {
      const offset = resumableOffset(received);
      expect(offset).toBeLessThanOrEqual(received);
      expect(received - offset).toBeLessThan(16 * MIB);
      expect(offset % (16 * MIB)).toBe(0);
    }
    expect(resumableOffset(-5)).toBe(0);
    expect(resumableOffset(Number.NaN)).toBe(0);
    expect(resumableOffset(2500, 1000)).toBe(2000);
    expect(() => resumableOffset(10, 0)).toThrow();
  });

  it('is recorded with the multipart upload its parts are in', () => {
    const record = partwayRecord(
      { upload_id: 'u_1', complete: false },
      { offset: 32, upload_id: 'mp-1', parts: [{ part: 1, etag: 'e1', bytes: 32, sha256: 'x' }] },
    );
    expect(record).toEqual({
      upload_id: 'u_1',
      complete: false,
      offset: 32,
      multipart: { id: 'mp-1', parts: [{ part: 1, etag: 'e1', bytes: 32 }] },
    });
  });
});

describe('carrying a part-way upload', () => {
  it('sends the whole parts, then only the new ones, and starts again when the bytes changed', async () => {
    const { source, target } = await stores();
    await source.put('owners/o/uploads/u/data.mov', { bytes: Buffer.alloc(2500, 'a') });
    const first = await carryPartway(
      source,
      'owners/o/uploads/u/data.mov',
      target,
      'k/data',
      2500,
      {
        partBytes: 1000,
      },
    );
    expect(first.offset).toBe(2000);
    expect(first.parts.map((p) => p.bytes)).toEqual([1000, 1000]);
    expect((await target.head('k/data'))?.bytes).toBe(2000);

    // More arrived: the parts already there are not sent again.
    await source.put('owners/o/uploads/u/data.mov', { bytes: Buffer.alloc(4100, 'a') });
    let read = 0;
    const second = await carryPartway(
      source,
      'owners/o/uploads/u/data.mov',
      target,
      'k/data',
      4100,
      {
        partBytes: 1000,
        prior: first,
        onBytes: (n) => {
          read += n;
        },
      },
    );
    expect(second.offset).toBe(4000);
    expect(second.upload_id).toBe(first.upload_id);
    expect(second.started_at).toBe(first.started_at);
    expect(read).toBe(4000);
    expect((await target.head('k/data'))?.bytes).toBe(4000);

    // The sender began again with another file: nothing of the old one stays.
    await source.put('owners/o/uploads/u/data.mov', { bytes: Buffer.alloc(1200, 'b') });
    const third = await carryPartway(
      source,
      'owners/o/uploads/u/data.mov',
      target,
      'k/data',
      1200,
      {
        partBytes: 1000,
        prior: second,
      },
    );
    expect(third.offset).toBe(1000);
    expect(third.parts).toHaveLength(1);
    const chunks: Buffer[] = [];
    for await (const chunk of await target.get('k/data')) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(Buffer.alloc(1000, 'b'))).toBe(true);
  });
});

describe('the read limit', () => {
  it('holds reads to the rate given', async () => {
    const throttle = new Throttle(10_000);
    const started = Date.now();
    for (let i = 0; i < 4; i += 1) await throttle.take(1000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const free = new Throttle();
    const again = Date.now();
    await free.take(10 ** 9);
    expect(Date.now() - again).toBeLessThan(50);
  });
});
