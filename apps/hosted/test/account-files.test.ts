import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The account page's drop zone: the site asks for an upload with its key, the browser sends the
// file straight to the signed URL, and the account's files and storage come back as media.list
// gives them. The account itself is a stand-in here (a trial with a small storage cap); the real
// WorkOS and Stripe checks run in scripts/smoke-account.ts.

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const CAP = 2000;
let base: string;
let server: Server;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-account-files-'));
  const runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 60_000,
    maxDownloadBytes: 1024 ** 2,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  const access = {
    get: async () => ({ allowed: true, plan: 'trial' }),
    limits: async () => ({ storageBytes: CAP, account: 'https://cuttingfloor.ai/account' }),
  } as unknown as AccessCheck;
  const lifecycle = new Lifecycle({
    runtime,
    access,
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
    welcomeUrl: 'https://cuttingfloor.ai/welcome',
    serverUrl: 'https://api.cuttingfloor.ai',
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

afterAll(() => {
  server.close();
});

const start = (body: unknown, key = ACCOUNT_KEY) =>
  fetch(`${base}/account/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const files = async () =>
  (await (
    await fetch(`${base}/account/media?user=${USER}`, {
      headers: { authorization: `Bearer ${ACCOUNT_KEY}` },
    })
  ).json()) as {
    allowed: boolean;
    uploads: Array<{ upload_id: string; name: string; complete: boolean }>;
    storage: { used_bytes: number; max_bytes: number | null };
  };

describe('account files', () => {
  it('answers only the site, with its key, and only for a WorkOS user id', async () => {
    expect((await start({ user: USER, name: 'a.mp4' }, 'wrong')).status).toBe(401);
    expect(
      (await start({ user: USER, name: 'a.mp4' }, 'maintenance-key-0123456789abcdef')).status,
    ).toBe(401);
    expect((await start({ user: 'ops', name: 'a.mp4' })).status).toBe(400);
    expect((await start({ user: USER, name: '../a.mp4' })).status).toBe(400);
    expect((await fetch(`${base}/account/media?user=${USER}`)).status).toBe(401);
  });

  it('starts an upload the browser sends straight to the server, then lists it', async () => {
    const res = await start({ user: USER, name: 'interview.mp4', bytes: 900 });
    expect(res.status).toBe(200);
    const up = (await res.json()) as { upload_id: string; url: string; max_bytes: number };
    expect(up.max_bytes).toBe(CAP);
    const sent = await fetch(up.url, { method: 'PUT', body: Buffer.alloc(900, 1) });
    expect(await sent.json()).toMatchObject({ received: 900, complete: true });

    const held = await files();
    expect(held.allowed).toBe(true);
    expect(held.uploads).toEqual([
      expect.objectContaining({ upload_id: up.upload_id, name: 'interview.mp4', complete: true }),
    ]);
    expect(held.storage.max_bytes).toBe(CAP);
    expect(held.storage.used_bytes).toBeGreaterThanOrEqual(900);
  });

  it('refuses a file bigger than the storage left, up front and part way', async () => {
    const res = await start({ user: USER, name: 'long.mp4', bytes: 5000 });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'quota_exceeded' });

    // A file whose size wasn't given stops at the room left.
    const up = (await (await start({ user: USER, name: 'unknown.mp4' })).json()) as {
      url: string;
      max_bytes: number;
    };
    expect(up.max_bytes).toBeLessThan(CAP - 900);
    const over = await fetch(up.url, { method: 'PUT', body: Buffer.alloc(up.max_bytes + 1) });
    expect(over.status).toBe(413);
    expect(((await over.json()) as { error: string }).error).toContain('storage');
  });
});
