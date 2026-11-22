import { describe, expect, it } from 'vitest';
import { type CollectionSpec, defineCollection, MongoRecords, mongoUri } from '../src/index.ts';
import { mongoReachable, mongoStores, TEST_MONGODB_URI, testRecords } from './mongo.ts';
import { recordsContract } from './storage-contract.ts';

const up = await mongoReachable();

if (up) recordsContract('MongoDB', mongoStores);

interface Thing {
  name: string;
  count?: number;
  state?: string | undefined;
  extra?: unknown;
}

const things = defineCollection<Thing>({
  name: 'things',
  scope: 'owner',
  fs: { dir: 'things' },
  db: { indexes: [['state']], indexesAcross: [['state', 'name']], ttlMs: 7 * 86_400_000 },
});
const goneA = defineCollection<Thing>({
  name: 'gone',
  kind: 'a',
  scope: 'owner',
  fs: { dir: 'a-gone' },
});
const goneB = defineCollection<Thing>({
  name: 'gone',
  kind: 'b',
  scope: 'owner',
  fs: { dir: 'b-gone' },
});
const lines = defineCollection<{ n: number }>({
  name: 'lines',
  scope: 'owner',
  fs: { dir: 'lines', ext: '.jsonl' },
  db: { ttlMs: 86_400_000 },
});

const shared = defineCollection<Thing>({
  name: 'shared_things',
  scope: 'global',
  fs: { dir: 'shared-things' },
  db: { ttlMs: 86_400_000 },
});

const HOUR = 3_600_000;

