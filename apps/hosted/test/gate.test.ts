import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, parseApiKeys } from '../src/http.ts';

// The download gate through the HTTP face, as clients meet it: a picture export downloads
// carrying the mark (here a stand-in mark that appends a tag), export.release spends its price
// once, and from then on every link serves the clean file.

const KEY = 'gate-key-0123456789abcdefghij';
const MARK = '\n[cuttingfloor mark]';
let runtime: Runtime;
let base: string;
let server: Server;
/** Credits left per owner; null for no cap. */
const balances = new Map<string, number | null>();
const exempt = new Set<string>();
const spends: Array<{ owner: string; ref: string; credits: number }> = [];
let marked = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-gate-'));
  runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 600_000,
    maxDownloadBytes: 1024,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  runtime.useGate(
    {
      exempt: async (owner) => exempt.has(owner),
      balance: async (owner) => balances.get(owner) ?? 0,
      spend: async (owner, ref, credits) => {
        // The ledger takes a ref once.
        if (!spends.some((s) => s.ref === ref)) {
          spends.push({ owner, ref, credits });
          balances.set(owner, (balances.get(owner) ?? 0) - credits);
        }
        return { balance: balances.get(owner) ?? 0 };
      },
      mark: async (input, output) => {
        marked += 1;
        await copyFile(input, output);
        await writeFile(output, `${await readFile(input, 'utf8')}${MARK}`);
      },
    },
    { from: '2000-01-01T00:00:00Z' },
  );
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: parseApiKeys(`alice:${KEY},staff:${KEY}-staff,poor:${KEY}-poor`),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
});

afterAll(() => server.close());

/** A finished export of `seconds`, as export.video leaves one. */
async function exported(owner: string, name: string, mime: string, seconds: number) {
  const store = runtime.jobs.store;
  const job = await store.create({ owner, tool: 'export.video' });
  await runtime.outputs.write(owner, job.id, name, `clean ${name}`, 'export');
  const signed = await runtime.signOutput(owner, job.id, name);
  const result = {
    url: signed.url,
    page_url: signed.pageUrl,
    expires_at: signed.expiresAt,
    uri: `video://jobs/${job.id}/output`,
    bytes: 10,
    frames: Math.round(seconds * 25),
    preset: 'mp4_h264',
    mime_type: mime,
    duration_seconds: seconds,
  };
  await store.update(job, {
    status: 'completed',
    progress: 1,
    result: { content: [], structuredContent: result } as never,
  });
  return { jobId: job.id, url: signed.url, pageUrl: signed.pageUrl };
}

