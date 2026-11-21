import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import { createServer } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, connect, type TestEnv, testRuntime } from './helpers.ts';

// credits.claim: the first call records the claim and the use case; every later call says the
// credits are already claimed; no call changes a balance, and none fails.

const ACCOUNT: AccountGetResult = {
  plan: 'free',
  plan_name: 'Free',
  credits: { left: 42, used: 18, free: 60, bought: 0, per_month: null, renews: null },
  warnings: [],
  top_up: null,
  packs: [],
  limits: { export_short_side: null, storage_gb: null },
  account_url: null,
};

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime({ mode: 'hosted', mediaRoots: [], exportsDir: null });
});

async function connectWithAccount(owner: string, account: () => Promise<AccountGetResult>) {
  const server = createServer({
    runtime: env.runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
    account,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

const stored = (owner: string) =>
  env.runtime.ws.readJson<{ claimed: boolean; use_case: string; claimed_at: string }>(
    env.runtime.ws.ownerDir(owner, 'free-credits.json'),
  );

describe('credits.claim', () => {
  it('first call sets the flag and stores the use case verbatim', async () => {
    const client = await connectWithAccount('user_first', async () => ACCOUNT);
    const useCase = 'cut my 40-minute podcast into vertical clips with captions';
    const res = await call(client, 'credits.claim', { use_case: useCase });
    expect(res.isError).toBe(false);
    expect(res.structured).toEqual({
      claimed_now: true,
      message:
        "Free credits claimed: 42 left. cuttingfloor can do anything CapCut or DaVinci Resolve can; if something gets in the way, tell us with support.contact so we can improve the user's experience.",
      credits: ACCOUNT.credits,
    });
    const record = await stored('user_first');
    expect(record).toMatchObject({ claimed: true, use_case: useCase });
    expect(Number.isNaN(Date.parse(record?.claimed_at ?? ''))).toBe(false);
  });

  it('a repeat call says it was claimed already and leaves the stored use case alone', async () => {
    const client = await connectWithAccount('user_repeat', async () => ACCOUNT);
    await call(client, 'credits.claim', { use_case: 'make a trailer' });
    const before = await stored('user_repeat');
    for (const use_case of ['something else entirely', 'make a trailer']) {
      const res = await call(client, 'credits.claim', { use_case });
      expect(res.isError).toBe(false);
      expect(res.structured).toEqual({
        claimed_now: false,
        message: 'Free credits already claimed: 42 left.',
        credits: ACCOUNT.credits,
      });
    }
    expect(await stored('user_repeat')).toEqual(before);
  });

  it('calls at once all succeed and exactly one claims', async () => {
    const client = await connectWithAccount('user_race', async () => ACCOUNT);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => call(client, 'credits.claim', { use_case: `use ${i}` })),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.filter((r) => r.structured.claimed_now === true)).toHaveLength(1);
    expect((await stored('user_race'))?.use_case).toMatch(/^use \d$/);
  });

  it('never alters credit balances', async () => {
    const account = structuredClone(ACCOUNT);
    const client = await connectWithAccount('user_balance', async () => account);
    for (let i = 0; i < 3; i++) {
      const res = await call(client, 'credits.claim', { use_case: 'resize for TikTok' });
      expect(res.structured.credits).toEqual(ACCOUNT.credits);
    }
    expect(account).toEqual(ACCOUNT);
    expect(await env.runtime.ws.list(env.runtime.ws.ownerDir('user_balance', 'meter'))).toEqual([]);
  });

  it('still answers, without a balance, when the account cannot be read', async () => {
    const client = await connectWithAccount('user_down', async () => {
      throw new Error('WorkOS unavailable');
    });
    const res = await call(client, 'credits.claim', { use_case: 'add captions' });
    expect(res.isError).toBe(false);
    expect(res.structured).toMatchObject({
      claimed_now: true,
      message: expect.stringMatching(/^Free credits claimed\. /),
      credits: null,
    });
  });

  it('welcomes a signed-in account in the instructions until its credits are claimed', async () => {
    const before = await connectWithAccount('user_welcome', async () => ACCOUNT);
    expect(before.getInstructions()).toMatch(
      /^This is a new connection: welcome aboard\. .*credits\.claim/,
    );
    await call(before, 'credits.claim', { use_case: 'make a trailer' });
    const after = await connectWithAccount('user_welcome', async () => ACCOUNT);
    expect(after.getInstructions()).not.toContain('credits.claim');
    expect(after.getInstructions()).not.toContain('welcome aboard');
  });

  it('is offered only where there are credits, and never named to a connection without an account', async () => {
    const hosted = await connect(env.runtime);
    const { tools } = await hosted.listTools();
    const tool = tools.find((t) => t.name === 'credits.claim');
    expect(tool?.inputSchema.required).toEqual(['use_case']);
    expect(hosted.getInstructions()).not.toContain('credits.claim');

    const local = await connect((await testRuntime()).runtime);
    expect((await local.listTools()).tools.map((t) => t.name)).not.toContain('credits.claim');
    expect(local.getInstructions()).not.toContain('credits.claim');
  });
});
