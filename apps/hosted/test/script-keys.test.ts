import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { CfError } from '@cuttingfloor/schema';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// Script keys: the account page makes one through the site, a script calls /mcp with it as that
// account (with the account's checks), and a revoked key stops at once. The account checks are a
// stand-in here; the real WorkOS and Stripe ones run in scripts/smoke-account.ts.

const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const LAPSED = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
let base: string;
let server: Server;
let dataDir: string;
const checked: string[] = [];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-script-keys-'));
  dataDir = join(dir, 'data');
  const runtime = new Runtime({
    dataDir,
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
  const keys = new ScriptKeys(runtime.ws);
  const lifecycle = new Lifecycle({
    runtime,
    access: {} as AccessCheck,
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
    welcomeUrl: 'https://cuttingfloor.ai/welcome',
    serverUrl: 'https://api.cuttingfloor.ai',
    accountKey: ACCOUNT_KEY,
    keys,
  });
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
    scriptKeys: keys,
    access: async (owner) => {
      checked.push(owner);
      if (owner === LAPSED) throw new CfError('subscription_required', 'The trial has ended');
    },
    route: (req, res, url) => lifecycle.route(req, res, url),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const site = (path: string, body?: unknown, key = ACCOUNT_KEY) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: 'script', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

describe('script keys', () => {
  it('are made, listed and revoked by the site only', async () => {
    expect((await site(`/account/keys?user=${USER}`, undefined, 'wrong')).status).toBe(401);
    expect((await site('/account/keys', { user: 'not-a-user' })).status).toBe(400);
    const made = (await (await site('/account/keys', { user: USER, label: 'nightly' })).json()) as {
      key: string;
      key_id: string;
      starts: string;
      expires_at: string;
    };
    expect(made.key).toMatch(/^cf_[A-Za-z0-9_-]{43}$/);
    expect(made.starts).toBe(made.key.slice(0, 7));
    const year = Date.parse(made.expires_at) - Date.now();
    expect(year).toBeGreaterThan(364 * 86_400_000);
    const listed = (await (await site(`/account/keys?user=${USER}`)).json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(listed.keys).toEqual([
      expect.objectContaining({ key_id: made.key_id, label: 'nightly', starts: made.starts }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(made.key);
    // Only its SHA-256 is stored, never the key.
    const files = (await readdir(dataDir, { recursive: true })) as string[];
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      expect(await readFile(join(dataDir, f), 'utf8').catch(() => '')).not.toContain(made.key);
    }
    expect((await site('/account/keys/revoke', { user: LAPSED, key_id: made.key_id })).status).toBe(
      404,
    );
    expect((await site('/account/keys/revoke', { user: USER, key_id: made.key_id })).status).toBe(
      200,
    );
  });

  it('call /mcp as the account, with its checks, until revoked', async () => {
    const made = (await (await site('/account/keys', { user: USER })).json()) as {
      key: string;
      key_id: string;
    };
    const client = await connect(made.key);
    const created = (await client.callTool({
      name: 'timeline.create',
      arguments: { name: 'S', sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } } },
    })) as { isError?: boolean };
    expect(created.isError).toBeFalsy();
    expect(checked).toContain(USER);
    await client.close();

    // A lapsed account's key connects, and its calls get the account's refusal.
    const lapsed = (await (await site('/account/keys', { user: LAPSED })).json()) as {
      key: string;
    };
    const refused = await connect(lapsed.key);
    const result = (await refused.callTool({ name: 'job.list', arguments: {} })) as {
      isError?: boolean;
      structuredContent?: { code: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('subscription_required');
    await refused.close();

    await site('/account/keys/revoke', { user: USER, key_id: made.key_id });
    const after = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${made.key}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(after.status).toBe(401);
    expect(((await after.json()) as { error_description: string }).error_description).toMatch(
      /revoked or has expired/,
    );
  });
});
