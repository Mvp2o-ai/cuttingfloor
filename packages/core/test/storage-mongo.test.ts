import { CfError } from '@cuttingfloor/schema';
import { describe, expect, it, vi } from 'vitest';
import { type CollectionSpec, defineCollection, MongoRecords, mongoUri } from '../src/index.ts';
import {
  MONGO_TEST_TIMEOUT_MS,
  mongoReachable,
  mongoStores,
  TEST_MONGODB_URI,
  testRecords,
} from './mongo.ts';
import { recordsContract } from './storage-contract.ts';

const up = await mongoReachable();
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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

describe.skipIf(!up)('MongoDB records: two servers on one database', () => {
  /** Two stores as two servers would hold them, and a third way in for the test to tidy up. */
  const pair = (
    name: string,
    run: (a: MongoRecords, b: MongoRecords, db: string) => Promise<void>,
    options: { leaseMs?: number } = {},
  ) =>
    it(name, async () => {
      const first = testRecords({ node: 'a', ...options });
      const db = (await first.database()).databaseName;
      const second = new MongoRecords({ uri: TEST_MONGODB_URI, db, node: 'b', ...options });
      try {
        await run(first, second, db);
      } finally {
        await second.close();
        await first.close();
        const tidy = new MongoRecords({ uri: TEST_MONGODB_URI, db });
        await (await tidy.database()).dropDatabase();
        await tidy.close();
      }
    });

  pair('insertOnce: of both servers trying at once, exactly one wins', async (a, b) => {
    const stores = [a, b].map((r) => r.collection(things, { owner: 'alice' }));
    const won = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (stores[i % 2] as (typeof stores)[0]).insertOnce('race', { name: `n${i}` }),
      ),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    expect((await stores[0]?.get('race'))?.name).toBe(`n${won.indexOf(true)}`);
    expect((await stores[1]?.get('race'))?.name).toBe(`n${won.indexOf(true)}`);
  });

  pair('compareAndSet: of both servers moving one value, exactly one wins', async (a, b) => {
    const stores = [a, b].map((r) => r.collection(things, { owner: 'alice' }));
    await stores[0]?.put('a', { name: 'n', count: 0 });
    const won = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (stores[i % 2] as (typeof stores)[0]).compareAndSet('a', { count: 0 }, { count: i + 1 }),
      ),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    expect((await stores[1]?.get('a'))?.count).toBe(won.indexOf(true) + 1);
  });

  pair('update: adds from both servers all count', async (a, b) => {
    const stores = [a, b].map((r) => r.collection(things, { owner: 'alice' }));
    await stores[0]?.put('a', { name: 'n', count: 0 });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (stores[i % 2] as (typeof stores)[0]).update('a', { inc: { count: 1 } }),
      ),
    );
    expect((await stores[0]?.get('a'))?.count).toBe(40);
  });

  pair(
    'a lease has one holder, who keeps it; it passes on when the holder closes',
    async (a, b) => {
      const turns = await Promise.all([a.leader('sweep'), b.leader('sweep')]);
      expect(turns.filter(Boolean)).toHaveLength(1);
      const [holder, other] = turns[0] ? [a, b] : [b, a];
      expect(await other.leader('sweep')).toBe(false);
      expect(await holder.leader('sweep')).toBe(true);
      // Another name is another lease.
      expect(await other.leader('reaper')).toBe(true);
      expect(await holder.leader('reaper')).toBe(false);
      await holder.close();
      expect(await other.leader('sweep')).toBe(true);
    },
  );

  pair(
    'a holder that dies loses the lease when it runs out; one that lives keeps it past that',
    async (a, b, db) => {
      expect(await a.leader('sweep')).toBe(true);
      // Longer than the lease: the holder's renewals kept it.
      await new Promise((r) => setTimeout(r, 2500));
      expect(await b.leader('sweep')).toBe(false);
      const lock = await (await b.database()).collection('locks').findOne({});
      expect(lock).toMatchObject({ _id: 'sweep', node: 'a' });
      // The holder is gone without a word (its connection with it): nothing renews the lease.
      const dying = new MongoRecords({ uri: TEST_MONGODB_URI, db, node: 'c', leaseMs: 1500 });
      expect(await dying.leader('reaper')).toBe(true);
      await (await dying.database()).client.close();
      expect(await b.leader('reaper')).toBe(false);
      await new Promise((r) => setTimeout(r, 2000));
      expect(await b.leader('reaper')).toBe(true);
    },
    { leaseMs: 1500 },
  );
});

