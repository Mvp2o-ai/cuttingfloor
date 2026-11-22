import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  type BlobStore,
  type CollectionScope,
  type CollectionSpec,
  defineCollection,
  isExisting,
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
    /** Makes a whole group of a grouped collection look last written `ms` ago. */
    parent(
      spec: CollectionSpec<unknown>,
      scope: CollectionScope,
      parent: string,
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
interface Holder {
  name: string;
  file: string | null;
  proxy: string | null;
}
const holders = defineCollection<Holder>({
  name: 'holders',
  scope: 'owner',
  fs: { dir: 'holders' },
  blobs: ['file', 'proxy'],
});
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

    each('expireParents drops whole groups past their time', async (s) => {
      await s.records.collection(grouped, { owner: 'alice', parent: '2026-01' }).put('a', {
        name: 'jan',
      });
      await s.records.collection(grouped, { owner: 'alice', parent: '2026-02' }).put('a', {
        name: 'feb',
      });
      await s.age.parent(grouped, { owner: 'alice' }, '2026-01', 3_600_000);
      expect(await s.records.expireParents(grouped, { owner: 'alice' }, 60_000)).toEqual([
        '2026-01',
      ]);
      expect(await s.records.parents(grouped, { owner: 'alice' })).toEqual(['2026-02']);
      expect(await s.records.expireParents(things, { owner: 'alice' }, 60_000)).toEqual([]);
    });

    each('clear removes every record of one scope and no other', async ({ records }) => {
      const hers = records.collection(things, { owner: 'alice' });
      const his = records.collection(things, { owner: 'bob' });
      await hers.put('a', { name: 'a' });
      await hers.put('b', { name: 'b' });
      await his.put('a', { name: 'his' });
      await hers.clear();
      await hers.clear();
      expect(await hers.ids()).toEqual([]);
      expect(await his.get('a')).toEqual({ name: 'his' });
    });

    each('forget removes everything one owner has', async ({ records }) => {
      await records.collection(things, { owner: 'alice' }).put('a', { name: 'a' });
      await records.collection(foldered, { owner: 'alice' }).put('b', { name: 'b' });
      await records.collection(grouped, { owner: 'alice', parent: 'p' }).put('c', { name: 'c' });
      await records.collection(things, { owner: 'bob' }).put('a', { name: 'his' });
      await records.forget('alice');
      expect(await records.collection(things, { owner: 'alice' }).ids()).toEqual([]);
      expect(await records.collection(foldered, { owner: 'alice' }).ids()).toEqual([]);
      expect(await records.parents(grouped, { owner: 'alice' })).toEqual([]);
      expect(await records.collection(things, { owner: 'bob' }).get('a')).toEqual({ name: 'his' });
    });

    each('blob fields read back as the keys they were written with, however written', async (s) => {
      const c = s.records.collection(holders, { owner: 'alice' });
      const key = s.blobs.keys.media('alice', 'm_1', 'source.mp4');
      const proxy = s.blobs.keys.media('alice', 'm_1', 'proxy.mov');
      await c.put('a', { name: 'a', file: key, proxy: null });
      expect(await c.get('a')).toEqual({ name: 'a', file: key, proxy: null });
      expect(await c.update('a', { set: { proxy } })).toEqual({ name: 'a', file: key, proxy });
      expect(await c.compareAndSet('a', { file: key }, { name: 'b' })).toBe(true);
      expect((await c.find({ proxy }))[0]?.value).toEqual({ name: 'b', file: key, proxy });
      expect(await c.insertOnce('c', { name: 'c', file: key, proxy: null })).toBe(true);
      expect((await c.get('c'))?.file).toBe(key);
      // A local path outside the store (a file of the user's own) is kept as it is.
      const outside = join(s.work, 'own.mp4');
      await c.put('d', { name: 'd', file: outside, proxy: null });
      expect((await c.get('d'))?.file).toBe(outside);
    });

    each('strings and keys come back as written, whatever code units they hold', async (s) => {
      const c = s.records.collection(things as CollectionSpec<unknown>, { owner: 'alice' });
      // Half a surrogate pair, U+0000 (in a key too) and a private-use character.
      const odd = {
        name: 'lone \ud83d high, \udc00 low, nul \0, \uf8ff and \uf8ff0041',
        ['key\0with nul']: 1,
        ['key \ud800']: ['\udfff', { ['\uf8ff']: '\0' }],
        fine: 'pair \ud83d\ude00 stays',
      };
      await c.put('a', odd);
      expect(await c.get('a')).toStrictEqual(odd);
      expect(await c.insertOnce('b', odd)).toBe(true);
      expect((await c.find({ name: odd.name })).map((e) => e.id).sort()).toEqual(['a', 'b']);
      expect(await c.update('a', { set: { state: '\ud800', tags: ['\0'] } })).toStrictEqual({
        ...odd,
        state: '\ud800',
        tags: ['\0'],
      });
      expect(await c.compareAndSet('a', { state: '\ud800' }, { state: '\udbff' })).toBe(true);
      expect(await c.compareAndSet('a', { state: '\ufffd' }, { state: 'no' })).toBe(false);
      expect(((await c.get('a')) as { state: string }).state).toBe('\udbff');
      expect((await c.find())[0]?.value).toMatchObject({ fine: odd.fine });
      const log = s.records.log(lines as CollectionSpec<unknown>, { owner: 'alice', part: 'p' });
      await log.append(odd);
      expect(await log.read()).toStrictEqual([odd]);
    });

    each('a key named __proto__ is a key like any other', async (s) => {
      const c = s.records.collection(things as CollectionSpec<unknown>, { owner: 'alice' });
      // As JSON gives it: an own key, not the object's prototype.
      const plain = JSON.parse('{"__proto__":{"x":1},"name":"p","in":[{"__proto__":2}]}');
      const odd = JSON.parse(
        '{"__proto__":{"x":"\\u0000"},"name":"p\\u0000","in":{"__proto__":"\\ud800"}}',
      );
      for (const [id, value] of [
        ['plain', plain],
        ['odd', odd],
      ] as const) {
        await c.put(id, value);
        const got = (await c.get(id)) as object;
        expect(JSON.stringify(got)).toBe(JSON.stringify(value));
        expect(Object.keys(got)).toContain('__proto__');
        expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
        const updated = (await c.update(id, { set: { state: 'on' } })) as object;
        expect(JSON.stringify(updated)).toBe(JSON.stringify({ ...value, state: 'on' }));
        expect(
          JSON.stringify((await c.find({ state: 'on' })).find((e) => e.id === id)?.value),
        ).toBe(JSON.stringify({ ...value, state: 'on' }));
      }
    });

    each('fields named with a dot or a dollar are fields like any other', async (s) => {
      const c = s.records.collection(things as CollectionSpec<unknown>, { owner: 'alice' });
      await c.put('o', { name: 'n', 'a.b': 0 });
      expect(
        await c.update('o', { set: { 'a.b': 1, $c: 2, '': 3 }, inc: { 'd.e': 4 } as never }),
      ).toStrictEqual({ name: 'n', 'a.b': 1, $c: 2, '': 3, 'd.e': 4 });
      expect(await c.update('o', { inc: { 'd.e': 1, count: 1 } as never })).toMatchObject({
        'd.e': 5,
        count: 1,
      });
      expect(await c.compareAndSet('o', { 'a.b': 2 }, { $c: 9 })).toBe(false);
      expect(await c.compareAndSet('o', { 'a.b': 1, $c: 2 }, { $c: 5, 'x.y': null })).toBe(true);
      expect(await c.get('o')).toStrictEqual({
        name: 'n',
        'a.b': 1,
        $c: 5,
        '': 3,
        'd.e': 5,
        count: 1,
        'x.y': null,
      });
      expect((await c.find({ 'a.b': 1 })).map((e) => e.id)).toEqual(['o']);
      expect(await c.find({ $c: 2 })).toEqual([]);
      // No nested field is reached by a dotted name.
      await c.put('n', { a: { b: 1 } });
      expect(await c.find({ 'a.b': 1 })).toHaveLength(1);
      expect(await c.update('n', { set: { 'a.b': 2 } })).toStrictEqual({ a: { b: 1 }, 'a.b': 2 });
    });

    each('a record that is a list takes an update as a JSON file would', async (s) => {
      const c = s.records.collection(things as CollectionSpec<unknown>, { owner: 'alice' });
      await c.put('l', ['a', { name: 'in' }]);
      expect(await c.get('l')).toStrictEqual(['a', { name: 'in' }]);
      const spread = { 0: 'a', 1: { name: 'in' }, name: 'x', count: 2 };
      expect(await c.update('l', { set: { name: 'x' }, inc: { count: 2 } as never })).toStrictEqual(
        spread,
      );
      expect(await c.get('l')).toStrictEqual(spread);
      await c.put('m', ['a']);
      expect(await c.compareAndSet('m', { 0: 'b' }, { name: 'no' })).toBe(false);
      expect(await c.compareAndSet('m', { 0: 'a' }, { name: 'yes' })).toBe(true);
      expect(await c.get('m')).toStrictEqual({ 0: 'a', name: 'yes' });
      expect((await c.find({ name: 'yes' })).map((e) => e.id)).toEqual(['m']);
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
      expect(
        blobs.keys.output('alice', 'j_1', 'out.mp4').startsWith(blobs.keys.outputs('alice')),
      ).toBe(true);
      expect(
        blobs.keys.upload('alice', 'u_1', 'data.mp4').startsWith(blobs.keys.uploads('alice')),
      ).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) expect(key.startsWith('/')).toBe(false);
      expect(
        blobs.keys.media('alice', 'm_1', 'source.mp4').startsWith(blobs.keys.owner('alice')),
      ).toBe(true);
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

    each('move with ifAbsent takes a free key once, and leaves a taken one alone', async (s) => {
      const { blobs } = s;
      const to = blobs.keys.derived('alice', 'm_1', 'analyses', 'transcript.json');
      const temps = ['a', 'b', 'c', 'd'].map((n) => `${to}.${n}.tmp`);
      for (const [i, temp] of temps.entries()) {
        await blobs.put(
          temp,
          { bytes: Buffer.from(`body ${i}`) },
          { private: true, durable: true },
        );
      }
      const moved = await Promise.all(
        temps.map((temp) =>
          blobs.move(temp, to, { ifAbsent: true }).then(
            () => true,
            (error: unknown) => {
              expect(isExisting(error)).toBe(true);
              return false;
            },
          ),
        ),
      );
      expect(moved.filter(Boolean)).toHaveLength(1);
      const winner = moved.indexOf(true);
      expect(await text(await blobs.get(to))).toBe(`body ${winner}`);
      // A loser's bytes are still its own to remove; the winner's old name is gone.
      for (const [i, temp] of temps.entries()) {
        expect(Boolean(await blobs.head(temp))).toBe(i !== winner);
      }
      // Without it, a move replaces.
      await blobs.move(temps[winner === 0 ? 1 : 0] as string, to);
      expect(await text(await blobs.get(to))).toBe(`body ${winner === 0 ? 1 : 0}`);
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
      const outputs = blobs.keys.outputs('alice');
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
