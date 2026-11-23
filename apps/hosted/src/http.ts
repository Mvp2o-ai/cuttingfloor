import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import {
  type CredentialStore,
  RequestCredentialStore,
  SavedCredentialStore,
  type SavedKeys,
} from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import {
  createServer,
  creditsClaimed,
  DRAIN_RETRY_SECONDS,
  drainingError,
  markWelcomed,
  type OwnerLimits,
  outputMime,
  type Runtime,
  UploadRefused,
} from '@cuttingfloor/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import { addressPage, wantsPage } from './address-page.ts';
import type { JwtTokenVerifier } from './oauth.ts';
import { RestApi } from './rest.ts';
import { aiCatalog, CARD_TYPE, sendDiscovery, serverCard } from './server-card.ts';
import { uploadPage } from './upload-page.ts';
import { watchPage } from './watch-page.ts';

export interface HttpOptions {
  runtime: Runtime;
  credentials: CredentialStore;
  /**
   * Hosted mode: bearer API keys, each mapped to the owner it acts as. Local mode passes none and
   * the server only answers on loopback host names.
   */
  apiKeys?: Map<string, string>;
  /**
   * Hosted: the keys signed-in users make on the account page for scripts (`cf_…`). A request
   * with one acts as that account, with the same plan checks as a sign-in.
   */
  scriptKeys?: { owner(key: string): Promise<string | undefined> };
  /**
   * Hosted mode: MCP authorization (2026-07-28) with this server as the OAuth resource `resource`
   * (its /mcp URL) and tokens from the verifier's authorization server, alongside any API keys.
   */
  oauth?: { verifier: JwtTokenVerifier; resource: URL };
  /**
   * Hosted: whether a signed-in owner may work (its plan); throws a CfError when not. Applies
   * to OAuth sign-ins and script keys: maintenance API keys are never gated.
   */
  access?: (owner: string) => Promise<void>;
  /** Hosted: a signed-in owner's plan as limits on the work they start (not maintenance keys). */
  limits?: (owner: string, options?: { buy?: boolean }) => Promise<OwnerLimits>;
  /** Hosted: a signed-in owner's plan and credits, for account.get (not maintenance keys). */
  account?: (owner: string) => Promise<AccountGetResult>;
  /** Told of each signed-in owner's MCP request (first-call records). */
  onCall?: (owner: string) => void | Promise<void>;
  /** Whether the owner's request here was the account's first ever (after onCall told of it). */
  firstConnection?: (owner: string) => Promise<boolean>;
  /** Told the app a signed-in owner's request came from, by its MCP clientInfo name. */
  onApp?: (owner: string, app: string) => void;
  /** Provider keys signed-in users saved on their account page, after any in the request. */
  savedKeys?: SavedKeys;
  /** Routes of the hosting app (billing webhooks, account data); true when it answered. */
  route?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  /**
   * Told of each step toward sign-in this server sees, with the client's User-Agent: `challenged`
   * (an /mcp request without a token got the sign-in challenge) and `metadata` (a client read where
   * to sign in). The steps between them and a signed-in call happen at the authorization server.
   */
  onSignInStep?: (step: SignInStep, userAgent: string) => void;
  /** The token OpenAI's plugin portal asks this host to serve, to prove it owns the domain. */
  openaiChallenge?: string;
}

export type SignInStep = 'challenged' | 'metadata';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * What a client may ask before it signs in: who the server is and what it offers. The lists are
 * the same for every account, so a client can show them before sign-in; everything else (tool
 * calls, reads, jobs) needs a token.
 */
const DISCOVERY_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'server/discover',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

// The 2026-07-28 protocol puts the client's identity in every request's _meta; the 2025 handshake
// sends it once, in initialize.
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
// Bodies larger than this (a data: URI import) aren't read for the name; the next request is.
const APP_BODY_MAX = 64 * 1024;