describe.skipIf(!up)('MongoDB records: a record too big to be one', () => {
  it('is refused in plain words, saying where and how big, and nothing is written', async () => {
    const records = testRecords();
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const c = records.collection(things, { owner: 'alice' });
      const mb = (n: number) => 'x'.repeat(n * 1024 ** 2);
      for (const write of [
        () => c.put('a', { name: 'big', extra: mb(17) }),
        () => c.insertOnce('a', { name: 'big', extra: mb(17) }),
      ]) {
        const error = (await write().then(
          () => undefined,
          (e: unknown) => e,
        )) as CfError;
        expect(error).toBeInstanceOf(CfError);
        expect(error.toJSON()).toMatchObject({
          code: 'limit_exceeded',
          message: 'A record of 17.0 MB is too big to keep in things: one holds up to 16 MB',
          detail: { collection: 'things', max_bytes: 16 * 1024 ** 2 },
        });
      }
      expect(await c.has('a')).toBe(false);
      // Many small numbers take more room in the database than in JSON: measured, not guessed.
      const numbers = Array.from({ length: 2_400_000 }, (_, i) => i % 10);
      expect(Buffer.byteLength(JSON.stringify(numbers))).toBeLessThan(5 * 1024 ** 2);
      await expect(c.put('n', { name: 'n', extra: numbers })).rejects.toMatchObject({
        code: 'limit_exceeded',
      });
      // One that fits, then grows past the limit in the database: refused the same way.
      await c.put('g', { name: 'grows', extra: mb(9) });
      for (const grow of [
        () => c.update('g', { set: { state: mb(9) } }),
        () => c.compareAndSet('g', { name: 'grows' }, { state: mb(9) }),
      ]) {
        const error = (await grow().then(
          () => undefined,
          (e: unknown) => e,
        )) as CfError;
        expect(error).toBeInstanceOf(CfError);
        expect(error.code).toBe('limit_exceeded');
        expect(JSON.stringify(error.toJSON())).not.toMatch(/mongo|bson/i);
      }
      expect((await c.get('g'))?.state).toBeUndefined();
    } finally {
      log.mockRestore();
      await records.drop();
    }
  });
});

