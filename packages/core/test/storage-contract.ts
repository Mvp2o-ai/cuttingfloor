import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  type BlobStore,
  type CollectionScope,
  type CollectionSpec,
  defineCollection,
  isMissing,
  type Records,
  type Scratch,
} from '../src/index.ts';

// What every backend of the three stores must do. A backend's test file calls these with a
// factory that makes a fresh, empty store (see storage-fs.test.ts); a second backend runs the
// same suites.

export interface Stores {
  records: Records;
  blobs: BlobStore;
  scratch: Scratch;
  /** A local folder for the test's own files. */
  work: string;
  /** Makes a record or blob look last used `ms` ago. */
  age: {
    record(
      spec: CollectionSpec<unknown>,
      scope: CollectionScope,
      id: string,
      ms: number,
    ): Promise<void>;
    blob(key: string, ms: number): Promise<void>;
  };
  close(): Promise<void>;
}

export type StoresFactory = () => Promise<Stores>;

interface Thing {
  name: string;
  count?: number;
  state?: string;
  tags?: string[];
}

const things = defineCollection<Thing>({ name: 'things', scope: 'owner', fs: { dir: 'things' } });
const foldered = defineCollection<Thing>({
  name: 'foldered',
  scope: 'owner',
  fs: { dir: 'foldered', leaf: 'thing.json' },
});
const grouped = defineCollection<Thing>({
  name: 'grouped',
  scope: 'owner',
  fs: { dir: (parent) => `grouped/${parent}` },
});
const shared = defineCollection<Thing>({ name: 'shared', scope: 'global', fs: { dir: 'shared' } });
const lines = defineCollection<{ n: number }>({
  name: 'lines',
  scope: 'owner',
  fs: { dir: 'lines', ext: '.jsonl' },
});

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function withStores(make: StoresFactory, run: (s: Stores) => Promise<void>): Promise<void> {
  const stores = await make();
  try {
    await run(stores);
  } finally {
    await stores.close();
  }
}

