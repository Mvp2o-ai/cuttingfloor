import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import { createServer } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, type TestEnv, testRuntime } from './helpers.ts';

// credits.claim's router: Jev (a stand-in for api.typesafe.ai here) picks the onboarding sample
// that fits the use case; without an answer the fallback is shown.

const KEY = 'ts_test_router';
const ACCOUNT: AccountGetResult = {
  plan: 'free',
  plan_name: 'Free',
  credits: { left: 25, used: 0, free: 25, bought: 0, per_month: null, renews: null },
  warnings: [],
  top_up: null,
  packs: [],
  limits: { export_short_side: null, storage_gb: null },
  account_url: null,
};

let env: TestEnv;
let jev: Server;
/** What the stand-in answers: a card's slug, or 'down' for a 503. */
let pick = 'gaming-stream';
const asked: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  jev = createPlainServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    asked.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    if (pick === 'down') return res.writeHead(503).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        model: 'jev-1.14.0',
        answers: { sample: { type: 'choice', choice: pick, probabilities: {}, confidence: 0.9 } },
      }),
    );
  });
  await new Promise<void>((r) => jev.listen(0, '127.0.0.1', r));
  env = await testRuntime({
    mode: 'hosted',
    mediaRoots: [],
    exportsDir: null,
    typesafeUrl: `http://127.0.0.1:${(jev.address() as AddressInfo).port}`,
  });
});
afterAll(() => jev?.close());

async function claimAs(owner: string, useCase: string) {
  const server = createServer({
    runtime: env.runtime,
    credentials: new LocalCredentialStore({ TYPESAFE_API_KEY: KEY }, false),
    owner: () => owner,
    account: async () => ACCOUNT,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return call(client, 'credits.claim', { use_case: useCase });
}

const shown = (owner: string) =>
  env.runtime.ws.readJson<{ media_id: string; sample: string }>(
    env.runtime.ws.ownerDir(owner, 'onboarding.json'),
  );

describe('credits.claim sample router', () => {
  it('shows the sample Jev picks for the use case, with its starter edit', async () => {
    pick = 'gaming-stream';
    const res = await claimAs('user_gamer', 'Valorant highlights with memes for Shorts');
    expect(res.isError).toBe(false);
    const questions = asked.at(-1)?.questions as Record<string, { criteria: object }> | undefined;
    const question = questions?.sample;
    expect(Object.keys(question?.criteria ?? {})).toContain('gaming-stream');
    expect(asked.at(-1)?.state).toEqual({ task: 'Valorant highlights with memes for Shorts' });
    expect(res.structured.message).toContain('a 2-minute gaming stream');
    expect(res.structured.message).toContain('facecam on top');
    expect(await shown('user_gamer')).toMatchObject({ sample: 'gaming-stream' });
    const media = await env.runtime.media.find('user_gamer', res.structured.media_id as string);
    expect(media?.name).toBe('gaming-stream.mp4');
  });

  it('falls back to Big Buck Bunny when Jev is down or names no card', async () => {
    pick = 'down';
    const down = await claimAs('user_down', 'a wedding film');
    expect(down.structured.message).toContain('Big Buck Bunny');
    expect(await shown('user_down')).toMatchObject({ sample: 'animation-short' });
    pick = 'no-such-card';
    const odd = await claimAs('user_odd', 'something');
    expect(await shown('user_odd')).toMatchObject({ sample: 'animation-short' });
    expect(odd.isError).toBe(false);
  });

  it('keeps the first sample on later claims instead of routing again', async () => {
    pick = 'podcast-interview';
    await claimAs('user_keep', 'podcast clips');
    const before = asked.length;
    pick = 'dance-takes';
    const again = await claimAs('user_keep', 'dance videos');
    expect(asked.length).toBe(before);
    expect(await shown('user_keep')).toMatchObject({ sample: 'podcast-interview' });
    expect(again.structured.media_id).toBeTruthy();
  });
});