describe.skipIf(!up)('MongoDB records: when the database or an index fails', () => {
  const taken = defineCollection<Thing>({
    name: 'taken',
    scope: 'owner',
    fs: { dir: 'taken' },
    db: { indexes: [['state']], ttlMs: 86_400_000 },
  });

  it('a start fails on an index it cannot make, saying which; the others are made', async () => {
    const records = testRecords();
    try {
      const db = await records.database();
      // Another index already has this one's name.
      await db.collection('taken').createIndex({ id: 1 }, { name: 'by_state' });
      const error = await records.ready().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toMatch(/^MongoDB: cannot make index by_state of taken \(/);
      expect(error?.message).not.toContain('mongodb://');
      const made = (await db.collection('taken').indexes()).map((i) => i.name).sort();
      expect(made).toEqual(['_id_', 'by_state', 'scope', 'ttl']);
    } finally {
      await records.drop();
    }
  });

  it('first used after the start, it says so once and the record store still works', async () => {
    const records = testRecords();
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      lines.push(String(text));
      return true;
    });
    try {
      const db = await records.database();
      await db.collection('taken').createIndex({ id: 1 }, { name: 'by_state' });
      const c = records.collection(taken, { owner: 'alice' });
      for (let i = 0; i < 20; i += 1) await c.put(`r${i}`, { name: 'n' });
      await records.idle();
      expect(await c.ids()).toHaveLength(20);
      expect(lines.filter((line) => line.includes('by_state'))).toHaveLength(1);
      expect(lines[0]).toMatch(/^records: cannot make index by_state of taken/);
    } finally {
      write.mockRestore();
      await records.drop();
    }
  });

  it('a failure after the start reaches the caller as a plain refusal; the log has the detail', async () => {
    const records = testRecords();
    const logged: string[] = [];
    const c = records.collection(things, { owner: 'alice' });
    await c.put('a', { name: 'n' });
    await records.idle();
    const db = await records.database();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
      logged.push(String(text));
      return true;
    });
    try {
      // The connection is gone under the store.
      await db.client.close();
      for (const call of [
        () => c.get('a'),
        () => c.put('b', { name: 'n' }),
        () => c.find(),
        () => records.owners(),
        () => records.leader('sweep'),
        () => records.log(lines, { owner: 'alice' }).append({ n: 1 }),
      ]) {
        const error = await call().then(
          () => undefined,
          (e: unknown) => e as CfError,
        );
        expect(error).toBeInstanceOf(CfError);
        expect(error?.code).toBe('service_unavailable');
        expect(JSON.stringify(error?.toJSON())).not.toMatch(/mongo|127\.0\.0\.1|topology|client/i);
      }
      // A caller's own mistake is still the caller's.
      await expect(c.get('../x')).rejects.toThrow(/Not a record id/);
      expect(logged.some((line) => /^records: things\.get: Mongo/.test(line))).toBe(true);
    } finally {
      write.mockRestore();
      const tidy = new MongoRecords({ uri: TEST_MONGODB_URI, db: db.databaseName });
      await (await tidy.database()).dropDatabase();
      await tidy.close();
      await records.close();
    }
  });
});

describe('MongoDB records: the connection', () => {
  it('builds a connection string from a host, with the sign-in escaped', () => {
    expect(mongoUri({ host: 'c.x.mongodb.net', user: 'app', password: 'p@ss/w:rd' })).toBe(
      'mongodb+srv://app:p%40ss%2Fw%3Ard@c.x.mongodb.net/?retryWrites=true&w=majority',
    );
    // Only an Atlas cluster's name is looked up as SRV; any other host is a plain one.
    for (const host of ['mongo', 'localhost', 'db.internal', '127.0.0.1:27017', 'a:1,b:2']) {
      expect(mongoUri({ host })).toBe(`mongodb://${host}/?retryWrites=true&w=majority`);
    }
    expect(mongoUri({ host: 'c.x.mongodb.net:27017' })).toMatch(/^mongodb:\/\/c\.x/);
    expect(mongoUri({ host: 'mongodb+srv://db.internal/', user: 'u', password: 'p' })).toBe(
      'mongodb+srv://u:p@db.internal/?retryWrites=true&w=majority',
    );
  });

  it('a start that cannot connect says so without the sign-in, whatever the password', async () => {
    for (const [password, uri] of [
      ['s3cret-Pa55', 'mongodb://app-user:s3cret-Pa55@127.0.0.1:1/?directConnection=true'],
      ['s3cret-Pa55', 'mongodb://app-user:s3cret-Pa55@127.0.0.1:1/?nonsense=s3cret-Pa55'],
      // A colon written as it is, a password of two characters, and of one.
      ['pa:ss-w0rd', 'mongodb://app-user:pa:ss-w0rd@127.0.0.1:1/?directConnection=true'],
      ['ss-w0rd', 'mongodb://app-user:pa:ss-w0rd@127.0.0.1:1/?directConnection=true'],
      ['zq', 'mongodb://app-user:zq@127.0.0.1:1/?nonsense=zq'],
      ['7', 'mongodb://app-user:7@127.0.0.1:1/?nonsense=7'],
    ] as const) {
      const records = new MongoRecords({ uri, connectTimeoutMs: 300 });
      const error = await records.ready().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toMatch(/^MongoDB: cannot connect \(/);
      const shown = JSON.stringify([error?.message, { ...error }]);
      // After the port and the option, a short password can only show where it was echoed.
      expect(shown.replace(/127\.0\.0\.1:1|nonsense/g, '')).not.toContain(password);
      expect(shown).not.toContain('app-user');
      await records.close();
    }
  });
});
