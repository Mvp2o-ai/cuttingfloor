import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { configFromEnv, Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createHttpServer, parseApiKeys } from '../src/http.ts';

// CUTTINGFLOOR_URL_SECRET: several servers sign and check links with one key, and a server moved
// from its secret.key file to the env keeps every link it already handed out.

const KEY = 'test-key-0123456789abcdefghij';
const servers: Server[] = [];

/** A hosted server on `dataDir`, configured from the environment a deployment would give it. */
async function serve(
  dataDir: string,
  env: Record<string, string> = {},
): Promise<{ base: string; runtime: Runtime }> {
  const runtime = new Runtime(
    configFromEnv({
      CUTTINGFLOOR_MODE: 'hosted',
      CUTTINGFLOOR_DATA: dataDir,
      CUTTINGFLOOR_MAX_JOBS: '1',
      ...env,
    }),
  );
  await runtime.start({ sweep: false });
  const server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: parseApiKeys(`alice:${KEY}`),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
  return { base, runtime };
}

async function connect(base: string): Promise<Client> {
  const client = new Client({ name: 't', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${KEY}` } },
    }),
  );
  return client;
}

/** The same link on another server. */
const on = (base: string, link: string) => {
  const url = new URL(link);
  return `${base}${url.pathname}${url.search}`;
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

afterAll(() => {
  for (const s of servers) s.close();
});

describe('CUTTINGFLOOR_URL_SECRET', () => {
  it('opens links a server signed with its secret.key on servers given the same bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-url-secret-'));
    const data = join(dir, 'data');
    // The first server has no env secret: it makes secret.key, as every server did before.
    const first = await serve(data);
    const { key } = JSON.parse(await readFile(join(data, 'secret.key'), 'utf8')) as { key: string };

    const id = 'j_cccccccccccccccccccccccccc';
    const out = first.runtime.ws.ownerDir('alice', 'outputs', id);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'cut.mp4'), 'the cut');
    const link = await first.runtime.signOutput('alice', id, 'cut.mp4');
    const alice = await connect(first.base);
    const up = (
      (await alice.callTool({ name: 'media.upload', arguments: { name: 'clip.mp4' } })) as {
        structuredContent: { url: string };
      }
    ).structuredContent;
    await alice.close();

    // A second server on the same files, holding the key only in its environment.
    const second = await serve(data, { CUTTINGFLOOR_URL_SECRET: key });
    const file = await fetch(on(second.base, link.url));
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('the cut');
    expect((await fetch(on(second.base, link.pageUrl))).status).toBe(200);
    expect((await fetch(on(second.base, up.url), { method: 'HEAD' })).status).toBe(200);
    // And the other way: what it signs opens on the server still reading the file.
    const back = await second.runtime.signOutput('alice', id, 'cut.mp4');
    expect((await fetch(on(first.base, back.url))).status).toBe(200);

    // The same bytes written as base64url.
    const urlSafe = Buffer.from(key, 'base64').toString('base64url');
    const third = await serve(data, { CUTTINGFLOOR_URL_SECRET: urlSafe });
    expect((await fetch(on(third.base, link.url))).status).toBe(200);

    // The env key is the one in use, not the file beside it: another key refuses the link.
    const other = await serve(data, {
      CUTTINGFLOOR_URL_SECRET: Buffer.alloc(32, 7).toString('base64'),
    });
    expect((await fetch(on(other.base, link.url))).status).toBe(403);
    expect((await fetch(on(other.base, up.url), { method: 'HEAD' })).status).toBe(403);
  });

  it('makes no secret.key when the key comes from the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-url-secret-'));
    const data = join(dir, 'data');
    const { base, runtime } = await serve(data, {
      CUTTINGFLOOR_URL_SECRET: Buffer.alloc(48, 3).toString('base64'),
    });
    const id = 'j_dddddddddddddddddddddddddd';
    const out = runtime.ws.ownerDir('alice', 'outputs', id);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'cut.mp4'), 'the cut');
    const link = await runtime.signOutput('alice', id, 'cut.mp4');
    expect((await fetch(on(base, link.url))).status).toBe(200);
    expect(await exists(join(data, 'secret.key'))).toBe(false);
  });

  it('refuses to start on a value shorter than 32 bytes, without repeating it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-url-secret-'));
    for (const value of [Buffer.alloc(31, 5).toString('base64'), 'short', 'not base64 at all!']) {
      const data = join(dir, `data-${value.length}`);
      const runtime = new Runtime(
        configFromEnv({
          CUTTINGFLOOR_MODE: 'hosted',
          CUTTINGFLOOR_DATA: data,
          CUTTINGFLOOR_URL_SECRET: value,
        }),
      );
      const error = await runtime.start({ sweep: false }).then(
        () => null,
        (e: Error) => e,
      );
      expect(error?.message).toContain('CUTTINGFLOOR_URL_SECRET must be at least 32 bytes');
      expect(error?.message).not.toContain(value);
      expect(await exists(join(data, 'secret.key'))).toBe(false);
    }
  });
});