export function recordsContract(backend: string, make: StoresFactory): void {
  const each = (name: string, run: (s: Stores) => Promise<void>) =>
    it(name, () => withStores(make, run));

  describe(`Records contract: ${backend}`, () => {
    for (const [kind, spec] of [
      ['a flat collection', things],
      ['a collection of folders', foldered],
    ] as const) {
      each(`${kind}: put, get, has, ids, delete`, async ({ records }) => {
        const c = records.collection(spec, { owner: 'alice' });
        expect(await c.get('a')).toBeUndefined();
        expect(await c.has('a')).toBe(false);
        await c.put('a', { name: 'first' });
        await c.put('b', { name: 'second' });
        expect(await c.get('a')).toEqual({ name: 'first' });
        expect(await c.has('a')).toBe(true);
        expect((await c.ids()).sort()).toEqual(['a', 'b']);
        await c.put('a', { name: 'replaced' });
        expect(await c.get('a')).toEqual({ name: 'replaced' });
        await c.delete('a');
        await c.delete('a');
        expect(await c.get('a')).toBeUndefined();
      });
    }

    each(
      'owners keep their own records, and a global collection is shared',
      async ({ records }) => {
        await records.collection(things, { owner: 'alice' }).put('a', { name: 'hers' });
        expect(await records.collection(things, { owner: 'bob' }).get('a')).toBeUndefined();
        expect((await records.owners()).sort()).toEqual(['alice']);
        await records.collection(shared).put('k', { name: 'all' });
        expect(await records.collection(shared).get('k')).toEqual({ name: 'all' });
        expect(() => records.collection(things)).toThrow();
      },
    );

    each('an owner that is not a safe name is kept under its key', async ({ records }) => {
      const owner = 'user|with/odd:characters';
      await records.collection(things, { owner }).put('a', { name: 'kept' });
      const [key] = await records.owners();
      expect(key).toMatch(/^h_[0-9a-f]{32}$/);
      expect(await records.collection(things, { owner: key as string }).get('a')).toEqual({
        name: 'kept',
      });
    });

    each('insertOnce: the first wins and the record stays', async ({ records }) => {
      const c = records.collection(things, { owner: 'alice' });
      expect(await c.insertOnce('a', { name: 'first' })).toBe(true);
      expect(await c.insertOnce('a', { name: 'second' })).toBe(false);
      expect(await c.get('a')).toEqual({ name: 'first' });
    });

    each('insertOnce: of many at once, exactly one wins', async ({ records }) => {
      const c = records.collection(things, { owner: 'alice' });
      const won = await Promise.all(
        Array.from({ length: 12 }, (_, i) => c.insertOnce('race', { name: `n${i}` })),
      );
      expect(won.filter(Boolean)).toHaveLength(1);
      expect((await c.get('race'))?.name).toBe(`n${won.indexOf(true)}`);
    });

    each('update sets fields and adds to numbers; a missing record stays missing', async (s) => {
      const c = s.records.collection(things, { owner: 'alice' });
      expect(await c.update('a', { set: { name: 'x' } })).toBeUndefined();
      expect(await c.get('a')).toBeUndefined();
      await c.put('a', { name: 'first', tags: ['t'] });
      expect(await c.update('a', { set: { state: 'on' }, inc: { count: 2 } })).toEqual({
        name: 'first',
        tags: ['t'],
        state: 'on',
        count: 2,
      });
      expect(await c.update('a', { inc: { count: 3 } })).toMatchObject({ count: 5 });
    });

    each('update: adds made at once all count', async ({ records }) => {
      const c = records.collection(things, { owner: 'alice' });
      await c.put('a', { name: 'n', count: 0 });
      await Promise.all(Array.from({ length: 20 }, () => c.update('a', { inc: { count: 1 } })));
      expect((await c.get('a'))?.count).toBe(20);
    });

    each('compareAndSet writes only when the expected fields match', async ({ records }) => {
      const c = records.collection(things, { owner: 'alice' });
      expect(await c.compareAndSet('a', { count: 0 }, { count: 1 })).toBe(false);
      await c.put('a', { name: 'n', count: 0, tags: ['x'] });
      expect(await c.compareAndSet('a', { count: 1 }, { count: 9 })).toBe(false);
      expect(await c.compareAndSet('a', { count: 0, tags: ['x'] }, { count: 5 })).toBe(true);
      expect(await c.get('a')).toEqual({ name: 'n', count: 5, tags: ['x'] });
    });

    each('compareAndSet: of many at once from one value, exactly one wins', async ({ records }) => {
      const c = records.collection(things, { owner: 'alice' });
      await c.put('a', { name: 'n', count: 0 });
      const won = await Promise.all(
        Array.from({ length: 10 }, (_, i) => c.compareAndSet('a', { count: 0 }, { count: i + 1 })),
      );
      expect(won.filter(Boolean)).toHaveLength(1);
      expect((await c.get('a'))?.count).toBe(won.indexOf(true) + 1);
    });

    each('find: every record, or those whose fields match', async ({ records }) => {
      const c = records.collection(things, { owner: 'alice' });
      await c.put('a', { name: 'one', state: 'on' });
      await c.put('b', { name: 'two', state: 'off' });
      await c.put('c', { name: 'three', state: 'on' });
      expect((await c.find()).map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);
      const on = await c.find({ state: 'on' });
      expect(on.map((e) => e.id).sort()).toEqual(['a', 'c']);
      expect(on[0]?.usedAt).toBeInstanceOf(Date);
      expect(on.find((e) => e.id === 'c')?.value).toEqual({ name: 'three', state: 'on' });
    });

    each('last use: writes and touches move it, a plain read does not', async (s) => {
      const c = s.records.collection(things, { owner: 'alice' });
      expect(await c.usedAt('a')).toBeUndefined();
      await c.touch('a');
      await c.put('a', { name: 'n' });
      await s.age.record(things, { owner: 'alice' }, 'a', 60_000);
      const old = (await c.usedAt('a')) as Date;
      expect(Date.now() - old.getTime()).toBeGreaterThan(50_000);
      await c.get('a');
      expect((await c.usedAt('a'))?.getTime()).toBe(old.getTime());
      await c.get('a', { touch: true });
      expect(Date.now() - ((await c.usedAt('a')) as Date).getTime()).toBeLessThan(10_000);
      await s.age.record(things, { owner: 'alice' }, 'a', 60_000);
      await c.touch('a');
      expect(Date.now() - ((await c.usedAt('a')) as Date).getTime()).toBeLessThan(10_000);
    });

    for (const [kind, spec] of [
      ['a flat collection', things],
      ['a collection of folders', foldered],
    ] as const) {
      each(`${kind}: expire removes what is past its time, sparing kept ids`, async (s) => {
        const c = s.records.collection(spec, { owner: 'alice' });
        for (const id of ['old', 'kept', 'fresh']) await c.put(id, { name: id });
        await s.age.record(spec, { owner: 'alice' }, 'old', 3_600_000);
        await s.age.record(spec, { owner: 'alice' }, 'kept', 3_600_000);
        expect(await c.expire(60_000, (id) => id === 'kept')).toEqual(['old']);
        expect((await c.ids()).sort()).toEqual(['fresh', 'kept']);
        expect(await c.expire(60_000)).toEqual(['kept']);
      });
    }

    each('a grouped collection keeps each parent apart and lists its parents', async (s) => {
      const jan = s.records.collection(grouped, { owner: 'alice', parent: '2026-01' });
      const feb = s.records.collection(grouped, { owner: 'alice', parent: '2026-02' });
      await jan.put('a', { name: 'jan' });
      await feb.put('a', { name: 'feb' });
      expect(await jan.get('a')).toEqual({ name: 'jan' });
      expect(await feb.get('a')).toEqual({ name: 'feb' });
      expect((await s.records.parents(grouped, { owner: 'alice' })).sort()).toEqual([
        '2026-01',
        '2026-02',
      ]);
      expect(() => s.records.collection(grouped, { owner: 'alice' })).toThrow();
    });

    each('ids that could leave the collection are refused', async ({ records }) => {
      const c = records.collection(things, { owner: 'alice' });
      for (const id of ['', '../x', 'a/b', '.hidden']) {
        await expect(async () => c.get(id)).rejects.toThrow();
      }
    });

    each('a log keeps every entry of every part', async ({ records }) => {
      const one = records.log(lines, { owner: 'alice', part: '2026-01-01.a' });
      const two = records.log(lines, { owner: 'alice', part: '2026-01-01.b' });
      await one.append({ n: 1 });
      await two.append({ n: 2 });
      await one.append({ n: 3 });
      expect((await one.read()).map((e) => e.n).sort()).toEqual([1, 2, 3]);
      expect(await records.log(lines, { owner: 'bob', part: 'x' }).read()).toEqual([]);
      await one.expire(3_600_000);
      expect(await two.read()).toHaveLength(3);
    });

    each('every account has a home', async ({ records }) => {
      expect(await records.home('alice')).toEqual(expect.any(String));
      expect(await records.home('alice')).toBe(await records.home('alice'));
    });
  });
}

