import { mkdtemp } from 'node:fs/promises';
import { createServer as createNodeServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, parseApiKeys } from '../src/http.ts';
import { OAuthVerifier } from '../src/oauth.ts';

const KEY = 'test-key-0123456789abcdefghij';
let runtime: Runtime;
const servers: Server[] = [];

async function listen(
  apiKeys?: Map<string, string>,
  oauth?: (base: string) => OAuthVerifier,
): Promise<string> {
  // The OAuth resource names the server's own address, so take a free port first.
  const port = oauth ? await freePort() : 0;
  const server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    ...(apiKeys ? { apiKeys } : {}),
    ...(oauth ? { oauth: oauth(`http://127.0.0.1:${port}`) } : {}),
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function freePort(): Promise<number> {
  const probe = createNodeServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise((r) => probe.close(r));
  return port;
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-http-'));
  runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 60_000,
    maxDownloadBytes: 1024,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
});

afterAll(() => {
  for (const s of servers) s.close();
});

describe('HTTP face', () => {
  it('answers /healthz and 404s elsewhere', async () => {
    const base = await listen();
    expect(await (await fetch(`${base}/healthz`)).text()).toBe('ok');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('requires a bearer API key in hosted mode and scopes data to its owner', async () => {
    const base = await listen(parseApiKeys(`alice:${KEY},bob:${KEY}-bob`));
    const denied = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');

    const connect = async (key: string) => {
      const client = new Client({ name: 't', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        }),
      );
      return client;
    };
    const alice = await connect(KEY);
    const created = (await alice.callTool({
      name: 'timeline.create',
      arguments: { name: 'A', sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } } },
    })) as { structuredContent: { timeline_id: string } };
    const id = created.structuredContent.timeline_id;
    const bob = await connect(`${KEY}-bob`);
    const peek = (await bob.callTool({ name: 'timeline.get', arguments: { timeline_id: id } })) as {
      isError?: boolean;
    };
    expect(peek.isError).toBe(true);
    // Hosted mode has no path imports.
    const imp = (await alice.callTool({
      name: 'media.import',
      arguments: { source: { path: '/media/x.mp4' } },
    })) as { structuredContent: { code: string } };
    expect(imp.structuredContent.code).toBe('path_not_allowed');
    await alice.close();
    await bob.close();
  });

  it('refuses non-loopback hosts in local mode', async () => {
    const base = new URL(await listen());
    // fetch cannot set Host, so use a raw request, as a DNS-rebinding page would.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: base.hostname,
          port: base.port,
          path: '/mcp',
          method: 'POST',
          headers: { host: 'evil.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it('refuses forged or expired output links', async () => {
    const base = await listen();
    const { url } = await runtime.signOutput('local', 'j_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'x.mp4');
    const path = new URL(url);
    const local = `${base}${path.pathname}${path.search}`;
    expect((await fetch(local)).status).toBe(404);
    expect((await fetch(local.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
    expect((await fetch(local.replace(/exp=\d+/, 'exp=1'))).status).toBe(403);
  });

  it('validates API key configuration', () => {
    expect(() => parseApiKeys('alice')).toThrow(/owner:key/);
    expect(() => parseApiKeys('alice:short')).toThrow(/too short/);
    expect(parseApiKeys('').size).toBe(0);
  });

  it('challenges for OAuth and describes itself as a protected resource', async () => {
    const issuer = 'https://auth.example.com';
    const base = await listen(
      parseApiKeys(`ken:${KEY}`),
      (b) => new OAuthVerifier({ issuer, resource: `${b}/mcp` }),
    );
    const prmUrl = `${base}/.well-known/oauth-protected-resource/mcp`;

    const anon = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${prmUrl}"`);
    const prm = await (await fetch(prmUrl)).json();
    expect(prm).toEqual({
      resource: `${base}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'cuttingfloor',
    });
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()).toEqual(prm);

    const bad = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');

    // API keys keep working alongside OAuth.
    const keyed = new Client({ name: 't', version: '0' });
    await keyed.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${KEY}` } },
      }),
    );
    expect((await keyed.listTools()).tools.length).toBeGreaterThan(0);
    await keyed.close();
  });
});
