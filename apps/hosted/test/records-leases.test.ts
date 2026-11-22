import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoRecords, Workspace } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { createServer, Runtime, type RuntimeConfig } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sequence, type SequenceOptions, type Subscribers } from '../src/sequence.ts';
import { MONGO_TEST_TIMEOUT_MS, mongoReachable, TEST_MONGODB_URI, testDatabase } from './mongo.ts';

// Two servers on one database: the periodic work runs on one of them, and passes to the other
// when the first stops.

const up = await mongoReachable();
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const TEMPLATES = fileURLToPath(new URL('../email/', import.meta.url));

const tidy: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of tidy.splice(0).reverse()) await step();
});

async function database(): Promise<string> {
  const db = testDatabase();
  tidy.push(async () => {
    const last = new MongoRecords({ uri: TEST_MONGODB_URI, db });
    await (await last.database()).dropDatabase();
    await last.close();
  });
  return db;
}

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-leases-'));
  tidy.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!up)('periodic work on two servers sharing a database', () => {
  it('the hourly sweep runs on one server; the other takes it over when that one stops', async () => {
    const db = await database();
    const make = async (node: string) => {
      const config: RuntimeConfig = {
        dataDir: join(await folder(), 'data'),
        mode: 'hosted',
        publicUrl: 'http://127.0.0.1:8787',
        mediaRoots: [],
        exportsDir: null,
        maxJobs: 1,
        outputUrlTtlMs: 3_600_000,
        maxDownloadBytes: 1024 ** 2,
        allowPrivateUrls: false,
        inlineMaxBytes: 1024,
        motionUrl: null,
        node,
        records: { store: 'mongo', uri: TEST_MONGODB_URI, db },
      };
      const runtime = new Runtime(config);
      const sweep = vi.spyOn(runtime, 'sweep');
      tidy.push(() => runtime.close());
      return { runtime, sweep };
    };
    const a = await make('a');
    const b = await make('b');
    await Promise.all([a.runtime.start(), b.runtime.start()]);
    expect(a.sweep.mock.calls.length + b.sweep.mock.calls.length).toBe(1);
    const [first, second] = a.sweep.mock.calls.length ? [a, b] : [b, a];
    // The next turn comes round on both: still the first server's.
    expect(await second.runtime.ws.records.leader('sweep')).toBe(false);
    expect(await first.runtime.ws.records.leader('sweep')).toBe(true);
    await first.runtime.close();
    expect(await second.runtime.ws.records.leader('sweep')).toBe(true);
  });

  it('the email sequence looks for who is due on one server only', async () => {
    const db = await database();
    const looks = { a: 0, b: 0 };
    const make = async (node: 'a' | 'b') => {
      const records = new MongoRecords({ uri: TEST_MONGODB_URI, db, node });
      const ws = new Workspace(join(await folder(), 'data'), { records });
      const subscribers: Subscribers = {
        // biome-ignore lint/correctness/useYield: nobody signed up; the look itself is counted
        async *createdSince() {
          looks[node] += 1;
        },
        current: async () => undefined,
      };
      const options: SequenceOptions = {
        ws,
        subscribers,
        provider: { send: async () => ({ id: 'none' }) },
        from: 'Ken at cuttingfloor <ken@cuttingfloor.ai>',
        replyTo: 'support@cuttingfloor.ai',
        signer: 'Ken',
        publicUrl: 'https://api.cuttingfloor.ai',
        unsubscribeSecret: 'unsubscribe-secret',
        followUpAfterMs: 3 * 86_400_000,
        creditsAfterMs: 7 * 86_400_000,
        credits: async () => ({ left: 1, perMonth: null, bought: 0 }),
        pollMs: 40,
        templatesDir: TEMPLATES,
      };
      const sequence = new Sequence(options);
      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        sequence.stop();
        await records.close();
      };
      tidy.push(stop);
      return { sequence, stop };
    };
    const a = await make('a');
    const b = await make('b');
    a.sequence.start();
    b.sequence.start();
    await until(() => looks.a + looks.b >= 6);
    const [leader, idle] = looks.a ? (['a', 'b'] as const) : (['b', 'a'] as const);
    expect(looks[idle]).toBe(0);
    // The server doing it stops: the other's next turn takes the work over.
    await (leader === 'a' ? a : b).stop();
    await until(() => looks[idle] >= 3);
  });

  it('a client is told the server could not reach its records, in plain words', async () => {
    const db = await database();
    const runtime = new Runtime({
      dataDir: join(await folder(), 'data'),
      mode: 'local',
      publicUrl: 'http://127.0.0.1:8787',
      mediaRoots: [],
      exportsDir: null,
      maxJobs: 1,
      outputUrlTtlMs: 3_600_000,
      maxDownloadBytes: 1024 ** 2,
      allowPrivateUrls: false,
      inlineMaxBytes: 1024,
      motionUrl: null,
      records: { store: 'mongo', uri: TEST_MONGODB_URI, db },
    });
    tidy.push(() => runtime.close());
    await runtime.start({ sweep: false });
    const server = createServer({
      runtime,
      credentials: new LocalCredentialStore({}, false),
      owner: () => 'local',
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    const create = () =>
      client.callTool({
        name: 'timeline.create',
        arguments: { name: 'x', sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } } },
      });
    expect((await create()).isError).toBeFalsy();
    // The database goes away under the running server.
    const records = runtime.ws.records as MongoRecords;
    await records.idle();
    await (await records.database()).client.close();
    const log = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const refused = await create();
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        code: 'service_unavailable',
        message: 'The server could not read or write its records just now',
      });
      expect(JSON.stringify(refused)).not.toMatch(/mongo|127\.0\.0\.1|topology/i);
      expect(log.mock.calls.some(([line]) => /^records: timelines\./.test(String(line)))).toBe(
        true,
      );
    } finally {
      log.mockRestore();
    }
  });
});