/** The clientInfo name a POST body carries, if any. */
async function appName(request: Request): Promise<string | undefined> {
  if (request.method !== 'POST') return undefined;
  if (Number(request.headers.get('content-length') ?? 0) > APP_BODY_MAX) return undefined;
  let body: unknown;
  try {
    const text = await request.clone().text();
    if (text.length > APP_BODY_MAX) return undefined;
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const m of Array.isArray(body) ? body : [body]) {
    const params = (m as { params?: Record<string, unknown> } | null)?.params;
    const info =
      (m as { method?: unknown }).method === 'initialize'
        ? params?.clientInfo
        : (params?._meta as Record<string, unknown> | undefined)?.[CLIENT_INFO_META];
    const name = (info as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name) return name;
  }
  return undefined;
}

/**
 * The app a User-Agent names (its first product, without the version), for a signed-in request
 * that carries no clientInfo: a 2025 client that said who it was in an initialize sent before
 * sign-in (ChatGPT sends `openai-mcp/1.0.0`).
 */
/** A request from ChatGPT: its connector's User-Agent is openai-mcp/…. */
function chatgpt(headers: Headers | undefined): boolean {
  return /^openai-mcp\b/i.test(headers?.get('user-agent') ?? '');
}

function userAgentApp(userAgent: string | undefined): string | undefined {
  return /^[\w.-]+/.exec(userAgent ?? '')?.[0];
}

/** Whether a POST body asks for the server's instructions: initialize, or discovery in the newer protocol. */
async function sendsInstructions(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  try {
    const body: unknown = JSON.parse(await request.clone().text());
    return (Array.isArray(body) ? body : [body]).some((m) =>
      INSTRUCTION_METHODS.has((m as { method?: unknown } | null)?.method as string),
    );
  } catch {
    return false;
  }
}

const INSTRUCTION_METHODS = new Set(['initialize', 'server/discover']);

/** Whether a POST body holds only discovery messages (one, or a 2025-03-26 batch). */
async function isDiscovery(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  let body: unknown;
  try {
    body = JSON.parse(await request.clone().text());
  } catch {
    return false;
  }
  const messages = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        DISCOVERY_METHODS.has((m as { method?: unknown }).method as string),
    )
  );
}

/**
 * The HTTP face: Streamable HTTP MCP at /mcp (2026-07-28, with stateless 2025 fallback), the
 * same tools as plain HTTP at /v1/<tool> (described at /openapi.json), signed output downloads at /outputs/… (and the page that plays one at /watch/…), signed uploads
 * at /uploads/…, and /healthz.
 */