async function connect(key: string) {
  const client = new Client({ name: 't', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

type Out = { structuredContent: Record<string, unknown>; isError?: boolean };
const call = (c: Client, name: string, args: Record<string, unknown>) =>
  c.callTool({ name, arguments: args }) as Promise<Out>;

describe('the download gate', () => {
  it('serves a picture export marked until it is released, then clean everywhere, spent once', async () => {
    balances.set('alice', 3);
    const { jobId, url, pageUrl } = await exported('alice', 'short.mp4', 'video/mp4', 40);
    const alice = await connect(KEY);

    // The export says so, with its price: 40 s is three quarter-minutes.
    const before = (await call(alice, 'job.get', { job_id: jobId })).structuredContent as {
      result: { watermarked: boolean; release_credits: number };
    };
    expect(before.result).toMatchObject({ watermarked: true, release_credits: 0.75 });

    // Every way out serves the marked copy, made once, and never cached.
    const first = await fetch(url);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.text()).toBe(`clean short.mp4${MARK}`);
    expect(await (await fetch(url)).text()).toBe(`clean short.mp4${MARK}`);
    expect(marked).toBe(1);
    const page = await (await fetch(pageUrl)).text();
    expect(page).toContain('carries the cuttingfloor mark');
    expect(page).toContain('0.75 credit');

    // Released at the same moment from two places: one spend.
    const [a, b] = await Promise.all([
      call(alice, 'export.release', { job_id: jobId }),
      call(alice, 'export.release', { job_id: jobId }),
    ]);
    const spent = [a, b].map((r) => r.structuredContent.credits as number).sort();
    expect(spent[1]).toBe(0.75);
    expect(spends.filter((s) => s.ref === `${jobId}-release`)).toHaveLength(1);
    expect(balances.get('alice')).toBe(2.25);

    // Clean from then on: the old link, the fresh one, and the job's result.
    expect(await (await fetch(url)).text()).toBe('clean short.mp4');
    const fresh = (a.structuredContent.url as string) ?? '';
    expect(await (await fetch(fresh)).text()).toBe('clean short.mp4');
    expect(await (await fetch(pageUrl)).text()).not.toContain('carries the cuttingfloor mark');
    const after = (await call(alice, 'job.get', { job_id: jobId })).structuredContent as {
      result: { watermarked: boolean; release_credits?: number };
    };
    expect(after.result.watermarked).toBe(false);
    expect(after.result.release_credits).toBeUndefined();

    // Again: nothing spent.
    const again = await call(alice, 'export.release', { job_id: jobId });
    expect(again.structuredContent).toMatchObject({ credits: 0, price: 0.75, balance: 2.25 });
    await alice.close();
  });

  it('refuses a release the balance does not cover, and the marked file still downloads', async () => {
    balances.set('poor', 0.5);
    const { jobId, url } = await exported('poor', 'long.mp4', 'video/mp4', 61);
    const poor = await connect(`${KEY}-poor`);
    const refused = await call(poor, 'export.release', { job_id: jobId });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      code: 'quota_exceeded',
      detail: { price: 1.25, credits_left: 0.5 },
    });
    expect(JSON.stringify(refused.structuredContent)).not.toMatch(/https?:|buy/i);
    expect(balances.get('poor')).toBe(0.5);
    expect(await (await fetch(url)).text()).toBe(`clean long.mp4${MARK}`);
    await poor.close();
  });

  it('releases over /v1 as apps call it, the same once-only spend', async () => {
    balances.set('alice', 1);
    const { jobId, url } = await exported('alice', 'still.png', 'image/png', 0);
    const post = (body: unknown) =>
      fetch(`${base}/v1/export.release`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const res = await post({ job_id: jobId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job_id: jobId, credits: 0.25, balance: 0.75 });
    expect(await (await fetch(url)).text()).toBe('clean still.png');
    expect(await (await post({ job_id: jobId })).json()).toMatchObject({ credits: 0 });
    const short = await post({
      job_id: (await exported('alice', 'b.mp4', 'video/mp4', 300)).jobId,
    });
    expect(short.status).toBe(402);
    expect(await short.json()).toMatchObject({ code: 'quota_exceeded' });
  });

  it('releases with exactly the price left', async () => {
    balances.set('alice', 0.25);
    const { jobId } = await exported('alice', 'tiny.png', 'image/png', 0);
    const alice = await connect(KEY);
    const got = await call(alice, 'export.release', { job_id: jobId });
    expect(got.structuredContent).toMatchObject({ credits: 0.25, balance: 0 });
    await alice.close();
  });

  it('never marks audio, a given plan, or an export that has gone', async () => {
    balances.set('alice', 2);
    const audio = await exported('alice', 'mix.wav', 'audio/wav', 30);
    expect(await (await fetch(audio.url)).text()).toBe('clean mix.wav');
    const alice = await connect(KEY);
    const free = await call(alice, 'export.release', { job_id: audio.jobId });
    expect(free.structuredContent).toMatchObject({ credits: 0, price: 0 });

    exempt.add('staff');
    const given = await exported('staff', 'cut.mp4', 'video/mp4', 30);
    expect(await (await fetch(given.url)).text()).toBe('clean cut.mp4');

    const gone = await call(alice, 'export.release', { job_id: 'j_00000000000000000000000000' });
    expect(gone.structuredContent).toMatchObject({ code: 'not_found' });
    expect(balances.get('alice')).toBe(2);
    await alice.close();
  });
});
