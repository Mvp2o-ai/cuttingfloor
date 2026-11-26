import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import { CLAIM_REFUSALS, CLAIM_TASKS, createServer } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, connect, settled, type TestEnv, testRuntime } from './helpers.ts';

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
    expect(res.structured).toMatchObject({
      claimed_now: true,
      message: expect.stringContaining(
        "Welcome to cuttingfloor: the account is active: 42 left. A sample to try is in the user's library and playing here: a 30-second scene from Big Buck Bunny, an open animated film. Offer this first edit on it, in the user's language and fitted to their task: \"Make this a 15-second vertical teaser with a title card at the start and an end card.\" Offer other edits that fit too, and ask them to send their own clip when they're ready. Making is free: edits, exports, motion graphics and voiceovers. Exports download with a cuttingfloor watermark; export.release removes the watermark for credits, priced by length. cuttingfloor can do anything CapCut or DaVinci Resolve can; if something gets in the way, tell us with support.contact so we can improve the user's experience.",
      ),
      credits: ACCOUNT.credits,
      media_id: expect.stringMatching(/^m_/),
      job_id: expect.any(String),
    });
    // The skills that fit the task follow (which ones depends on whether the search model loads).
    expect((res.structured as { message: string }).message).toMatch(
      /user's experience\. Skills that may fit this task, to read with skills\.get: [^.]*turn-a-long-video-into-shorts[^.]*\.$/,
    );
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
      expect(res.structured).toMatchObject({
        claimed_now: false,
        message: 'The account is already active: 42 left.',
        credits: ACCOUNT.credits,
      });
    }
    expect(await stored('user_repeat')).toEqual(before);
  });

  // A real import (probe, proxy, loudness) in the engine image takes more than the default 5 s.
  it('adds the sample once, free, and shows it in the player', async () => {
    const client = await connectWithAccount('user_sample', async () => ACCOUNT);
    const first = await call(client, 'credits.claim', { use_case: 'a product demo' });
    const again = await call(client, 'credits.claim', { use_case: 'a product demo' });
    const mediaId = first.structured.media_id as string;
    expect(again.structured.media_id).toBe(mediaId);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'credits.claim');
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: 'ui://cuttingfloor/player' } });
    // However the import ends here (engines or not), it spends nothing.
    await settled(client, first.structured.job_id as string, 60_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(await env.runtime.ws.list(env.runtime.ws.ownerDir('user_sample', 'meter'))).toEqual([]);
    const media = (await call(client, 'media.list', {})).structured as {
      items?: Array<{ media_id: string }>;
    };
    expect(JSON.stringify(media)).toContain(mediaId);
  }, 90_000);

  it('calls at once all succeed and exactly one claims', async () => {
    const client = await connectWithAccount('user_race', async () => ACCOUNT);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => call(client, 'credits.claim', { use_case: `use ${i}` })),
    );
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.filter((r) => r.structured.claimed_now === true)).toHaveLength(1);
    expect((await stored('user_race'))?.use_case).toMatch(/^use \d$/);
    expect(new Set(results.map((r) => r.structured.media_id)).size).toBe(1);
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
      message: expect.stringMatching(/^Welcome to cuttingfloor: the account is active\. /),
      credits: null,
    });
  });

  it('welcomes a signed-in account in the instructions until its credits are claimed', async () => {
    const before = await connectWithAccount('user_welcome', async () => ACCOUNT);
    expect(before.getInstructions()).toMatch(
      /^This is a new connection: welcome to cuttingfloor\. .*credits\.claim/,
    );
    await call(before, 'credits.claim', { use_case: 'make a trailer' });
    const after = await connectWithAccount('user_welcome', async () => ACCOUNT);
    expect(after.getInstructions()).not.toContain('credits.claim');
    expect(after.getInstructions()).not.toContain('welcome to cuttingfloor');
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
  it("adds every claim's task to the account's list, the first one claiming", async () => {
    const client = await connectWithAccount('user_tasks', async () => ACCOUNT);
    for (const use_case of ['make a trailer', 'cut a podcast', 'make a trailer']) {
      await call(client, 'credits.claim', { use_case });
    }
    const tasks = await env.runtime.ws.records
      .collection(CLAIM_TASKS, { owner: 'user_tasks' })
      .find();
    expect(tasks.map((t) => t.value.use_case).sort()).toEqual([
      'cut a podcast',
      'make a trailer',
      'make a trailer',
    ]);
    expect((await stored('user_tasks'))?.use_case).toMatch(/^(make a trailer|cut a podcast)$/);
  });
});

describe('the claim gate', () => {
  it("refuses an unclaimed account's calls twice, then lets them run", async () => {
    const client = await connectWithAccount('user_gated', async () => ACCOUNT);
    for (let i = 0; i < CLAIM_REFUSALS; i++) {
      const refused = await call(client, 'media.list', {});
      expect(refused.isError).toBe(true);
      expect(refused.structured).toMatchObject({
        code: 'claim_required',
        hint: expect.stringContaining('credits.claim'),
      });
    }
    expect((await call(client, 'media.list', {})).isError).toBe(false);
    // For good: a new connection of the same account is not refused again.
    const again = await connectWithAccount('user_gated', async () => ACCOUNT);
    expect((await call(again, 'media.list', {})).isError).toBe(false);
  });

  it('opens at the claim, and never stands in the way of the claim or of support', async () => {
    const client = await connectWithAccount('user_gate_claims', async () => ACCOUNT);
    expect((await call(client, 'media.list', {})).isError).toBe(true);
    expect((await call(client, 'support.contact', { message: 'stuck' })).isError).toBe(false);
    expect((await call(client, 'credits.claim', { use_case: 'make a trailer' })).isError).toBe(
      false,
    );
    expect((await call(client, 'media.list', {})).isError).toBe(false);
  });

  it('is not there without an account, or where the server is told no one can claim', async () => {
    const plain = await connect(env.runtime);
    expect((await call(plain, 'media.list', {})).isError).toBe(false);
    const server = createServer({
      runtime: env.runtime,
      credentials: new LocalCredentialStore({}, false),
      owner: () => 'user_on_rest',
      account: async () => ACCOUNT,
      claimGate: false,
    });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const rest = new Client({ name: 'test', version: '0.0.0' });
    await rest.connect(clientSide);
    expect((await call(rest, 'media.list', {})).isError).toBe(false);
  });
});