export function blobStoreContract(backend: string, make: StoresFactory): void {
  const each = (name: string, run: (s: Stores) => Promise<void>) =>
    it(name, () => withStores(make, run));

  describe(`BlobStore contract: ${backend}`, () => {
    each('keys are relative names, apart per owner, media and kind', async ({ blobs }) => {
      const keys = [
        blobs.keys.media('alice', 'm_1', 'source.mp4'),
        blobs.keys.media('bob', 'm_1', 'source.mp4'),
        blobs.keys.derived('alice', 'm_1', 'cleaned', 'a.wav'),
        blobs.keys.output('alice', 'j_1', 'out.mp4'),
        blobs.keys.upload('alice', 'u_1', 'data.mp4'),
        blobs.keys.cache('frames', 'x.png'),
      ];
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(key.startsWith('/')).toBe(false);
    });

    each('put from bytes, a stream and a file; get, head and a range', async (s) => {
      const { blobs } = s;
      const a = blobs.keys.output('alice', 'j_1', 'a.txt');
      const head = await blobs.put(a, { bytes: Buffer.from('hello blob') });
      expect(head).toMatchObject({ key: a, bytes: 10, refs: 1 });
      expect(head.modifiedAt).toBeInstanceOf(Date);
      expect(await text(await blobs.get(a))).toBe('hello blob');
      expect(await text(await blobs.getRange(a, 6))).toBe('blob');
      expect(await text(await blobs.getRange(a, 0, 4))).toBe('hello');
      expect(await blobs.head(a)).toMatchObject({ key: a, bytes: 10 });

      const b = blobs.keys.output('alice', 'j_1', 'b.txt');
      await blobs.put(b, { stream: Readable.from([Buffer.from('from '), Buffer.from('stream')]) });
      expect(await text(await blobs.get(b))).toBe('from stream');

      const local = join(s.work, 'local.txt');
      await writeFile(local, 'from file');
      const c = blobs.keys.output('alice', 'j_1', 'c.txt');
      await blobs.put(c, { file: local });
      expect(await text(await blobs.get(c))).toBe('from file');
      expect(await readFile(local, 'utf8')).toBe('from file');
      const d = blobs.keys.output('alice', 'j_1', 'd.txt');
      await blobs.put(d, { file: local, move: true });
      expect(await text(await blobs.get(d))).toBe('from file');

      await blobs.put(a, { bytes: Buffer.from('new') });
      expect(await text(await blobs.get(a))).toBe('new');
    });

    each(
      'a missing blob: head is undefined, get rejects as missing, delete is quiet',
      async (s) => {
        const key = s.blobs.keys.output('alice', 'j_1', 'none.txt');
        expect(await s.blobs.head(key)).toBeUndefined();
        const error = await s.blobs.get(key).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isMissing(error)).toBe(true);
        await s.blobs.delete(key);
      },
    );

    each('list, delete and deletePrefix', async ({ blobs }) => {
      for (const name of ['a.txt', 'b.txt']) {
        await blobs.put(blobs.keys.output('alice', 'j_1', name), { bytes: Buffer.from(name) });
      }
      await blobs.put(blobs.keys.output('alice', 'j_2', 'c.txt'), { bytes: Buffer.from('c') });
      const prefix = blobs.keys.output('alice', 'j_1', '');
      expect((await blobs.list(prefix)).map((h) => h.key)).toEqual([
        blobs.keys.output('alice', 'j_1', 'a.txt'),
        blobs.keys.output('alice', 'j_1', 'b.txt'),
      ]);
      await blobs.delete(blobs.keys.output('alice', 'j_1', 'a.txt'));
      expect(await blobs.list(prefix)).toHaveLength(1);
      await blobs.deletePrefix(prefix);
      expect(await blobs.list(prefix)).toEqual([]);
      expect(await blobs.head(blobs.keys.output('alice', 'j_2', 'c.txt'))).toBeDefined();
      expect(await blobs.list(blobs.keys.output('alice', 'j_9', ''))).toEqual([]);
    });

    each('copy is independent; move hands the bytes over', async ({ blobs }) => {
      const a = blobs.keys.media('alice', 'm_1', 'source.txt');
      const b = blobs.keys.media('alice', 'm_2', 'source.txt');
      await blobs.put(a, { bytes: Buffer.from('bytes') });
      await blobs.copy(a, b);
      await blobs.delete(a);
      expect(await text(await blobs.get(b))).toBe('bytes');
      const c = blobs.keys.media('alice', 'm_3', 'source.txt');
      const now = await blobs.move(b, c);
      expect(await text(await blobs.get(now))).toBe('bytes');
      expect([b, c]).toContain(now);
      if (now === c) expect(await blobs.head(b)).toBeUndefined();
    });

    each('share: one set of bytes for two holders, counted once, gone with the last', async (s) => {
      const { blobs } = s;
      const a = blobs.keys.media('alice', 'm_1', 'source.txt');
      await blobs.put(a, { bytes: Buffer.alloc(1000, 1) });
      const alone = await blobs.usage('alice');
      const held = await blobs.share(a, blobs.keys.media('alice', 'm_2', 'source.txt'));
      expect(await text(await blobs.get(held))).toHaveLength(1000);
      expect((await blobs.head(held))?.refs).toBe(2);
      expect(await blobs.usage('alice')).toBe(alone);
      expect(await blobs.freeable(blobs.keys.derived('alice', 'm_1'))).toBe(0);
      await blobs.delete(held);
      if (held !== a) {
        expect((await blobs.head(a))?.refs).toBe(1);
        expect(await blobs.freeable(blobs.keys.derived('alice', 'm_1'))).toBe(1000);
      } else {
        // A store that counts holders keeps the bytes until the first holder lets go too.
        expect(await text(await blobs.get(a))).toHaveLength(1000);
      }
    });

    each('usage counts an owner’s bytes, not another’s', async ({ blobs }) => {
      expect(await blobs.usage('alice')).toBe(0);
      await blobs.put(blobs.keys.output('alice', 'j_1', 'a.bin'), { bytes: Buffer.alloc(300) });
      await blobs.put(blobs.keys.upload('alice', 'u_1', 'data.bin'), { bytes: Buffer.alloc(200) });
      await blobs.put(blobs.keys.output('bob', 'j_1', 'a.bin'), { bytes: Buffer.alloc(50) });
      expect(await blobs.usage('alice')).toBe(500);
      expect(await blobs.usage('bob')).toBe(50);
    });

    each('expire removes what is past its time directly under a prefix', async (s) => {
      const { blobs } = s;
      const old = blobs.keys.output('alice', 'j_old', 'a.bin');
      const kept = blobs.keys.output('alice', 'f_kept', 'a.bin');
      const fresh = blobs.keys.output('alice', 'j_new', 'a.bin');
      for (const key of [old, kept, fresh]) await blobs.put(key, { bytes: Buffer.alloc(1) });
      const outputs = dirname(dirname(old));
      await s.age.blob(dirname(old), 3_600_000);
      await s.age.blob(dirname(kept), 3_600_000);
      expect(await blobs.expire(outputs, 60_000, (name) => name.startsWith('f_'))).toEqual([
        'j_old',
      ]);
      expect(await blobs.head(old)).toBeUndefined();
      expect(await blobs.head(kept)).toBeDefined();
      await s.age.blob(dirname(fresh), 3_600_000);
      await blobs.touch(dirname(fresh));
      expect(await blobs.expire(outputs, 60_000, (name) => name.startsWith('f_'))).toEqual([]);
    });

    each('an upload in parts becomes one blob, in order', async ({ blobs }) => {
      const key = blobs.keys.upload('alice', 'u_1', 'data.bin');
      const id = await blobs.multipartStart(key);
      const parts = [
        await blobs.multipartPart(key, id, 1, Readable.from([Buffer.from('part one, ')])),
        await blobs.multipartPart(key, id, 2, Readable.from([Buffer.from('part two')])),
      ];
      expect(parts.map((p) => [p.part, p.bytes])).toEqual([
        [1, 10],
        [2, 8],
      ]);
      expect(parts.every((p) => p.etag)).toBe(true);
      const head = await blobs.multipartComplete(key, id, parts);
      expect(head.bytes).toBe(18);
      expect(await text(await blobs.get(key))).toBe('part one, part two');
    });

    each('an aborted upload leaves no blob', async ({ blobs }) => {
      const key = blobs.keys.upload('alice', 'u_2', 'data.bin');
      const id = await blobs.multipartStart(key);
      await blobs.multipartPart(key, id, 1, Readable.from([Buffer.from('x')]));
      await blobs.multipartAbort(key, id);
      expect(await blobs.head(key)).toBeUndefined();
    });

    each('presignGet answers a link or undefined', async ({ blobs }) => {
      const key = blobs.keys.output('alice', 'j_1', 'a.txt');
      await blobs.put(key, { bytes: Buffer.from('x') });
      const link = await blobs.presignGet(key, { ttlMs: 60_000 });
      if (link !== undefined) expect(link).toMatch(/^https?:\/\//);
    });
  });
}

