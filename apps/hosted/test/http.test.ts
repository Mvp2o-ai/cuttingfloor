import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer as createNodeServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, parseApiKeys } from '../src/http.ts';
import { JwtTokenVerifier } from '../src/oauth.ts';

const KEY = 'test-key-0123456789abcdefghij';
let runtime: Runtime;
const servers: Server[] = [];

async function listen(
  apiKeys?: Map<string, string>,
  oauth?: (base: string) => { verifier: JwtTokenVerifier; resource: URL },
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

  it('plays a signed output on its watch page, and refuses a forged one', async () => {
    const base = await listen();
    const id = 'j_bbbbbbbbbbbbbbbbbbbbbbbbbb';
    const dir = runtime.ws.ownerDir('local', 'outputs', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cut "1".mp4'), 'not really a video');
    const { pageUrl } = await runtime.signOutput('local', id, 'cut "1".mp4');
    const signed = new URL(pageUrl);
    const page = `${base}${signed.pathname}${signed.search}`;
    const res = await fetch(page);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-security-policy')).toContain("media-src 'self'");
    const html = await res.text();
    expect(html).toContain('<title>cut &quot;1&quot;.mp4</title>');
    const src = /<video src="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
    expect(src).toMatch(/^\/outputs\/[^?]+\?exp=\d+&sig=/);
    const file = await fetch(`${base}${src}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('not really a video');
    expect((await fetch(page.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(403);
  });

  it('hands out working watch and download links when a job is read after its links expired', async () => {
    // A finished export keeps the links it was made with; they expire long before its file does.
    // Reading the job again (days into an edit) must give links that open.
    const base = await listen(parseApiKeys(`alice:${KEY},bob:${KEY}-bob`));
    (runtime.config as { publicUrl: string }).publicUrl = base;
    const store = runtime.jobs.store;
    const job = await store.create({ owner: 'alice', tool: 'export.video' });
    const dir = runtime.ws.ownerDir('alice', 'outputs', job.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'final cut.mp4'), 'the approved cut');
    const config = runtime.config as { outputUrlTtlMs: number };
    const ttl = config.outputUrlTtlMs;
    config.outputUrlTtlMs = -1000;
    const old = await runtime.signOutput('alice', job.id, 'final cut.mp4');
    config.outputUrlTtlMs = ttl;
    const stored = {
      url: old.url,
      page_url: old.pageUrl,
      expires_at: old.expiresAt,
      uri: `video://jobs/${job.id}/output`,
      bytes: 16,
    };
    await store.update(job, {
      status: 'completed',
      progress: 1,
      result: {
        content: [
          { type: 'resource_link', uri: old.url, name: 'final cut.mp4' },
          { type: 'text', text: JSON.stringify(stored) },
        ],
        structuredContent: stored,
      } as never,
    });
    const stale = await fetch(old.pageUrl);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('expired');

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
    const got = (await alice.callTool({ name: 'job.get', arguments: { job_id: job.id } })) as {
      structuredContent: { result: typeof stored };
      content: Array<{ type: string; uri?: string; text?: string }>;
    };
    const fresh = got.structuredContent.result;
    expect(Date.parse(fresh.expires_at)).toBeGreaterThan(Date.now());
    expect(fresh.page_url).not.toBe(old.pageUrl);
    const page = await fetch(fresh.page_url);
    expect(page.status).toBe(200);
    const src = /<video src="([^"]+)"/.exec(await page.text())?.[1]?.replace(/&amp;/g, '&');
    const file = await fetch(`${base}${src}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('the approved cut');
    expect((await fetch(fresh.url)).status).toBe(200);
    // The link parts and the text copy carry the fresh links too.
    const link = got.content.find((c) => c.type === 'resource_link');
    expect((await fetch(link?.uri ?? '')).status).toBe(200);
    expect(got.content.find((c) => c.type === 'text')?.text).toContain(fresh.expires_at);
    await alice.close();

    // Another account can't read the job to get links to it.
    const bob = await connect(`${KEY}-bob`);
    const denied = (await bob.callTool({ name: 'job.get', arguments: { job_id: job.id } })) as {
      isError?: boolean;
    };
    expect(denied.isError).toBe(true);
    await bob.close();
  });

  it('takes signed, resumable uploads for the owner who asked', async () => {
    const base = await listen(parseApiKeys(`alice:${KEY},bob:${KEY}-bob`));
    (runtime.config as { publicUrl: string }).publicUrl = base;
    const connect = async (key: string) => {
      const client = new Client({ name: 't', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        }),
      );
      return client;
    };
    const tool = async (client: Client, name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent: Record<string, unknown>;
      };
    const alice = await connect(KEY);
    const bob = await connect(`${KEY}-bob`);
    // This runtime takes files up to 1024 bytes.
    const big = await tool(alice, 'media.upload', { name: 'big.mp4', bytes: 4096 });
    expect(big.isError).toBe(true);

    const up = (await tool(alice, 'media.upload', { name: 'clip.mp4' })).structuredContent as {
      upload_id: string;
      url: string;
      max_bytes: number;
      how: string;
    };
    expect(up.upload_id).toMatch(/^u_/);
    expect(up.max_bytes).toBe(1024);
    expect(up.how).toContain(`curl --fail -T clip.mp4 '${up.url}'`);
    const url = new URL(up.url);
    expect(
      (await fetch(url, { method: 'OPTIONS' })).headers.get('access-control-allow-origin'),
    ).toBe('*');

    // A forged or expired link is refused.
    const forged = await fetch(up.url.replace(/sig=[^&]+/, 'sig=AAAA'), {
      method: 'PUT',
      body: 'x',
    });
    expect(forged.status).toBe(403);
    expect((await fetch(up.url.replace(/exp=\d+/, 'exp=1'), { method: 'HEAD' })).status).toBe(403);

    const body = Buffer.alloc(600, 7);
    const part = await fetch(url, {
      method: 'PUT',
      headers: { 'content-range': 'bytes 0-299/600' },
      body: body.subarray(0, 300),
    });
    expect(part.status).toBe(200);
    expect(part.headers.get('upload-offset')).toBe('300');
    // Not complete yet, so it doesn't import.
    const early = await tool(alice, 'media.import', { source: { upload_id: up.upload_id } });
    expect(early.structuredContent.code).toBe('media_not_ready');
    // A part that doesn't start where the upload stands says where it does.
    const gap = await fetch(url, {
      method: 'PUT',
      headers: { 'content-range': 'bytes 400-599/600' },
      body: body.subarray(400),
    });
    expect(gap.status).toBe(409);
    expect(gap.headers.get('upload-offset')).toBe('300');
    const rest = await fetch(url, {
      method: 'PUT',
      headers: { 'content-range': 'bytes 300-599/600' },
      body: body.subarray(300),
    });
    expect(await rest.json()).toMatchObject({ received: 600, complete: true });
    expect((await fetch(url, { method: 'PUT', body: 'more' })).status).toBe(409);

    // Another owner can't import it.
    const stolen = await tool(bob, 'media.import', { source: { upload_id: up.upload_id } });
    expect(stolen.structuredContent.code).toBe('not_found');
    // Its owner can, once: the import takes the file.
    const imported = await tool(alice, 'media.import', { source: { upload_id: up.upload_id } });
    expect(imported.structuredContent.media_id).toMatch(/^m_/);
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(404);

    // Bytes past the limit are refused part way.
    const over = (await tool(alice, 'media.upload', { name: 'over.wav' })).structuredContent as {
      url: string;
    };
    const refused = await fetch(over.url, { method: 'PUT', body: Buffer.alloc(2048) });
    expect(refused.status).toBe(413);
    await alice.close();
    await bob.close();
  });

  it('imports a data: URI, an attached file, and shows the upload page in a browser', async () => {
    const base = await listen(parseApiKeys(`alice:${KEY}`));
    (runtime.config as { publicUrl: string }).publicUrl = base;
    const client = new Client({ name: 't', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${KEY}` } },
      }),
    );
    const tool = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent: Record<string, unknown>;
      };
    // ChatGPT reads which argument takes an attached file from the tool's _meta.
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'media.import')?._meta).toMatchObject({
      'openai/fileParams': ['file'],
    });

    const bytes = Buffer.from('a small sound, as far as this test cares');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const data = `data:audio/wav;base64,${bytes.toString('base64')}`;
    const garbled = await tool('media.import', {
      source: { data, sha256: sha256.replace(/^./, sha256[0] === '0' ? '1' : '0') },
    });
    expect(garbled.structuredContent.code).toBe('bad_request');
    expect(String(garbled.structuredContent.message)).toContain(sha256);
    const notBase64 = await tool('media.import', { source: { data: 'data:;base64,@@@@' } });
    expect(notBase64.structuredContent.code).toBe('bad_request');
    const inline = await tool('media.import', { source: { data, sha256 }, name: 'beep.wav' });
    expect(inline.isError).toBeFalsy();
    expect(inline.structuredContent.media_id).toMatch(/^m_/);

    // Exactly one of source and file.
    expect((await tool('media.import', {})).structuredContent.code).toBe('bad_request');
    const attached = {
      download_url: 'https://files.example.com/f/abc',
      file_id: 'file_abc',
      mime_type: 'video/mp4',
      file_name: 'take2.mp4',
    };
    expect(
      (await tool('media.import', { source: { url: 'https://example.com/a.mp4' }, file: attached }))
        .structuredContent.code,
    ).toBe('bad_request');
    const fromFile = await tool('media.import', { file: attached });
    expect(fromFile.structuredContent.media_id).toMatch(/^m_/);

    // The upload link, opened in a browser, is a page to drop the file on.
    const up = (await tool('media.upload', { name: 'talk.mp4' })).structuredContent as {
      upload_id: string;
      url: string;
    };
    const page = await fetch(up.url, { headers: { accept: 'text/html,*/*' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(await page.text()).toContain(up.upload_id);
    // Scripts still get the state as JSON.
    expect(await (await fetch(up.url)).json()).toMatchObject({ received: 0, complete: false });
    // A PUT to a complete upload says it is complete, so the page stops.
    await fetch(up.url, { method: 'PUT', body: 'abc' });
    const again = await fetch(up.url, { method: 'PUT', body: 'abc' });
    expect(again.status).toBe(409);
    expect(again.headers.get('upload-complete')).toBe('true');
    await client.close();
  });

  it('validates API key configuration', () => {
    expect(() => parseApiKeys('alice')).toThrow(/owner:key/);
    expect(() => parseApiKeys('alice:short')).toThrow(/too short/);
    expect(parseApiKeys('').size).toBe(0);
  });

  it('challenges for OAuth and describes itself as a protected resource', async () => {
    const issuer = 'https://auth.example.com';
    const base = await listen(parseApiKeys(`ken:${KEY}`), (b) => ({
      // The authorization server's metadata as AuthKit publishes it; no token is checked here.
      verifier: new JwtTokenVerifier({
        issuer,
        authorization_endpoint: `${issuer}/oauth2/authorize`,
        token_endpoint: `${issuer}/oauth2/token`,
        jwks_uri: `${issuer}/oauth2/jwks`,
        response_types_supported: ['code'],
      }),
      resource: new URL(`${b}/mcp`),
    }));
    const prmUrl = `${base}/.well-known/oauth-protected-resource/mcp`;

    const anon = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(anon.headers.get('www-authenticate')).toContain(`resource_metadata="${prmUrl}"`);
    const prm = await (await fetch(prmUrl)).json();
    expect(prm).toMatchObject({
      resource: `${base}/mcp`,
      authorization_servers: [issuer],
      resource_name: 'cuttingfloor',
    });
    const asMeta = (await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json()) as { issuer: string };
    expect(asMeta.issuer).toBe(issuer);

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