export function createHttpServer(options: HttpOptions): Server {
  const { runtime, credentials, oauth } = options;
  /** One MCP server for one request, as `owner` signed in `via`; /mcp and /v1 both use it. */
  const serverFor = async (
    owner: string,
    via: unknown,
    requestHeaders?: Headers,
    channel: 'mcp' | 'rest' = 'mcp',
  ) => {
    const signedIn = via === 'oauth' || via === 'script';
    // Before sign-in only discovery reaches a server; refuse any tool all the same.
    const anonymous = via === 'anonymous';
    const gate = signedIn ? options.access : undefined;
    const limits = signedIn ? options.limits : undefined;
    const account = signedIn ? options.account : undefined;
    // Hosted, provider keys come with each request (X-Cuttingfloor-Key-<Provider>) and live
    // only as long as it, or the job it starts; locally they come from env and secrets.
    const headers = runtime.config.mode === 'hosted' ? requestHeaders : undefined;
    // Then the keys the account saved on its page (none for maintenance keys).
    const saved = options.savedKeys
      ? new SavedCredentialStore(credentials, options.savedKeys)
      : credentials;
    // The welcome a new account's connection gets: on the filesystem createServer reads the
    // claim in place; a database is read here, before the server is built. If it can't be read
    // the connection goes without the welcome, and the call itself says what is wrong.
    const claimed =
      account && runtime.config.records
        ? await creditsClaimed(runtime, owner).catch(() => true)
        : undefined;
    return createServer({
      runtime,
      ...(claimed !== undefined ? { claimed } : {}),
      credentials: headers ? new RequestCredentialStore(saved, headers) : saved,
      owner: () => owner,
      ...(gate ? { access: () => gate(owner) } : {}),
      ...(anonymous
        ? { access: () => Promise.reject(new Error('Sign in to cuttingfloor first')) }
        : {}),
      // ChatGPT's plugin rules forbid selling credits, so its refusals only say what stopped.
      ...(limits ? { limits: () => limits(owner, { buy: !chatgpt(requestHeaders) }) } : {}),
      ...(account ? { account: () => account(owner) } : {}),
      // Apps call /v1 for their users: no assistant reads a result there.
      ...(channel === 'rest' ? { firstResultGuidance: false } : {}),
    });
  };
  const handler = createMcpHandler(
    (ctx) =>
      serverFor(
        ctx.authInfo?.clientId ?? 'local',
        ctx.authInfo?.extra?.via,
        ctx.requestInfo?.headers,
      ),
    { onerror: (error) => process.stderr.write(`mcp: ${error.message}\n`) },
  );
  const rest = new RestApi(runtime, (owner, via, headers) =>
    serverFor(owner, via, headers, 'rest'),
  );
  const hashedKeys = [...(options.apiKeys ?? new Map()).entries()].map(([key, owner]) => ({
    digest: createHash('sha256').update(key).digest(),
    owner,
  }));

  const resourceMetadataUrl = oauth && getOAuthProtectedResourceMetadataUrl(oauth.resource);
  const requireToken =
    oauth &&
    requireBearerAuth({
      verifier: oauth.verifier,
      expectedResource: oauth.resource,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    });

  /** An API key's owner, if the request carries one. */
  function apiKeyOwner(req: IncomingMessage): string | undefined {
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !hashedKeys.length) return undefined;
    const digest = createHash('sha256').update(token).digest();
    return hashedKeys.find((k) => timingSafeEqual(k.digest, digest))?.owner;
  }

  /**
   * Who a request acts as: a maintenance key, a script key, a sign-in token, or (for discovery
   * only) nobody yet. Undefined once the request has been answered: refused or challenged.
   */
  async function authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    request: Request,
    discovery: () => Promise<boolean>,
  ): Promise<{ owner: string; via: string } | undefined> {
    if (hashedKeys.length || requireToken || options.scriptKeys) {
      const keyOwner = apiKeyOwner(req);
      const bearer = /^Bearer (cf_\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const scriptOwner = !keyOwner && bearer ? await options.scriptKeys?.owner(bearer) : undefined;
      if (keyOwner) return { owner: keyOwner, via: 'key' };
      if (scriptOwner) {
        await options.onCall?.(scriptOwner);
        return { owner: scriptOwner, via: 'script' };
      }
      if (bearer && options.scriptKeys) {
        res
          .writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': 'Bearer error="invalid_token"',
          })
          .end(
            JSON.stringify({
              error: 'invalid_token',
              error_description:
                'This script key was revoked or has expired; make a new one on your account page',
            }),
          );
        return undefined;
      }
      if (!req.headers.authorization && (await discovery()))
        return { owner: 'anonymous', via: 'anonymous' };
      if (requireToken) {
        const auth = await requireToken(request);
        if (auth instanceof Response) {
          if (!req.headers.authorization)
            options.onSignInStep?.('challenged', req.headers['user-agent'] ?? '');
          if (!req.headers.authorization && wantsPage(req.method, req.headers.accept)) {
            // A person opened the address in a browser: the same challenge, with a page to read.
            const { 'content-length': _, ...headers } = Object.fromEntries(auth.headers);
            res
              .writeHead(auth.status, { ...headers, 'content-type': 'text/html; charset=utf-8' })
              .end(addressPage(options.oauth?.resource.href ?? `${runtime.config.publicUrl}/mcp`));
            return undefined;
          }
          await sendResponse(res, auth);
          return undefined;
        }
        const owner = String(auth.extra?.sub);
        await options.onCall?.(owner);
        return { owner, via: 'oauth' };
      }
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(
        JSON.stringify({
          error: 'invalid_token',
          error_description: 'Send Authorization: Bearer <api key>',
        }),
      );
      return undefined;
    }
    // Local mode: refuse DNS-rebinding and cross-site browser requests.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const origin = req.headers.origin;
    if (!LOCAL_HOSTS.has(host) || (origin && !LOCAL_HOSTS.has(new URL(origin).hostname))) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host');
      return undefined;
    }
    return { owner: 'local', via: 'local' };
  }

  const server = createNodeServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
      }
      // Whether the server is draining and how many of its jobs still run: counts only.
      if (url.pathname === '/healthz/drain') {
        res
          .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify(await runtime.drain.status()));
        return;
      }
      if (options.openaiChallenge && url.pathname === '/.well-known/openai-apps-challenge') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(options.openaiChallenge);
        return;
      }
      // The discovery documents: Protected Resource Metadata (RFC 9728), and the authorization
      // server's metadata for clients from before it.
      if (oauth && url.pathname.startsWith('/.well-known/')) {
        const metadata = oauthMetadataResponse(
          new Request(webUrl(req), { method: req.method ?? 'GET' }),
          {
            oauthMetadata: oauth.verifier.metadata as OAuthMetadata,
            resourceServerUrl: oauth.resource,
            resourceName: 'cuttingfloor',
          },
        );
        if (metadata) {
          if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
            options.onSignInStep?.('metadata', req.headers['user-agent'] ?? '');
          await sendResponse(res, metadata);
          return;
        }
      }
      // The Server Card next to the MCP endpoint, and the domain's AI Catalog that lists it.
      if (url.pathname === '/mcp/server-card') {
        sendDiscovery(req, res, serverCard(runtime.config.publicUrl), CARD_TYPE);
        return;
      }
      if (url.pathname === '/.well-known/ai-catalog.json') {
        sendDiscovery(req, res, aiCatalog(runtime.config.publicUrl), 'application/ai-catalog+json');
        return;
      }
      if (url.pathname.startsWith('/outputs/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const target = await runtime.outputTarget(
          url.pathname,
          url.searchParams.get('exp'),
          url.searchParams.get('sig'),
        );
        if (!target) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end(refusedLink(url));
          return;
        }
        const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        // Files in a bucket are fetched from it: the link is checked here, then answered with
        // a short-lived link to the file itself.
        if (target.blob && runtime.ws.blobs.remote) {
          await sendBlob(runtime, req, res, target.blob, name, {
            inline: url.searchParams.has('inline'),
            expires: Number(url.searchParams.get('exp')),
          });
          return;
        }
        const file = target.file ?? (target.blob && (await runtime.scratchFile(target.blob)));
        if (!file) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end(refusedLink(url));
          return;
        }
        await sendFile(req, res, file, name);
        return;
      }
      // The page that plays a signed output: the same signature as its /outputs/ URL.
      if (url.pathname.startsWith('/watch/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const filePath = `/outputs/${url.pathname.slice('/watch/'.length)}`;
        const exp = url.searchParams.get('exp');
        const sig = url.searchParams.get('sig');
        const target = await runtime.outputTarget(filePath, exp, sig);
        if (!target) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end(refusedLink(url));
          return;
        }
        const name = decodeURIComponent(filePath.split('/').pop() ?? '');
        // The page plays the file from where it is served: this server, or the bucket its link
        // redirects to, which the page must then be allowed to load from.
        const bucket = target.blob && runtime.ws.blobs.remote ? runtime.bucketOrigin : undefined;
        const from = bucket ? `'self' ${bucket}` : "'self'";
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'content-security-policy': `default-src 'none'; media-src ${from}; img-src ${from}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`,
        });
        res.end(
          req.method === 'HEAD'
            ? undefined
            : watchPage({
                name,
                mime: outputMime(name.includes('.') ? name : (target.file ?? target.blob ?? name)),
                fileUrl: `${filePath}?${new URLSearchParams({ exp: exp ?? '', sig: sig ?? '' })}`,
                ...(bucket ? { inline: true } : {}),
                base: runtime.config.publicUrl,
                expiresAt: new Date(Number(exp)),
              }),
        );
        return;
      }
      if (url.pathname.startsWith('/uploads/')) {
        await handleUpload(runtime, req, res, url);
        return;
      }
      if (options.route && (await options.route(req, res, url))) return;
      // The same tools as plain HTTP: POST /v1/<tool>, described at /openapi.json.
      if (rest.handles(url)) {
        await rest.serve(req, res, url, async (request) => {
          const caller = await authenticate(req, res, request, async () => false);
          if (caller && (caller.via === 'script' || caller.via === 'oauth'))
            options.onApp?.(caller.owner, 'rest');
          return caller;
        });
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const request = await toWebRequest(req as IncomingMessage & { method: string; url: string });
      const caller = await authenticate(req, res, request, () => isDiscovery(request));
      if (!caller) return;
      // The account's first-ever connection is handed the welcome by a host that cannot have kept
      // older instructions, so it is the account's one word about its free credits and the first
      // tool result need not say it. A later connection may be a host's cached copy: not counted.
      if (
        options.account &&
        options.firstConnection &&
        (caller.via === 'script' || caller.via === 'oauth') &&
        (await sendsInstructions(request)) &&
        (await options.firstConnection(caller.owner))
      )
        await markWelcomed(runtime, caller.owner);
      if (options.onApp && (caller.via === 'script' || caller.via === 'oauth')) {
        const app = (await appName(request)) ?? userAgentApp(req.headers['user-agent']);
        if (app) options.onApp(caller.owner, app);
      }
      const response = await handler.fetch(request, {
        authInfo: {
          token: 'redacted',
          clientId: caller.owner,
          scopes: [],
          extra: { via: caller.via },
        },
      });
      // The SDK logs why it refused a request but not who sent it: name the app, so a real
      // client failing to connect can be told from a scanner.
      if (response.status === 400 || response.status === 406 || response.status === 415)
        process.stderr.write(
          `mcp: refused ${response.status} from ${req.headers['user-agent'] ?? 'unknown'} (${caller.via})\n`,
        );
      await sendResponse(res, response);
    } catch (error) {
      process.stderr.write(`http: ${(error as Error).stack ?? error}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
  // Uploads run as long as the file takes; each one has its own idle timeout instead.
  server.requestTimeout = 0;
  return server;
}

/** Why a signed link was refused, and how to get one that works. */
function refusedLink(url: URL): string {
  const exp = Number(url.searchParams.get('exp'));
  return exp && exp <= Date.now()
    ? `this link expired at ${new Date(exp).toISOString()}; job.get (for an export) or media.get (for media) gives a fresh one`
    : 'invalid or expired link';
}

const UPLOAD_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'PUT, POST, HEAD, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, content-range, upload-name',
  'access-control-expose-headers': 'upload-offset, upload-complete',
  'access-control-max-age': '86400',
};

/**
 * A signed upload URL: PUT sends the file (whole, or a part with Content-Range), HEAD and GET
 * say how much has arrived. The signature is the credential, so browsers may send it too.
 */
async function handleUpload(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, UPLOAD_CORS).end();
    return;
  }
  // Draining (drain.ts): no bytes are taken; where an upload stands can still be asked.
  if (runtime.drain.active && req.method !== 'GET' && req.method !== 'HEAD') {
    req.resume();
    res
      .writeHead(503, {
        ...UPLOAD_CORS,
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'retry-after': String(DRAIN_RETRY_SECONDS),
        connection: 'close',
      })
      .end(
        JSON.stringify({
          error: drainingError().message,
          retry_after_seconds: DRAIN_RETRY_SECONDS,
        }),
      );
    return;
  }
  const reply = (
    status: number,
    body: Record<string, unknown>,
    state?: { received: number; complete: boolean },
  ) => {
    res.writeHead(status, {
      ...UPLOAD_CORS,
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(state
        ? { 'upload-offset': String(state.received), 'upload-complete': String(state.complete) }
        : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };
  // The same link with /parts, /parts/{n} or /complete after it sends the file as numbered
  // parts, several at once (where files are kept in an object store).
  const sub = /^(\/uploads\/[^/]+\/[^/]+)\/(parts(?:\/(\d{1,5}))?|complete)$/.exec(url.pathname);
  const target = await runtime.uploads.verify(
    sub ? (sub[1] as string) : url.pathname,
    url.searchParams.get('exp'),
    url.searchParams.get('sig'),
  );
  if (!target) {
    req.resume();
    reply(403, { error: 'invalid or expired upload link; call media.upload for a new one' });
    return;
  }
  if (sub) {
    await handleUploadParts(runtime, req, target, sub[2] as string, sub[3], url, reply);
    return;
  }
  // Opened in a browser, the link is a page to drop the file on.
  if (req.method === 'GET' && /\btext\/html\b/.test(req.headers.accept ?? '')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(uploadPage(target.id));
    return;
  }
  if (req.method === 'HEAD' || req.method === 'GET') {
    const state = await runtime.uploads.state(target.owner, target.id);
    if (!state) reply(404, { error: 'no such upload, or it was imported or expired' });
    else reply(200, { ...state }, state);
    return;
  }
  if (req.method !== 'PUT') {
    req.resume();
    res.writeHead(405, { ...UPLOAD_CORS, allow: 'PUT, HEAD, GET, OPTIONS' }).end();
    return;
  }
  const header = req.headers['content-range'];
  const range = header ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header) : null;
  if (header && !range) {
    req.resume();
    reply(400, { error: 'Content-Range must be bytes <first>-<last>/<total or *>' });
    return;
  }
  const lengthHeader = req.headers['content-length'];
  const length = lengthHeader === undefined ? null : Number(lengthHeader);
  if (range && length !== null && Number(range[2]) - Number(range[1]) + 1 !== length) {
    req.resume();
    reply(400, { error: 'Content-Range does not match Content-Length' });
    return;
  }
  // A stalled client lets go of its upload after two idle minutes; it can resume later.
  req.setTimeout(120_000, () => req.destroy());
  try {
    const sentName = req.headers['upload-name'];
    let name: string | undefined;
    try {
      name = typeof sentName === 'string' ? decodeURIComponent(sentName) : undefined;
    } catch {
      name = undefined;
    }
    const state = await runtime.uploads.receive(target.owner, target.id, req, {
      ...(name ? { name } : {}),
      length,
      range: range
        ? { start: Number(range[1]), total: range[3] === '*' ? null : Number(range[3]) }
        : null,
    });
    reply(
      200,
      {
        ...state,
        next: state.complete
          ? `media.import {source: {upload_id: "${state.upload_id}"}}`
          : 'send the rest: PUT with Content-Range from the bytes received',
      },
      state,
    );
  } catch (error) {
    if (!(error instanceof UploadRefused)) throw error;
    // Stop reading a body the upload won't take; close the connection rather than drain it.
    if (!req.complete) res.setHeader('connection', 'close');
    const state =
      error.received === undefined
        ? undefined
        : { received: error.received, complete: error.complete };
    reply(
      error.status,
      { error: error.message, ...(state ? { received: state.received } : {}) },
      state,
    );
  }
}

/**
 * A file sent as numbered parts of one size, several at once: GET …/parts?bytes=<size> sets it
 * up and lists the parts that are in, PUT …/parts/{n} sends one, POST …/complete makes them the
 * file. A server that keeps files on its own disk answers 404, and the sender uses PUT.
 */
async function handleUploadParts(
  runtime: Runtime,
  req: IncomingMessage,
  target: { owner: string; id: string },
  what: string,
  number: string | undefined,
  url: URL,
  reply: (
    status: number,
    body: Record<string, unknown>,
    state?: { received: number; complete: boolean },
  ) => void,
): Promise<void> {
  try {
    if (what === 'complete') {
      req.resume();
      if (req.method !== 'POST') return reply(405, { error: 'POST completes an upload' });
      const done = await runtime.uploads.completeParts(target.owner, target.id);
      if (!done.complete) {
        return reply(
          409,
          { error: 'parts are missing; send them, then complete', ...done },
          { received: done.received, complete: false },
        );
      }
      return reply(
        200,
        { ...done, next: `media.import {source: {upload_id: "${done.upload_id}"}}` },
        done,
      );
    }
    if (number === undefined) {
      req.resume();
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return reply(405, { error: 'GET lists the parts of an upload' });
      }
      const bytes = url.searchParams.get('bytes');
      const total = bytes !== null && /^\d{1,15}$/.test(bytes) ? Number(bytes) : undefined;
      if (bytes !== null && total === undefined) {
        return reply(400, { error: 'bytes must be the size of the file' });
      }
      const sentName = req.headers['upload-name'];
      let name: string | undefined;
      try {
        name = typeof sentName === 'string' ? decodeURIComponent(sentName) : undefined;
      } catch {
        name = undefined;
      }
      const parts = await runtime.uploads.parts(target.owner, target.id, total, name);
      if (!parts) {
        return reply(404, { error: 'this server takes a file whole: PUT it to the upload link' });
      }
      return reply(200, { ...parts }, parts);
    }
    if (req.method !== 'PUT') {
      req.resume();
      return reply(405, { error: 'PUT sends a part' });
    }
    const lengthHeader = req.headers['content-length'];
    req.setTimeout(120_000, () => req.destroy());
    const parts = await runtime.uploads.receivePart(
      target.owner,
      target.id,
      Number(number),
      req,
      lengthHeader === undefined ? null : Number(lengthHeader),
    );
    reply(200, { ...parts, part: Number(number) }, parts);
  } catch (error) {
    if (!(error instanceof UploadRefused)) throw error;
    if (!req.complete) req.resume();
    const state =
      error.received === undefined
        ? undefined
        : { received: error.received, complete: error.complete };
    reply(
      error.status,
      { error: error.message, ...(state ? { received: state.received } : {}) },
      state,
    );
  }
}

/**
 * What the bucket may show in a page rather than hand over as a download: sound, video and
 * pictures that run no script. Anything else (an SVG, HTML, a document) is a download whatever
 * the link asks, so a signed link can never make the bucket's origin serve a page.
 */
const SHOWN_INLINE = /^(?:audio|video)\/|^image\/(?:png|jpeg|gif|webp|avif|bmp|apng)$/;

/** The longest a browser keeps the redirect: never past the end of our own link. */
const REDIRECT_MAX_AGE_S = 600;

/**
 * Answers a checked link to a file in the bucket: GET with a redirect to a short-lived link to
 * the file itself (ranges, seeking and resuming are then the bucket's), HEAD with the file's
 * size and type as this server always has. The file is looked up first, so one that has gone
 * says so here. `expires` is when the link checked ends (ms).
 */
async function sendBlob(
  runtime: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
  blob: string,
  name: string,
  link: { inline: boolean; expires: number },
): Promise<void> {
  const head = await runtime.ws.blobs.head(blob);
  if (!head) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('gone');
    return;
  }
  const type = outputMime(name.includes('.') ? name : blob);
  const shared = {
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range',
  };
  if (req.method === 'HEAD') {
    res
      .writeHead(200, {
        ...shared,
        'content-type': type,
        'content-length': head.bytes,
        'accept-ranges': 'bytes',
        'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
        'cache-control': 'private, max-age=3600',
      })
      .end();
    return;
  }
  const how = link.inline && SHOWN_INLINE.test(type) ? 'inline' : 'attachment';
  const location = await runtime.bucketLink(blob, name, type, how);
  if (!location) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('gone');
    return;
  }
  // Kept by the browser for less time than the bucket's link lasts, and than ours does.
  const left = Math.floor((link.expires - Date.now()) / 1000);
  const maxAge = Math.max(0, Math.min(REDIRECT_MAX_AGE_S, left));
  res.writeHead(302, { ...shared, location, 'cache-control': `private, max-age=${maxAge}` }).end();
}

/** The request's URL as the client addressed it, for web-standard handlers. */
function webUrl(req: IncomingMessage): string {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).toString();
}

/** Writes a web Response to a Node response, streaming its body. */
async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as never);
  // Stop streaming only if the client goes away before the response is done. (The
  // request's own 'close' fires once its body is read, which is too early.)
  res.on('close', () => {
    if (!res.writableFinished) body.destroy();
  });
  body.on('error', () => res.destroy());
  body.pipe(res);
}

/** Streams a file with single-range support, so players can seek. */
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  name = file.split('/').pop() ?? 'output',
): Promise<void> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('gone');
    return;
  }
  const type = outputMime(name.includes('.') ? name : file);
  const headers: Record<string, string | number> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    // The link is the permission, so a page anywhere may read it: the editor view measures the
    // export's sound from its sandbox. No credentials are involved.
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

/** Parses `CUTTINGFLOOR_API_KEYS` ("owner:key,owner2:key2"). */
export function parseApiKeys(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  for (const pair of (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const at = pair.indexOf(':');
    if (at <= 0 || at === pair.length - 1)
      throw new Error('CUTTINGFLOOR_API_KEYS entries must be owner:key');
    const owner = pair.slice(0, at);
    const key = pair.slice(at + 1);
    if (key.length < 24) throw new Error(`API key for ${owner} is too short (24+ characters)`);
    keys.set(key, owner);
  }
  return keys;
}