export function scratchContract(backend: string, make: StoresFactory): void {
  const each = (name: string, run: (s: Stores) => Promise<void>) =>
    it(name, () => withStores(make, run));

  describe(`Scratch contract: ${backend}`, () => {
    each('materialize gives a local file with the blob’s bytes', async ({ blobs, scratch }) => {
      const key = blobs.keys.media('alice', 'm_1', 'source.txt');
      await blobs.put(key, { bytes: Buffer.from('local bytes') });
      expect(await readFile(await scratch.materialize(key), 'utf8')).toBe('local bytes');
    });

    each('reserve then publish stores what an engine wrote', async ({ blobs, scratch }) => {
      const key = blobs.keys.media('alice', 'm_1', 'proxy.txt');
      const path = await scratch.reserve(key);
      await writeFile(path, 'made by an engine');
      expect(await scratch.publish(path, key)).toBe(key);
      expect(await text(await blobs.get(key))).toBe('made by an engine');
    });

    each('publish stores a file from anywhere on this node', async (s) => {
      const local = join(s.work, 'elsewhere.txt');
      await writeFile(local, 'from elsewhere');
      const key = s.blobs.keys.output('alice', 'j_1', 'out.txt');
      await s.scratch.publish(local, key);
      expect(await text(await s.blobs.get(key))).toBe('from elsewhere');
      expect(await readFile(local, 'utf8')).toBe('from elsewhere');
      const again = s.blobs.keys.output('alice', 'j_1', 'moved.txt');
      await s.scratch.publish(local, again, { move: true });
      expect(await text(await s.blobs.get(again))).toBe('from elsewhere');
    });

    each('a folder of blobs: materializeDir to read, publishDir to store', async (s) => {
      const prefix = s.blobs.keys.derived('alice', 'm_1', 'search');
      await s.blobs.put(`${prefix}/a.bin`, { bytes: Buffer.from('a') });
      const dir = await s.scratch.materializeDir(prefix);
      expect(await readFile(join(dir, 'a.bin'), 'utf8')).toBe('a');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'b.bin'), 'b');
      await s.scratch.publishDir(dir, prefix);
      expect(await text(await s.blobs.get(`${prefix}/b.bin`))).toBe('b');
    });

    each('keyOf knows only this store’s own files; temp is a fresh folder', async (s) => {
      expect(s.scratch.keyOf(join(s.work, 'elsewhere.txt'))).toBeUndefined();
      const a = await s.scratch.temp('cf-contract-');
      const b = await s.scratch.temp('cf-contract-');
      expect(a).not.toBe(b);
      await writeFile(join(a, 'x'), 'x');
    });
  });
}