describe.skipIf(!up)('MongoDB records: what only this store promises', () => {
  const each = (
    name: string,
    run: (records: ReturnType<typeof testRecords>) => Promise<void>,
    options = {},
  ) =>
    it(name, async () => {
      const records = testRecords(options);
      try {
        await run(records);
      } finally {
        await records.drop();
      }
    });

  each('a record is one document: id, owner, last use and the value as written', async (r) => {
    await r.collection(things, { owner: 'alice' }).put('a', { name: 'first', count: 2 });
    const doc = await (await r.database()).collection('things').findOne({});
    expect(doc).toMatchObject({
      _id: 'alice/a',
      id: 'a',
      owner: 'alice',
      v: { name: 'first', count: 2 },
    });
    expect(doc?.used_at).toBeInstanceOf(Date);
  });

  each('a read that counts as a use writes the last use at most once an hour', async (r) => {
    const c = r.collection(things, { owner: 'alice' });
    await c.put('a', { name: 'n' });
    // Used 10 minutes ago: reads and touches leave it alone.
    const recent = new Date(Date.now() - 600_000);
    await r.restore(things, { owner: 'alice' }, 'a', { name: 'n' }, recent);
    await c.get('a', { touch: true });
    await c.touch('a');
    expect((await c.usedAt('a'))?.getTime()).toBe(recent.getTime());
    // Used two hours ago: the next read moves it to now, once.
    await r.restore(
      things,
      { owner: 'alice' },
      'a',
      { name: 'n' },
      new Date(Date.now() - 2 * HOUR),
    );
    await c.get('a', { touch: true });
    const moved = (await c.usedAt('a')) as Date;
    expect(Date.now() - moved.getTime()).toBeLessThan(10_000);
    await c.get('a', { touch: true });
    expect((await c.usedAt('a'))?.getTime()).toBe(moved.getTime());
    await r.restore(
      things,
      { owner: 'alice' },
      'a',
      { name: 'n' },
      new Date(Date.now() - 2 * HOUR),
    );
    await c.touch('a');
    expect(Date.now() - ((await c.usedAt('a')) as Date).getTime()).toBeLessThan(10_000);
  });

  each('values keep what JSON keeps: odd keys stay, undefined fields go', async (r) => {
    const c = r.collection(things, { owner: 'alice' });
    const extra = { $schema: 'x', 'a.b': 1, nested: { $ref: '#', 'c.d': [null, { $e: true }] } };
    await c.put('a', { name: 'n', state: undefined, extra });
    expect(await c.get('a')).toEqual({ name: 'n', extra });
    expect(await c.update('a', { set: { extra: { $literal: '$name' }, state: 'on' } })).toEqual({
      name: 'n',
      extra: { $literal: '$name' },
      state: 'on',
    });
    // Setting a field to undefined removes it, as rewriting the JSON file would.
    expect(await c.update('a', { set: { state: undefined } })).toEqual({
      name: 'n',
      extra: { $literal: '$name' },
    });
    expect(await c.compareAndSet('a', { state: undefined }, { name: '$name' })).toBe(true);
    expect((await c.get('a'))?.name).toBe('$name');
    expect(await c.compareAndSet('a', { state: undefined, name: '$name' }, { state: 'x' })).toBe(
      true,
    );
    expect(await c.compareAndSet('a', { state: undefined }, { state: 'y' })).toBe(false);
  });

  each('update adds to what the same change sets, and counts a non-number as 0', async (r) => {
    const c = r.collection(things, { owner: 'alice' });
    await c.put('a', { name: 'n', count: 'many' as unknown as number });
    expect((await c.update('a', { inc: { count: 2 } }))?.count).toBe(2);
    expect((await c.update('a', { set: { count: 10 }, inc: { count: 1 } }))?.count).toBe(11);
  });

  each('find matches exactly: null is not missing, a list is not its element', async (r) => {
    const c = r.collection(things, { owner: 'alice' });
    await c.put('a', { name: 'a', extra: null });
    await c.put('b', { name: 'b' });
    await c.put('c', { name: 'c', extra: ['x'] });
    expect((await c.find({ extra: null })).map((e) => e.id)).toEqual(['a']);
    expect((await c.find({ extra: undefined })).map((e) => e.id)).toEqual(['b']);
    expect((await c.find({ extra: 'x' })).map((e) => e.id)).toEqual([]);
    expect((await c.find({ extra: ['x'] })).map((e) => e.id)).toEqual(['c']);
  });

  each('two kinds sharing a collection stay apart', async (r) => {
    const a = r.collection(goneA, { owner: 'alice' });
    const b = r.collection(goneB, { owner: 'alice' });
    await a.put('x', { name: 'a' });
    await b.put('x', { name: 'b' });
    await b.put('y', { name: 'b' });
    expect(await a.get('x')).toEqual({ name: 'a' });
    expect(await a.ids()).toEqual(['x']);
    expect((await b.find()).map((e) => e.id).sort()).toEqual(['x', 'y']);
    await r.restore(goneB, { owner: 'alice' }, 'x', { name: 'b' }, new Date(Date.now() - HOUR));
    expect(await a.expire(60_000)).toEqual([]);
    expect(await b.expire(60_000)).toEqual(['x']);
    await a.clear();
    expect(await b.ids()).toEqual(['y']);
    const docs = await (await r.database()).collection('gone').find({}).toArray();
    expect(docs.map((d) => [d._id, d.kind])).toEqual([['b/alice/y', 'b']]);
  });

  each('indexes: the scope, the spec’s own, and a backstop life behind the sweep', async (r) => {
    await r.collection(things, { owner: 'alice' }).put('a', { name: 'n' });
    await r.log(lines, { owner: 'alice', part: 'p' }).append({ n: 1 });
    await r.ready();
    const db = await r.database();
    const of = async (name: string) =>
      Object.fromEntries(
        (await db.collection(name).indexes()).map((i) => [
          i.name,
          [i.key, i.expireAfterSeconds].filter((x) => x !== undefined),
        ]),
      );
    expect(await of('things')).toEqual({
      _id_: [{ _id: 1 }],
      scope: [{ owner: 1, used_at: 1 }],
      by_state: [{ owner: 1, 'v.state': 1 }],
      across_state_name: [{ 'v.state': 1, 'v.name': 1 }],
      ttl: [{ used_at: 1 }, 8 * 86_400],
    });
    expect(await of('lines')).toEqual({
      _id_: [{ _id: 1 }],
      scope: [{ owner: 1, at: 1 }],
      ttl: [{ at: 1 }, 2 * 86_400],
    });
    await r.collection(shared).put('k', { name: 'all' });
    await r.idle();
    expect(await of('shared_things')).toEqual({
      _id_: [{ _id: 1 }],
      ttl: [{ used_at: 1 }, 2 * 86_400],
    });
    // Asked for again by another server, with another life: changed in place, nothing fails.
    const again = new MongoRecords({ uri: TEST_MONGODB_URI, db: db.databaseName });
    const longer: CollectionSpec<Thing> = { ...things, db: { ttlMs: 30 * 86_400_000 } };
    await again.collection(longer, { owner: 'alice' }).get('a');
    await again.close();
    expect((await of('things')).ttl).toEqual([{ used_at: 1 }, 31 * 86_400]);
    // A global collection that had no life gets one on the index it already has.
    const plain: CollectionSpec<Thing> = { name: 'late', scope: 'global', fs: { dir: 'late' } };
    await r.collection(plain).put('k', { name: 'all' });
    await r.idle();
    expect(await of('late')).toEqual({ _id_: [{ _id: 1 }], scope: [{ used_at: 1 }] });
    const later = new MongoRecords({ uri: TEST_MONGODB_URI, db: db.databaseName });
    await later.collection({ ...plain, db: { ttlMs: 86_400_000 } }).get('k');
    await later.close();
    expect((await of('late')).scope).toEqual([{ used_at: 1 }, 2 * 86_400]);
  });

  each('a log entry carries when it was written; expire drops only the old ones', async (r) => {
    const log = r.log(lines, { owner: 'alice', part: 'p' });
    await log.append({ n: 1 });
    await log.append({ n: 2 });
    const col = (await r.database()).collection('lines');
    await col.updateOne({ 'v.n': 1 }, { $set: { at: new Date(Date.now() - 2 * HOUR) } });
    await log.expire(HOUR);
    expect(await log.read()).toEqual([{ n: 2 }]);
  });

  each('restore writes a record with the last use it had', async (r) => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    await r.restore(things, { owner: 'alice' }, 'a', { name: 'moved' }, at);
    const c = r.collection(things, { owner: 'alice' });
    expect(await c.get('a')).toEqual({ name: 'moved' });
    expect((await c.usedAt('a'))?.toISOString()).toBe(at.toISOString());
  });
});

