import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  BLOBS,
  type BlobPart,
  isExisting,
  isMissing,
  partSize,
  S3Scratch,
  s3SettingsFromEnv,
} from '../src/index.ts';
import { mongoReachable } from './mongo.ts';
import { S3_TEST_TIMEOUT_MS, s3Reachable, s3Stores, TEST_S3 } from './s3.ts';
import { blobStoreContract, scratchContract } from './storage-contract.ts';

const up = await s3Reachable();
const mongo = up && (await mongoReachable());
vi.setConfig({ testTimeout: S3_TEST_TIMEOUT_MS, hookTimeout: S3_TEST_TIMEOUT_MS });

const MIB = 1024 ** 2;

async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe.skipIf(!up)('S3 blobs', () => {
  blobStoreContract('S3 (MinIO)', () => s3Stores());
  scratchContract('S3 (MinIO)', () => s3Stores());
});

describe.skipIf(!mongo)('S3 blobs with records in MongoDB', () => {
  blobStoreContract('S3 (MinIO) + MongoDB', () => s3Stores({ mongo: true }));
});

describe.skipIf(!up)('S3 blobs: what only this store promises', () => {
  const body =
    (
      run: (s: Awaited<ReturnType<typeof s3Stores>>) => Promise<void>,
      options: Parameters<typeof s3Stores>[0] = {},
    ) =>
    async () => {
      const s = await s3Stores(options);
      try {
        await run(s);
      } finally {
        await s.close();
      }
    };
  const each = Object.assign(
    (
      name: string,
      run: (s: Awaited<ReturnType<typeof s3Stores>>) => Promise<void>,
      options: Parameters<typeof s3Stores>[0] = {},
    ) => it(name, body(run, options)),
    {
      skip: (
        name: string,
        run: (s: Awaited<ReturnType<typeof s3Stores>>) => Promise<void>,
        _options?: Parameters<typeof s3Stores>[0],
      ) => it.skip(name, body(run)),
    },
  );

  each('the layout: kind, then owner; cache keys stay on the node', async ({ blobs, root }) => {
    expect(blobs.keys.media('alice', 'm_1', 'source.mp4')).toBe('media/alice/m_1/source.mp4');
    expect(blobs.keys.derived('alice', 'm_1', 'analyses', 't.json')).toBe(
      'derived/alice/m_1/analyses/t.json',
    );
    expect(blobs.keys.derived('alice', 'm_1')).toBe('derived/alice/m_1');
    expect(blobs.keys.output('alice', 'j_1', 'out.mp4')).toBe('outputs/alice/j_1/out.mp4');
    expect(blobs.keys.upload('alice', 'u_1', 'data.mp4')).toBe('media/alice/u_1/data.mp4');
    expect(blobs.remote).toBe(true);
    const cached = blobs.keys.cache('frames', 'x.png');
    await blobs.put(cached, { bytes: Buffer.from('png') });
    expect(await readFile(join(root, 'cache', 'frames', 'x.png'), 'utf8')).toBe('png');
    expect(await blobs.presignGet(cached, { ttlMs: 1000 })).toBeUndefined();
    expect((await blobs.list(blobs.keys.cache('frames'))).map((h) => h.key)).toEqual([cached]);
  });

  each('a put keeps the bytes’ SHA-256 and type; a large file goes up in parts', async (s) => {
    const { blobs } = s;
    const small = Buffer.from('{"a":1}');
    const a = blobs.keys.derived('alice', 'm_1', 'a.json');
    const made = await blobs.put(a, { bytes: small }, { type: 'application/json' });
    expect(made.sha256).toBe(sha(small));
    expect(await blobs.head(a)).toMatchObject({
      bytes: small.length,
      sha256: sha(small),
      type: 'application/json',
      refs: 1,
    });
    // Three parts of 5 MiB and a short one, sent side by side.
    const big = randomBytes(16 * MIB + 12_345);
    const file = join(s.work, 'big.bin');
    await writeFile(file, big);
    const b = blobs.keys.media('alice', 'm_1', 'source.bin');
    const head = await blobs.put(b, { file });
    expect(head).toMatchObject({ bytes: big.length, sha256: sha(big) });
    expect((await blobs.head(b))?.sha256).toBe(sha(big));
    expect(sha(await bytes(await blobs.get(b)))).toBe(sha(big));
    expect(
      (await bytes(await blobs.getRange(b, 5 * MIB - 2, 5 * MIB + 1))).equals(
        big.subarray(5 * MIB - 2, 5 * MIB + 2),
      ),
    ).toBe(true);
    // A stream longer than a part, too; its hash is not known before it ends.
    const c = blobs.keys.output('alice', 'j_1', 'stream.bin');
    const streamed = await blobs.put(c, {
      stream: Readable.from([big.subarray(0, 7 * MIB), big.subarray(7 * MIB)]),
    });
    expect(streamed.bytes).toBe(big.length);
    expect(sha(await bytes(await blobs.get(c)))).toBe(sha(big));
  });

  each(
    'a copy larger than one request takes is made in parts, and keeps the hash',
    async (s) => {
      const { blobs } = s;
      const big = randomBytes(11 * MIB + 7);
      const from = blobs.keys.output('alice', 'j_1', 'a.bin');
      await blobs.put(from, { bytes: big });
      const to = blobs.keys.media('alice', 'm_1', 'source.bin');
      expect((await blobs.copy(from, to)).bytes).toBe(big.length);
      expect(sha(await bytes(await blobs.get(to)))).toBe(sha(big));
      expect((await blobs.head(to))?.sha256).toBe(sha(big));
    },
    { copyPartBytes: 5 * MIB },
  );

  each('a link to a blob downloads it under the name and type asked for', async ({ blobs }) => {
    const key = blobs.keys.output('alice', 'j_1', 'out.bin');
    const body = randomBytes(4096);
    await blobs.put(key, { bytes: body });
    const link = (await blobs.presignGet(key, {
      ttlMs: 60_000,
      disposition: 'attachment; filename="clip one.mp4"',
      type: 'video/mp4',
    })) as string;
    expect(link.startsWith(blobs.origin)).toBe(true);
    const res = await fetch(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="clip one.mp4"');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    const part = await fetch(link, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/4096');
    expect(Buffer.from(await part.arrayBuffer()).equals(body.subarray(10, 20))).toBe(true);
    // The link is the permission: without its signature the bucket answers nothing.
    expect((await fetch(link.split('?')[0] as string)).status).toBe(403);
  });

  each('a media file counts its holders in the blobs records; others are copied', async (s) => {
    const { blobs, records } = s;
    const a = blobs.keys.media('alice', 'm_1', 'source.bin');
    await blobs.put(a, { bytes: Buffer.alloc(100, 1) });
    const kept = records.collection(BLOBS, { owner: 'alice' });
    expect(await kept.find()).toEqual([]);
    // Two more holders: one object, three holders, counted once.
    expect(await blobs.share(a, blobs.keys.media('alice', 'm_2', 'source.bin'))).toBe(a);
    expect(await blobs.share(a, blobs.keys.media('alice', 'm_3', 'source.bin'))).toBe(a);
    expect((await kept.find()).map((r) => r.value)).toEqual([{ key: a, refs: 3 }]);
    expect((await blobs.list(blobs.keys.owner('alice'))).map((h) => [h.key, h.refs])).toEqual([
      [a, 3],
    ]);
    expect(await blobs.usage('alice')).toBe(100);
    expect(await blobs.freeable(blobs.keys.owner('alice'))).toBe(0);
    await blobs.delete(a);
    await blobs.delete(a);
    expect((await blobs.head(a))?.refs).toBe(1);
    expect(await blobs.freeable(blobs.keys.owner('alice'))).toBe(100);
    await blobs.delete(a);
    expect(await blobs.head(a)).toBeUndefined();
    expect(await kept.find()).toEqual([]);
    // A holder of nothing is refused.
    expect(isMissing(await blobs.share(a, 'media/alice/m_4/source.bin').catch((e) => e))).toBe(
      true,
    );
    expect(await kept.find()).toEqual([]);
    // A derived file is not shared: the second holder has a copy of its own.
    const d = blobs.keys.derived('alice', 'm_1', 'search', 'index.json');
    await blobs.put(d, { bytes: Buffer.from('{}') });
    const copy = blobs.keys.derived('alice', 'm_2', 'search', 'index.json');
    expect(await blobs.share(d, copy)).toBe(copy);
    await blobs.delete(d);
    expect((await bytes(await blobs.get(copy))).toString()).toBe('{}');
  });

  // On MongoDB: the filesystem's records are one process's, and a record being written for
  // the first time can be read empty by another reader there.
  (mongo ? each : each.skip)(
    'holders added and removed at once never lose the file or leak it',
    async ({ blobs }) => {
      const a = blobs.keys.media('alice', 'm_1', 'source.bin');
      await blobs.put(a, { bytes: Buffer.alloc(10) });
      await Promise.all(Array.from({ length: 8 }, () => blobs.share(a, 'media/alice/x/y')));
      expect((await blobs.head(a))?.refs).toBe(9);
      await Promise.all(Array.from({ length: 8 }, () => blobs.delete(a)));
      expect((await blobs.head(a))?.refs).toBe(1);
      // The last holder leaving while another arrives: the file is gone and the newcomer is told,
      // or it stays with exactly one holder.
      const [, shared] = await Promise.all([
        blobs.delete(a),
        blobs.share(a, 'media/alice/x/y').then(
          () => true,
          (e) => {
            expect(isMissing(e)).toBe(true);
            return false;
          },
        ),
      ]);
      const head = await blobs.head(a);
      if (shared) expect(head?.refs).toBe(1);
      else expect(head).toBeUndefined();
    },
    { mongo: true },
  );

  each('deletePrefix spares a media file another still holds; forget spares nothing', async (s) => {
    const { blobs, records } = s;
    const a = blobs.keys.media('alice', 'm_1', 'source.bin');
    await blobs.put(a, { bytes: Buffer.alloc(10) });
    await blobs.share(a, blobs.keys.media('alice', 'm_2', 'source.bin'));
    await blobs.put(blobs.keys.derived('alice', 'm_1', 'analyses', 't.json'), {
      bytes: Buffer.from('{}'),
    });
    await blobs.put(blobs.keys.output('alice', 'j_1', 'o.bin'), { bytes: Buffer.alloc(5) });
    await blobs.put(blobs.keys.output('bob', 'j_1', 'o.bin'), { bytes: Buffer.alloc(7) });
    const open = blobs.keys.upload('alice', 'u_1', 'data.bin');
    const id = await blobs.multipartStart(open);
    await blobs.multipartPart(open, id, 1, Readable.from([Buffer.alloc(100)]));
    await blobs.deletePrefix(`${blobs.keys.owner('alice')}/m_1`);
    expect((await blobs.head(a))?.refs).toBe(1);
    await blobs.forget('alice');
    expect(await blobs.usage('alice')).toBe(0);
    for (const prefix of ['media/alice', 'derived/alice', 'outputs/alice']) {
      expect(await blobs.list(prefix)).toEqual([]);
    }
    expect(await records.collection(BLOBS, { owner: 'alice' }).find()).toEqual([]);
    // (Its upload in parts is aborted too where the store lists uploads by prefix; MinIO lists
    // them only by their exact key, so that is not looked at here.)
    expect(await blobs.list(`${open}.parts`)).toEqual([]);
    expect(await blobs.usage('bob')).toBe(7);
  });

  each(
    'a write that must not replace is decided by the bucket, or claimed in the records',
    async (s) => {
      expect(await s.blobs.conditionalWrites()).toBe(true);
      const other = await s3Stores({ conditionalWrites: false });
      try {
        const { blobs } = other;
        const to = blobs.keys.derived('alice', 'm_1', 'analyses', 'transcript.json');
        const temps = ['a', 'b', 'c', 'd'].map((n) => `${to}.${n}.tmp`);
        for (const [i, temp] of temps.entries())
          await blobs.put(temp, { bytes: Buffer.from(`${i}`) });
        const moved = await Promise.all(
          temps.map((temp) =>
            blobs.move(temp, to, { ifAbsent: true }).then(
              () => true,
              (e) => {
                expect(isExisting(e)).toBe(true);
                return false;
              },
            ),
          ),
        );
        expect(moved.filter(Boolean)).toHaveLength(1);
        expect((await bytes(await blobs.get(to))).toString()).toBe(String(moved.indexOf(true)));
        // No claim is left behind.
        expect(await other.records.collection(BLOBS, { owner: 'alice' }).find()).toEqual([]);
      } finally {
        await other.close();
      }
    },
  );

  each('in-order parts of any size: what does not fill a part waits beside the blob', async (s) => {
    const { blobs } = s;
    const key = blobs.keys.upload('alice', 'u_1', 'data.bin');
    const body = randomBytes(13 * MIB + 321);
    // Odd sizes: under 5 MiB, across a part's edge, tiny, and the rest.
    const cuts = [0, 1_000_003, 6 * MIB + 17, 6 * MIB + 18, 9 * MIB, body.length];
    const id = await blobs.multipartStart(key);
    let last: BlobPart | undefined;
    for (let i = 1; i < cuts.length; i += 1) {
      const chunk = body.subarray(cuts[i - 1], cuts[i]);
      last = await blobs.multipartPart(key, id, i, Readable.from([chunk]), {
        bytes: chunk.length,
        ...(last ? { after: last } : {}),
      });
      expect(last).toMatchObject({ part: i, bytes: chunk.length });
    }
    // Before it is complete the blob does not exist; the bytes not yet in a part are held.
    expect(await blobs.head(key)).toBeUndefined();
    expect((await blobs.list(`${key}.parts`)).length).toBeGreaterThan(0);
    const head = await blobs.multipartComplete(key, id, [last as BlobPart]);
    expect(head.bytes).toBe(body.length);
    expect(sha(await bytes(await blobs.get(key)))).toBe(sha(body));
    expect(await blobs.list(`${key}.parts`)).toEqual([]);
  });

  each('a part that breaks off keeps what arrived; the next continues from there', async (s) => {
    const { blobs } = s;
    const key = blobs.keys.upload('alice', 'u_2', 'data.bin');
    const body = randomBytes(7 * MIB);
    const id = await blobs.multipartStart(key);
    const breaking = async function* () {
      yield body.subarray(0, 6 * MIB);
      throw new Error('socket hang up');
    };
    const error = (await blobs
      .multipartPart(key, id, 1, Readable.from(breaking()))
      .catch((e) => e)) as { landed?: BlobPart };
    expect(error.landed).toMatchObject({ part: 1, bytes: 6 * MIB });
    const rest = await blobs.multipartPart(key, id, 2, Readable.from([body.subarray(6 * MIB)]), {
      after: error.landed as BlobPart,
    });
    await blobs.multipartComplete(key, id, [rest]);
    expect(sha(await bytes(await blobs.get(key)))).toBe(sha(body));
    // An empty upload is an empty blob.
    const none = blobs.keys.upload('alice', 'u_3', 'data.bin');
    expect((await blobs.multipartComplete(none, await blobs.multipartStart(none), [])).bytes).toBe(
      0,
    );
    expect((await blobs.head(none))?.bytes).toBe(0);
  });

  each('numbered parts of one size arrive in any order, several at once', async ({ blobs }) => {
    const key = blobs.keys.upload('alice', 'u_4', 'data.bin');
    const body = randomBytes(12 * MIB + 99);
    const size = partSize(body.length, 5 * MIB);
    const id = await blobs.multipartStart(key);
    const send = (n: number) => {
      const chunk = body.subarray((n - 1) * size, n * size);
      return blobs.multipartPart(key, id, n, Readable.from([chunk]), {
        bytes: chunk.length,
        anyOrder: true,
      });
    };
    const parts = await Promise.all([send(3), send(1), send(2)]);
    // One sent again replaces itself.
    parts[1] = await send(1);
    expect((await blobs.multipartParts(key, id)).map((p) => p.part)).toEqual([1, 2, 3]);
    expect((await blobs.multipartComplete(key, id, parts)).bytes).toBe(body.length);
    expect(sha(await bytes(await blobs.get(key)))).toBe(sha(body));
    expect(partSize(100 * 1024 ** 3, 16 * MIB)).toBe(16 * MIB);
    expect(Math.ceil((200 * 1024 ** 3) / partSize(200 * 1024 ** 3, 16 * MIB))).toBeLessThanOrEqual(
      10_000,
    );
  });

  each('expire goes by the newest write, or a later touch', async (s) => {
    const { blobs } = s;
    const a = blobs.keys.output('alice', 'f_a', '1.png');
    await blobs.put(a, { bytes: Buffer.from('1') });
    const outputs = blobs.keys.outputs('alice');
    expect(await blobs.expire(outputs, 60_000)).toEqual([]);
    await s.age.blob('outputs/alice/f_a', 3_600_000);
    // Written again after it was last marked used: the write counts.
    await new Promise((r) => setTimeout(r, 2100));
    await blobs.put(blobs.keys.output('alice', 'f_a', '2.png'), { bytes: Buffer.from('2') });
    expect(await blobs.expire(outputs, 60_000)).toEqual([]);
    await s.age.blob('outputs/alice/f_a', 3_600_000);
    expect(await blobs.expire(outputs, 60_000)).toEqual(['f_a']);
    expect(await blobs.list(outputs)).toEqual([]);
    expect(await s.records.collection(BLOBS, { owner: 'alice' }).find()).toEqual([]);
  });

  each('the orphan sweep closes what a crash between bucket and records leaves', async (s) => {
    const { blobs, records } = s;
    const kept = records.collection(BLOBS, { owner: 'alice' });
    const put = async (key: string) => {
      await blobs.put(key, { bytes: Buffer.alloc(10) });
      return key;
    };
    // Held by one media; its count says three (two holders crashed before saving).
    const held = await put(blobs.keys.media('alice', 'm_held', 'source.bin'));
    await blobs.share(held, 'x');
    await blobs.share(held, 'x');
    // Written, then its media never saved.
    const unheld = await put(blobs.keys.media('alice', 'm_lost', 'source.bin'));
    // Its last holder said it was going, then died before removing it.
    const going = await put(blobs.keys.media('alice', 'm_going', 'source.bin'));
    await kept.put('going', { key: going, refs: 0 });
    // A record whose object went.
    await kept.put('gone', { key: blobs.keys.media('alice', 'm_gone', 'source.bin'), refs: 2 });
    // Derived files of a media with no record, and of one that has it.
    const stale = await put(blobs.keys.derived('alice', 'm_lost', 'analyses', 't.json'));
    const live = await put(blobs.keys.derived('alice', 'm_held', 'analyses', 't.json'));
    // An upload still arriving holds its own state.
    const upload = blobs.keys.upload('alice', 'u_1', 'data.bin');
    const id = await blobs.multipartStart(upload);
    await blobs.multipartPart(upload, id, 1, Readable.from([Buffer.alloc(10)]));
    const holders = {
      held: new Map([
        [held, 1],
        [upload, 1],
      ]),
      media: new Set(['m_held']),
    };
    // Nothing is judged while it may be mid-write.
    expect(await blobs.orphans(owner(), holders, 3_600_000)).toEqual({
      records: 0,
      objects: 0,
      refs: 0,
    });
    expect(await blobs.orphans(owner(), holders, -1000)).toEqual({
      records: 2,
      objects: 3,
      refs: 1,
    });
    expect((await blobs.head(held))?.refs).toBe(1);
    for (const key of [unheld, going, stale]) expect(await blobs.head(key)).toBeUndefined();
    expect(await blobs.head(live)).toBeDefined();
    expect((await blobs.list(`${upload}.parts`)).length).toBe(1);
    expect((await kept.find()).map((r) => r.value)).toEqual([{ key: held, refs: 1 }]);
    function owner() {
      return 'alice';
    }
  });

  each('a failure reaches the caller in plain words; the log has the detail', async (s) => {
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A part of an upload that was never started.
      const key = s.blobs.keys.upload('alice', 'u_1', 'data.bin');
      const error = (await s.blobs
        .multipartPart(key, 'no-such-upload', 1, Readable.from([Buffer.alloc(6 * MIB)]))
        .catch((e) => e)) as Error & { code?: string };
      expect(isMissing(error) || error.code === 'service_unavailable').toBe(true);
      expect((error as { landed?: unknown }).landed).toBeUndefined();
      const bad = await s3Stores();
      try {
        const broken = new (bad.blobs.constructor as typeof import('../src/index.ts').S3BlobStore)({
          ...bad.settings,
          secretAccessKey: 'not-the-secret-key',
          records: bad.records,
          local: undefined as never,
        });
        const refused = (await broken
          .put('outputs/alice/j_1/a', { bytes: Buffer.from('x') })
          .catch((e) => e)) as Error & { code?: string; hint?: string };
        expect(refused.code).toBe('service_unavailable');
        expect(refused.message).toBe('The server could not read or write a file just now');
        const said = `${refused.message} ${refused.hint}`;
        for (const secret of [TEST_S3.endpoint, bad.settings.bucket, 'not-the-secret-key']) {
          expect(said).not.toContain(secret);
        }
        const start = (await broken.ready().catch((e) => e)) as Error;
        expect(start.message).toMatch(/^The bucket refused CUTTINGFLOOR_S3_ACCESS_KEY_ID/);
        const logged = log.mock.calls.map((c) => String(c[0])).join('');
        expect(logged).toMatch(/blobs: put outputs\/alice\/j_1\/a: /);
        expect(logged).not.toContain('not-the-secret-key');
        expect(logged).not.toContain(TEST_S3.secretAccessKey);
        await broken.close();
      } finally {
        await bad.close();
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe.skipIf(!up)('S3 scratch: this node’s copies', () => {
  const each = (name: string, run: (s: Awaited<ReturnType<typeof s3Stores>>) => Promise<void>) =>
    it(name, async () => {
      const s = await s3Stores();
      try {
        await run(s);
      } finally {
        await s.close();
      }
    });

  each('a blob written again is never served as it was', async ({ blobs, scratch }) => {
    const key = blobs.keys.derived('alice', 'm_1', 'search', 'failed.json');
    await blobs.put(key, { bytes: Buffer.from('first') });
    const first = await scratch.materialize(key);
    expect(await readFile(first, 'utf8')).toBe('first');
    // The same length, so nothing but the store's tag tells them apart.
    await blobs.put(key, { bytes: Buffer.from('later') });
    const later = await scratch.materialize(key);
    expect(await readFile(later, 'utf8')).toBe('later');
    expect(later).not.toBe(first);
    expect(later.endsWith('failed.json')).toBe(true);
    // A copy already handed out is left as it was for whoever is reading it.
    expect(await readFile(first, 'utf8')).toBe('first');
    // A blob that is not there has a path that names nothing, as on the filesystem.
    const none = await scratch.materialize(blobs.keys.derived('alice', 'm_1', 'none.json'));
    expect(isMissing(await readFile(none).catch((e) => e))).toBe(true);
  });

  each('requests for one blob at one moment download it once, in ranges', async (s) => {
    const { blobs, scratch } = s;
    const key = blobs.keys.media('alice', 'm_1', 'source.bin');
    const body = randomBytes(12 * MIB + 5);
    await blobs.put(key, { bytes: body });
    const read = vi.spyOn(blobs, 'read');
    const paths = await Promise.all(Array.from({ length: 6 }, () => scratch.materialize(key)));
    expect(new Set(paths).size).toBe(1);
    expect(sha(await readFile(paths[0] as string))).toBe(sha(body));
    // Three ranges of 5 MiB (the last short), fetched once between the six.
    expect(read.mock.calls.map((c) => [c[1].start, c[1].end]).sort((a, b) => a[0] - b[0])).toEqual([
      [0, 5 * MIB - 1],
      [5 * MIB, 10 * MIB - 1],
      [10 * MIB, body.length - 1],
    ]);
    expect(read.mock.calls.every((c) => Boolean(c[1].etag))).toBe(true);
    await scratch.materialize(key);
    expect(read).toHaveBeenCalledTimes(3);
  });

  each('publish stores the file and keeps a copy the writer cannot change', async (s) => {
    const { blobs, scratch } = s;
    const key = blobs.keys.media('alice', 'm_1', 'proxy.mov');
    const path = await scratch.reserve(key);
    await writeFile(path, 'made by an engine');
    await scratch.publish(path, key);
    expect(scratch.keyOf(path)).toBe(key);
    const read = vi.spyOn(blobs, 'read');
    const copy = await scratch.materialize(key);
    expect(await readFile(copy, 'utf8')).toBe('made by an engine');
    expect(read).not.toHaveBeenCalled();
    // The engine writes its file again: the copy of what was stored does not change with it.
    await writeFile(path, 'made a second time');
    expect(await readFile(copy, 'utf8')).toBe('made by an engine');
    await scratch.publish(path, key);
    expect(await readFile(await scratch.materialize(key), 'utf8')).toBe('made a second time');
  });

  each('a folder follows the store: fetched once, changes and removals picked up', async (s) => {
    const { blobs, scratch } = s;
    const prefix = blobs.keys.derived('alice', 'm_1', 'search');
    await blobs.put(`${prefix}/index.json`, { bytes: Buffer.from('{"v":1}') });
    await blobs.put(`${prefix}/failed.json`, { bytes: Buffer.from('no') });
    await blobs.put(`${prefix}/keys/0.jpg`, { bytes: Buffer.from('jpg') });
    const read = vi.spyOn(blobs, 'read');
    const dir = await scratch.materializeDir(prefix);
    expect(await readFile(join(dir, 'keys', '0.jpg'), 'utf8')).toBe('jpg');
    expect(read).toHaveBeenCalledTimes(3);
    await scratch.materializeDir(prefix);
    expect(read).toHaveBeenCalledTimes(3);
    // Another server writes one again and removes another; an engine here writes a new one.
    await blobs.put(`${prefix}/index.json`, { bytes: Buffer.from('{"v":2}') });
    await blobs.delete(`${prefix}/failed.json`);
    await writeFile(join(dir, 'vectors.f32'), 'vec');
    expect(await scratch.materializeDir(prefix)).toBe(dir);
    expect(await readFile(join(dir, 'index.json'), 'utf8')).toBe('{"v":2}');
    expect((await readdir(dir)).sort()).toEqual(['index.json', 'keys', 'vectors.f32']);
    const put = vi.spyOn(blobs, 'put');
    await scratch.publishDir(dir, prefix);
    expect(put.mock.calls.map((c) => c[0])).toEqual([`${prefix}/vectors.f32`]);
    await scratch.publishDir(dir, prefix);
    expect(put).toHaveBeenCalledTimes(1);
    // One file of a folder of many: only it is fetched, and only it is stored.
    const big = blobs.keys.derived('alice', 'm_1', 'between');
    await blobs.put(`${big}/a.mov`, { bytes: Buffer.from('a') });
    await blobs.put(`${big}/b.mov`, { bytes: Buffer.from('b') });
    const only = await scratch.materializeDir(big, { only: ['b.mov', 'c.mov'] });
    expect(await readdir(only)).toEqual(['b.mov']);
    await writeFile(join(only, 'c.mov'), 'c');
    await writeFile(join(only, 'd.mov.tmp'), 'half');
    await scratch.publishDir(only, big, { only: ['c.mov'] });
    expect((await blobs.list(big)).map((h) => h.key.slice(big.length + 1))).toEqual([
      'a.mov',
      'b.mov',
      'c.mov',
    ]);
  });

  each('over its cap the least recently used goes, never what was just handed out', async (s) => {
    const { blobs } = s;
    const scratch = new S3Scratch(blobs, undefined as never, {
      dir: join(s.root, 'small-cache'),
      maxBytes: 250_000,
      graceMs: 0,
    });
    const keys = ['a', 'b', 'c'].map((n) => blobs.keys.media('alice', `m_${n}`, 'source.bin'));
    for (const key of keys) await blobs.put(key, { bytes: randomBytes(100_000) });
    const a = await scratch.materialize(keys[0] as string);
    const old = new Date(Date.now() - 60_000);
    await utimes(a, old, old);
    const b = await scratch.materialize(keys[1] as string);
    await scratch.evict();
    const c = await scratch.materialize(keys[2] as string);
    await scratch.evict();
    const there = async (p: string) =>
      stat(p).then(
        () => true,
        () => false,
      );
    // Three would be 300 kB: the one used longest ago went.
    expect([await there(a), await there(b), await there(c)]).toEqual([false, true, true]);
    // Asked for again, it is fetched again, whole.
    expect((await readFile(await scratch.materialize(keys[0] as string))).length).toBe(100_000);
    // With a grace period, nothing recently used goes even over the cap.
    const patient = new S3Scratch(blobs, undefined as never, {
      dir: join(s.root, 'patient-cache'),
      maxBytes: 1,
      graceMs: 3_600_000,
    });
    const kept = await patient.materialize(keys[0] as string);
    await patient.evict();
    expect(await there(kept)).toBe(true);
  });
});

describe('CUTTINGFLOOR_BLOBS', () => {
  const env = {
    CUTTINGFLOOR_BLOBS: 's3',
    CUTTINGFLOOR_S3_ENDPOINT: 'https://fsn1.your-objectstorage.com/',
    CUTTINGFLOOR_S3_REGION: 'fsn1',
    CUTTINGFLOOR_S3_BUCKET: 'cuttingfloor-prod',
    CUTTINGFLOOR_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE\n',
    CUTTINGFLOOR_S3_SECRET_ACCESS_KEY: 'hunter2-hunter2-hunter2\n',
  };

  it('is the filesystem unless it says s3', () => {
    expect(s3SettingsFromEnv({})).toBeUndefined();
    expect(s3SettingsFromEnv({ CUTTINGFLOOR_BLOBS: 'fs' })).toBeUndefined();
    // The keys alone change nothing: a server keeps its files until it is told otherwise.
    expect(s3SettingsFromEnv({ ...env, CUTTINGFLOOR_BLOBS: '' })).toBeUndefined();
    expect(() => s3SettingsFromEnv({ CUTTINGFLOOR_BLOBS: 'gcs' })).toThrow(/fs or s3$/);
  });

  it('takes the bucket as a host under the endpoint, with defaults for the rest', () => {
    expect(s3SettingsFromEnv(env)).toEqual({
      endpoint: 'https://fsn1.your-objectstorage.com',
      region: 'fsn1',
      bucket: 'cuttingfloor-prod',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'hunter2-hunter2-hunter2',
      pathStyle: false,
      cacheBytes: 50 * 1024 ** 3,
      partBytes: 16 * MIB,
      concurrency: 6,
      connections: 64,
    });
    expect(
      s3SettingsFromEnv({
        ...env,
        CUTTINGFLOOR_S3_PATH_STYLE: '1',
        CUTTINGFLOOR_BLOB_CACHE: '/mnt/nvme/blobs',
        CUTTINGFLOOR_BLOB_CACHE_GB: '200',
        CUTTINGFLOOR_S3_PART_MB: '32',
        CUTTINGFLOOR_S3_CONCURRENCY: '4',
        CUTTINGFLOOR_S3_CONNECTIONS: '32',
      }),
    ).toMatchObject({
      pathStyle: true,
      cacheDir: '/mnt/nvme/blobs',
      cacheBytes: 200 * 1024 ** 3,
      partBytes: 32 * MIB,
      concurrency: 4,
      connections: 32,
    });
  });

  it('says which variable is missing or wrong, never what one holds', () => {
    for (const name of Object.keys(env).filter((k) => k !== 'CUTTINGFLOOR_BLOBS')) {
      expect(() => s3SettingsFromEnv({ ...env, [name]: ' ' })).toThrow(
        new RegExp(`^CUTTINGFLOOR_BLOBS=s3 needs ${name}$`),
      );
    }
    const secret = 'hunter2-hunter2-hunter2';
    for (const bad of [
      { CUTTINGFLOOR_BLOBS: secret },
      { CUTTINGFLOOR_S3_ENDPOINT: `https://key:${secret}@fsn1.your-objectstorage.com` },
      { CUTTINGFLOOR_S3_ENDPOINT: secret },
      { CUTTINGFLOOR_S3_BUCKET: `${secret}/UPPER` },
      { CUTTINGFLOOR_S3_PART_MB: '1' },
      { CUTTINGFLOOR_S3_CONNECTIONS: '100000' },
      { CUTTINGFLOOR_BLOB_CACHE: 'relative/cache' },
    ]) {
      let message = '';
      try {
        s3SettingsFromEnv({ ...env, ...bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^CUTTINGFLOOR_/);
      expect(message).not.toContain(secret);
    }
  });
});
