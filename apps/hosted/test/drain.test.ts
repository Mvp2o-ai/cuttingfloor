import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { createServer, Runtime } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import type { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The cutover's two switches. Draining: a server takes no new work while what it runs ends, so
// its data can be copied one last time. Standby: a server on a copy of the data costs nobody
// money and messages nobody, whatever is asked of it.

const OWNER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ09';
const SEQ = { width: 1280, height: 720, fps: { num: 25, den: 1 } };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.unstubAllGlobals();
});

async function serve(options: { drain?: boolean; standby?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cf-drain-'));
  const runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 3_600_000,
    maxDownloadBytes: 1024 ** 2,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
    node: 'old',
    ...(options.drain ? { drain: true } : {}),
    ...(options.standby ? { standby: true } : {}),
  });
  await runtime.start({ sweep: false });
  const server: Server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
  const mcp = createServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => OWNER,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const client = new Client({ name: 'drain', version: '0.0.0' });
  await client.connect(clientSide);
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await runtime.close();
    // A call's log line may still be landing as it closes.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  return { runtime, base, call, root: join(dir, 'data') };
}

describe('a draining server', () => {
  it('refuses writes and uploads with a retry, and keeps reads, job.get and media.list', async () => {
    const { runtime, base, call, root } = await serve();
    const made = await call('timeline.create', { name: 'Cut', sequence: SEQ });
    const timeline = made.structuredContent?.timeline_id as string;
    const upload = await call('media.upload', { name: 'a.mov' });
    const url = upload.structuredContent?.url as string;
    const exported = await call('export.timeline', { timeline_id: timeline, format: 'otio' });
    const job = exported.structuredContent?.job_id as string;
    // Turned on with no restart: a file in the data root.
    await writeFile(join(root, 'drain'), '');
    await runtime.drain.check();
    expect(runtime.drain.active).toBe(true);
    const refused = await call('timeline.create', { name: 'Again', sequence: SEQ });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      code: 'service_unavailable',
      detail: { retry: true, retry_after_seconds: 120 },
    });
    expect((await call('media.upload', { name: 'b.mov' })).isError).toBe(true);
    expect((await call('timeline.get', { timeline_id: timeline })).isError).toBeFalsy();
    expect((await call('job.get', { job_id: job })).isError).toBeFalsy();
    expect((await call('media.list', {})).isError).toBeFalsy();
    const put = await fetch(url, { method: 'PUT', body: 'bytes' });
    expect([put.status, put.headers.get('retry-after')]).toEqual([503, '120']);
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200);
    // It says so, with the jobs it still runs, and leaves a marker the final pass reads.
    const status = (await (await fetch(`${base}/healthz/drain`)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({ draining: true, jobs_running: expect.any(Number) });
    const marker = JSON.parse(await readFile(join(root, 'draining'), 'utf8'));
    expect(marker).toMatchObject({ node: 'old', jobs_running: expect.any(Number) });
    // Off again: the switch removed, the marker goes, and writes are taken.
    await rm(join(root, 'drain'));
    await runtime.drain.check();
    await expect(readFile(join(root, 'draining'))).rejects.toThrow();
    expect((await call('timeline.create', { name: 'After', sequence: SEQ })).isError).toBeFalsy();
  });

  it('drains from the start with CUTTINGFLOOR_DRAIN=1', async () => {
    const { call } = await serve({ drain: true });
    expect((await call('timeline.create', { name: 'Cut', sequence: SEQ })).isError).toBe(true);
  });
});

describe('a standby server’s lifecycle', () => {
  it('spends nothing on the ledger, writes no marks and refuses top-up, deletion and Stripe', async () => {
    const { runtime, base } = await serve({ standby: true });
    const outward: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === '127.0.0.1') return realFetch(input, init);
      outward.push(`${init?.method ?? 'GET'} ${url.hostname}${url.pathname}`);
      return new Response('{}', { status: 200 });
    });
    const seen: string[] = [];
    const access = {
      addSeconds: () => void seen.push('addSeconds'),
      get: async () => {
        seen.push('get');
        return { allowed: true, plan: 'free' };
      },
    } as unknown as AccessCheck;
    const ledger = {
      spend: async () => {
        seen.push('spend');
        return { balance: 0, duplicate: false, crossed: null };
      },
    } as unknown as Ledger;
    const make = (standby: boolean) =>
      new Lifecycle({
        runtime,
        access,
        ledger,
        workosKey: 'sk_test_none',
        stripeKey: 'sk_test_none',
        accountUrl: 'https://cuttingfloor.ai/account',
        accountKey: 'account-key-0123456789abcdef',
        standby,
      });
    const standby = make(true);
    standby.start({ sweep: false });
    await standby.called(OWNER);
    await runtime.meterJudgments(OWNER, 'q_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'judge.ask', 400);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([]);
    expect(outward).toEqual([]);
    for (const [method, path] of [
      ['POST', '/account/top-up'],
      ['DELETE', '/partner/users'],
      ['POST', '/stripe/webhook'],
    ] as const) {
      const res = new Promise<number>((resolve) => {
        const req = { method, resume: () => undefined, headers: {} } as never;
        const res = {
          writeHead: (status: number) => {
            resolve(status);
            return res;
          },
          setHeader: () => undefined,
          end: () => undefined,
        } as never;
        void standby.route(req, res, new URL(`${base}${path}`));
      });
      expect(await res, path).toBe(503);
    }
    // The same job on a server that is not standby is spent.
    const serving = make(false);
    serving.start({ sweep: false });
    await runtime.meterJudgments(OWNER, 'q_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'judge.ask', 400);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toContain('addSeconds');
  });
});