describe('MongoDB records: the connection', () => {
  it('builds a connection string from a cluster name or hosts, with the sign-in escaped', () => {
    expect(mongoUri({ host: 'c.x.mongodb.net', user: 'app', password: 'p@ss/w:rd' })).toBe(
      'mongodb+srv://app:p%40ss%2Fw%3Ard@c.x.mongodb.net/?retryWrites=true&w=majority',
    );
    expect(mongoUri({ host: '127.0.0.1:27017' })).toBe(
      'mongodb://127.0.0.1:27017/?retryWrites=true&w=majority',
    );
    expect(mongoUri({ host: 'mongodb://a:1,b:2/', user: 'u', password: 'p' })).toBe(
      'mongodb://u:p@a:1,b:2/?retryWrites=true&w=majority',
    );
  });

  it('an error from connecting never carries the sign-in', async () => {
    const password = 's3cret-Pa55';
    for (const uri of [
      `mongodb://app-user:${password}@127.0.0.1:1/?directConnection=true`,
      `mongodb://app-user:${password}@127.0.0.1:1/?nonsense=${password}`,
    ]) {
      const records = new MongoRecords({ uri, connectTimeoutMs: 300 });
      const error = await records.owners().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toMatch(/^MongoDB: /);
      expect(JSON.stringify([error?.message, error?.stack, { ...error }])).not.toContain(password);
      expect(error?.message).not.toContain('app-user');
      await records.close();
    }
  });
});
