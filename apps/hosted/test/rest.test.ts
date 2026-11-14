import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { CfError } from '@cuttingfloor/schema';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';

// The tools as plain HTTP: POST /v1/<tool> with an account's script key acts as that account,
// through the same server /mcp uses, and /openapi.json describes every tool tools/list gives.

const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';
const LAPSED = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
let base: string;
let server: Server;
let keys: ScriptKeys;
let key: string;
const called: string[] = [];
const apps: [string, string][] = [];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-rest-'));
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
  keys = new ScriptKeys(runtime.ws);
  key = (await keys.create(USER, 'rest test')).key;
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    scriptKeys: keys,
    access: async (owner) => {
      if (owner === LAPSED) throw new CfError('subscription_required', 'The last payment failed');
    },
    onCall: (owner) => void called.push(owner),
    onApp: (owner, app) => apps.push([owner, app]),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const post = (tool: string, body: unknown, bearer: string | null = key) =>
  fetch(`${base}/v1/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const SEQUENCE = { width: 640, height: 360, fps: { num: 25, den: 1 } };

describe('REST', () => {
  it('describes every tool tools/list gives, with its schemas, at /openapi.json', async () => {
    const res = await fetch(`${base}/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, { post: Record<string, unknown> }>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.openapi).toBe('3.1.0');

    const mcp = new Client({ name: 'list', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await mcp.listTools();
    await mcp.close();
    expect(Object.keys(spec.paths).sort()).toEqual(tools.map((t) => `/v1/${t.name}`).sort());

    const add = spec.paths['/v1/clip.add']?.post as {
      operationId: string;
      requestBody: { content: { 'application/json': { schema: { $ref: string } } } };
    };
    expect(add.operationId).toBe('clip_add');
    expect(add.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/clip_add_args',
    );
    // Every reference resolves inside the document: no tool's own `#/$defs` is left behind.
    const text = JSON.stringify(spec);
    expect(text).not.toContain('"#/$defs');
    for (const [, name] of text.matchAll(/"\$ref":"#\/components\/schemas\/([^"/]+)/g))
      expect(spec.components.schemas[name as string], name).toBeDefined();
  });

  it('lists the tools without a key', async () => {
    const res = await fetch(`${base}/v1/tools`);
    const body = (await res.json()) as { tools: Array<{ name: string; path: string }> };
    expect(body.tools).toContainEqual(
      expect.objectContaining({ name: 'timeline.create', path: '/v1/timeline.create' }),
    );
  });

  it('calls a tool as the key’s account and answers its result', async () => {
    const res = await post('timeline.create', { name: 'REST', sequence: SEQUENCE });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { timeline_id: string };
    expect(created.timeline_id).toMatch(/^tl_/);
    expect(called).toContain(USER);
    expect(apps).toContainEqual([USER, 'rest']);

    // The same account's work, seen over MCP with the same key.
    const mcp = new Client({ name: 'script', version: '0' });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    const got = (await mcp.callTool({
      name: 'timeline.get',
      arguments: { timeline_id: created.timeline_id },
    })) as { isError?: boolean };
    expect(got.isError).toBeFalsy();
    await mcp.close();

    const edited = await post('track.add', { timeline_id: created.timeline_id, kind: 'video' });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as { parent: string }).parent).toBe(created.timeline_id);
  });

  it('answers a refusal with its status and {code, message, hint}', async () => {
    // An id the server never held.
    const gone = await post('timeline.get', { timeline_id: 'tl_00000000000000000000000000000000' });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: 'not_found', message: expect.any(String) });

    const wrong = await post('timeline.create', { name: 'no sequence' });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/sequence/),
    });

    expect((await post('timeline.create', 'not json')).status).toBe(400);
    expect((await post('timeline.create', [1])).status).toBe(400);
    expect((await post('nope.nope', {})).status).toBe(404);
    expect((await fetch(`${base}/v1/timeline.create`)).status).toBe(405);
  });

  it('takes no call without a working key, and gives the account’s own refusals', async () => {
    const none = await post('job.list', {}, null);
    expect(none.status).toBe(401);
    const unknown = await post('job.list', {}, 'cf_notakeynotakeynotakeynotakeynotakeynotakey1');
    expect(unknown.status).toBe(401);
    const lapsed = (await keys.create(LAPSED, 'lapsed')).key;
    const refused = await post('job.list', {}, lapsed);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ code: 'subscription_required' });
  });

  it('answers a browser’s preflight', async () => {
    const res = await fetch(`${base}/v1/timeline.create`, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/authorization/);
  });
});
