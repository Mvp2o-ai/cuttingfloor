// Smoke test for OAuth sign-in on a live hosted server, against the real WorkOS AuthKit.
//
//   WORKOS_API_KEY=sk_… CHROME_PATH=/path/to/chrome \
//     node scripts/smoke-oauth.ts https://cuttingfloorai.apifunnel.ai
//
// Makes a throwaway WorkOS user, then does what an MCP client does: gets a 401, reads the
// protected resource metadata, registers itself with AuthKit, sends the user through AuthKit's
// sign-in page (driven by Chromium), redeems the code and calls tools with the token. Then
// checks that a real WorkOS token minted for another audience is refused, and deletes the user.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Client,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'https://cuttingfloorai.apifunnel.ai').replace(/\/$/, '');
const workosKey = process.env.WORKOS_API_KEY;
const chrome = process.env.CHROME_PATH;
if (!workosKey) throw new Error('Set WORKOS_API_KEY to the environment’s API key');
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome or Chromium binary');

const step = (label: string) => process.stdout.write(`• ${label}\n`);
const failures: string[] = [];
function expect(ok: boolean, label: string) {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures.push(label);
}

async function workos(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.workos.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${workosKey}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`WorkOS ${path}: ${res.status} ${JSON.stringify(body)}`);
  return body as Record<string, unknown>;
}

step('the server challenges and describes itself');
const anon = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
const challenge = anon.headers.get('www-authenticate') ?? '';
expect(anon.status === 401, `401 without a token (got ${anon.status})`);
const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
expect(Boolean(prmUrl), `challenge names the metadata (${challenge})`);
const prm = (await (await fetch(prmUrl ?? '')).json()) as {
  resource: string;
  authorization_servers: string[];
};
expect(prm.resource === `${base}/mcp`, `resource is ${prm.resource}`);
const issuer = prm.authorization_servers[0] ?? '';
const asMeta = (await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json()) as {
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
};
expect(
  Boolean(asMeta.registration_endpoint || asMeta.client_id_metadata_document_supported),
  `${issuer} lets clients register (DCR ${Boolean(asMeta.registration_endpoint)}, CIMD ${Boolean(asMeta.client_id_metadata_document_supported)})`,
);

const email = `smoke-${Date.now()}@cuttingfloor-smoke.dev`;
const password = `Cf-${randomBytes(18).toString('base64url')}`;
const user = await workos('/user_management/users', {
  method: 'POST',
  body: JSON.stringify({ email, password, email_verified: true, first_name: 'Smoke' }),
});
const userId = user.id as string;
step(`signed in as a throwaway user (${userId})`);

// The redirect lands on a loopback listener, as a desktop client's does.
let resolveCallback: (params: URLSearchParams) => void = () => {};
const callback = new Promise<URLSearchParams>((r) => {
  resolveCallback = r;
});
const listener = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/plain' }).end('signed in; you can close this');
  resolveCallback(url.searchParams);
});
await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
const redirectUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/callback`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
let tokens: { access_token: string } | undefined;
let clientInfo: { client_id: string } | undefined;
let verifier = '';
const provider: OAuthClientProvider = {
  get redirectUrl() {
    return redirectUrl;
  },
  get clientMetadata() {
    return {
      client_name: 'cuttingfloor smoke',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  clientInformation: () => clientInfo,
  saveClientInformation: (info) => {
    clientInfo = info as { client_id: string };
  },
  tokens: () => tokens as never,
  saveTokens: (t) => {
    tokens = t as { access_token: string };
  },
  saveCodeVerifier: (v) => {
    verifier = v;
  },
  codeVerifier: () => verifier,
  redirectToAuthorization: async (url) => {
    await signIn(url);
  },
};

/** Goes through AuthKit's hosted page as the user would. */
async function signIn(url: URL) {
  const page = await browser.newPage();
  await page.goto(url.toString(), { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type=email], input[name=email]', { timeout: 30_000 });
  await page.type('input[type=email], input[name=email]', email);
  await page.keyboard.press('Enter');
  await page.waitForSelector('input[type=password]', { visible: true, timeout: 30_000 });
  await page.type('input[type=password]', password);
  await page.keyboard.press('Enter');
  // A consent screen may follow for a newly registered client.
  for (let i = 0; i < 30 && !page.url().startsWith(redirectUrl); i++) {
    const allow = await page.$(
      'xpath/.//button[contains(., "Allow") or contains(., "Accept") or contains(., "Authorize") or contains(., "Continue")]',
    );
    if (allow && !page.url().startsWith(redirectUrl)) await allow.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page.url().startsWith(redirectUrl)) {
    await page.screenshot({ path: 'smoke-oauth-stuck.png' });
    throw new Error(`sign-in did not come back (at ${page.url()}); see smoke-oauth-stuck.png`);
  }
}

try {
  step('a client signs in through AuthKit and calls tools');
  const url = new URL(`${base}/mcp`);
  const client = new Client({ name: 'smoke-oauth', version: '0' });
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    await transport.finishAuth(await callback);
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
  }
  expect(Boolean(clientInfo?.client_id), `registered as ${clientInfo?.client_id}`);
  const claims = JSON.parse(
    Buffer.from((tokens?.access_token ?? '').split('.')[1] ?? '', 'base64url').toString() || '{}',
  ) as { aud?: string | string[]; sub?: string };
  expect(claims.sub === userId, `the token's subject is the user (${claims.sub})`);
  expect(
    [claims.aud].flat().includes(`${base}/mcp`),
    `the token's audience is this server (${claims.aud})`,
  );
  const { tools } = await client.listTools();
  expect(tools.length > 40, `${tools.length} tools`);
  const created = (await client.callTool({
    name: 'timeline.create',
    arguments: { name: 'oauth', sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } } },
  })) as { isError?: boolean; structuredContent?: { timeline_id?: string } };
  expect(!created.isError && Boolean(created.structuredContent?.timeline_id), 'timeline.create');
  await client.close();

  step('a real WorkOS token for another audience is refused');
  const session = await workos('/user_management/authenticate', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'password',
      client_id: process.env.WORKOS_CLIENT_ID,
      client_secret: workosKey,
      email,
      password,
    }),
  }).catch((error: Error) => ({ error: error.message }));
  if ('access_token' in session) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.access_token}` },
      body: '{}',
    });
    expect(res.status === 401, `session token refused (got ${res.status})`);
  } else {
    process.stdout.write(`  – skipped: set WORKOS_CLIENT_ID for this check (${session.error})\n`);
  }
} finally {
  await browser.close();
  listener.close();
  await workos(`/user_management/users/${userId}`, { method: 'DELETE' });
  step('deleted the throwaway user');
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
