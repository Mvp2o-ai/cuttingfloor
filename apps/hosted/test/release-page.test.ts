import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The QR code on a review copy's cards opens the site's release page, which signs the viewer in
// and asks the server, with the site's key, for that user's own file: its price and their credits,
// then the release. Anyone can scan a shared video, so another account's id is not found, and
// nothing is spent for it. The mark is a stand-in that records the link its code would carry.

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const OWNER = 'user_01OWNEROWNEROWNEROWNEROW01';
const STRANGER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
const MARK = '\n[cuttingfloor watermark]';
let base: string;
let server: Server;
let runtime: Runtime;
const balances = new Map<string, number>();
const spends: string[] = [];
const codes: Array<string | undefined> = [];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-release-page-'));
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
      exempt: async () => false,
      balance: async (owner) => balances.get(owner) ?? 0,
      spend: async (owner, ref, credits) => {
        if (!spends.includes(ref)) {
          spends.push(ref);
          balances.set(owner, (balances.get(owner) ?? 0) - credits);
        }
        return { balance: balances.get(owner) ?? 0 };
      },
      mark: async (input, output, _seed, qr) => {
        codes.push(qr);
        await writeFile(output, `${await readFile(input, 'utf8')}${MARK}`);
      },
      releasePage: (id) => `https://cuttingfloor.ai/r/${id}`,
    },
    { from: '2000-01-01T00:00:00Z' },
  );
  const access = {
    get: async () => ({ allowed: true, plan: 'credits' }),
    limits: async () => ({ storageBytes: null, account: 'https://cuttingfloor.ai/account' }),
  } as unknown as AccessCheck;
  const lifecycle = new Lifecycle({
    runtime,
    access,
    ledger: new Ledger('http://127.0.0.1:9', 'none'),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
    accountKey: ACCOUNT_KEY,
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    route: (req, res, url) => lifecycle.route(req, res, url),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
});

afterAll(() => server.close());

/** A finished video export of `seconds`, as export.video leaves one. */
async function exported(owner: string, name: string, seconds: number) {
  const store = runtime.jobs.store;
  const job = await store.create({ owner, tool: 'export.video' });
  await runtime.outputs.write(owner, job.id, name, `clean ${name}`, 'export');
  const signed = await runtime.signOutput(owner, job.id, name);
  const result = { url: signed.url, mime_type: 'video/mp4', duration_seconds: seconds };
  await store.update(job, {
    status: 'completed',
    progress: 1,
    result: { content: [], structuredContent: result } as never,
  });
  return { jobId: job.id, url: signed.url };
}

const read = (user: string, file: string, key = ACCOUNT_KEY) =>
  fetch(`${base}/account/release?${new URLSearchParams({ user, file })}`, {
    headers: { authorization: `Bearer ${key}` },
  });
const release = (user: string, file: string) =>
  fetch(`${base}/account/release`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ACCOUNT_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ user, file }),
  });

describe('the release page behind the QR code', () => {
  it('puts the file’s own release page in the code on its cards', async () => {
    const { jobId, url } = await exported(OWNER, 'cut.mp4', 30);
    expect(await (await fetch(url)).text()).toBe(`clean cut.mp4${MARK}`);
    expect(codes.at(-1)).toBe(`https://cuttingfloor.ai/r/${jobId}`);
  });

  it('answers only the site, with its key', async () => {
    const { jobId } = await exported(OWNER, 'a.mp4', 30);
    expect((await read(OWNER, jobId, 'wrong')).status).toBe(401);
    expect((await read('ops', jobId)).status).toBe(400);
    expect((await read(OWNER, '../etc')).status).toBe(404);
  });

  it('finds the file only on its owner’s account; a stranger who scans it spends nothing', async () => {
    balances.set(OWNER, 10);
    balances.set(STRANGER, 10);
    const { jobId } = await exported(OWNER, 'shared.mp4', 90);
    expect((await read(STRANGER, jobId)).status).toBe(404);
    expect((await release(STRANGER, jobId)).status).toBe(404);
    expect(spends).not.toContain(`${jobId}-release`);
    expect(balances.get(OWNER)).toBe(10);

    const seen = (await (await read(OWNER, jobId)).json()) as Record<string, unknown>;
    expect(seen).toMatchObject({
      file: jobId,
      name: 'shared.mp4',
      watermarked: true,
      release_credits: 1.5,
      credits_left: 10,
    });
    expect(String(seen.page_url)).toContain('/watch/');
  });

  it('releases the owner’s file once, and every link is clean after', async () => {
    balances.set(OWNER, 10);
    const { jobId, url } = await exported(OWNER, 'final.mp4', 60);
    const done = await release(OWNER, jobId);
    expect(done.status).toBe(200);
    const body = (await done.json()) as { watermarked: boolean; spent: number; url: string };
    expect(body).toMatchObject({ watermarked: false, spent: 1 });
    expect(balances.get(OWNER)).toBe(9);
    expect(await (await fetch(url)).text()).toBe('clean final.mp4');
    expect(await (await fetch(body.url)).text()).toBe('clean final.mp4');
    // Pressed again: already released, nothing more spent.
    expect(((await (await release(OWNER, jobId)).json()) as { spent: number }).spent).toBe(0);
    expect(balances.get(OWNER)).toBe(9);
  });

  it('says the price when the credits fall short, and spends nothing', async () => {
    balances.set(OWNER, 0.5);
    const { jobId } = await exported(OWNER, 'long.mp4', 120);
    const short = await release(OWNER, jobId);
    expect(short.status).toBe(402);
    expect(await short.json()).toMatchObject({ price: 2, credits_left: 0.5 });
    expect(balances.get(OWNER)).toBe(0.5);
  });
});
