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
import type { CredentialStore } from '@cuttingfloor/credentials';
import { createServer, outputMime, type Runtime, UploadRefused } from '@cuttingfloor/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
  oauthMetadataResponse,
  requireBearerAuth,
} from '@modelcontextprotocol/server';
import type { JwtTokenVerifier } from './oauth.ts';
import { uploadPage } from './upload-page.ts';

export interface HttpOptions {
  runtime: Runtime;
  credentials: CredentialStore;
  /**
   * Hosted mode: bearer API keys, each mapped to the owner it acts as. Local mode passes none and
   * the server only answers on loopback host names.
   */
  apiKeys?: Map<string, string>;
  /**
   * Hosted mode: MCP authorization (2026-07-28) with this server as the OAuth resource `resource`
   * (its /mcp URL) and tokens from the verifier's authorization server, alongside any API keys.
   */
  oauth?: { verifier: JwtTokenVerifier; resource: URL };
  /**
   * Hosted: whether a signed-in owner may work (trial, plan); throws a CfError when not. Applies
   * to OAuth sign-ins only: API keys are for maintenance and are never gated.
   */
  access?: (owner: string) => Promise<void>;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The HTTP face: Streamable HTTP MCP at /mcp (2026-07-28, with stateless 2025 fallback),
 * signed output downloads at /outputs/…, signed uploads at /uploads/…, and /healthz.
 */
export function createHttpServer(options: HttpOptions): Server {
  const { runtime, credentials, oauth } = options;
  const handler = createMcpHandler(
    (ctx) => {
      const owner = ctx.authInfo?.clientId ?? 'local';
      const gate = ctx.authInfo?.extra?.via === 'oauth' ? options.access : undefined;
      return createServer({
        runtime,
        credentials,
        owner: () => owner,
        ...(gate ? { access: () => gate(owner) } : {}),
      });
    },
    { onerror: (error) => process.stderr.write(`mcp: ${error.message}\n`) },
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

  const server = createNodeServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
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
          await sendResponse(res, metadata);
          return;
        }
      }
      if (url.pathname.startsWith('/outputs/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = await runtime.verifyOutput(
          url.pathname,
          url.searchParams.get('exp'),
          url.searchParams.get('sig'),
        );
        if (!file) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('invalid or expired link');
          return;
        }
        const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        await sendFile(req, res, file, name);
        return;
      }
      if (url.pathname.startsWith('/uploads/')) {
        await handleUpload(runtime, req, res, url);
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      let owner = 'local';
      let via = 'local';
      const request = await toWebRequest(req as IncomingMessage & { method: string; url: string });
      if (hashedKeys.length || requireToken) {
        const keyOwner = apiKeyOwner(req);
        if (keyOwner) {
          owner = keyOwner;
          via = 'key';
        } else if (requireToken) {
          const auth = await requireToken(request);
          if (auth instanceof Response) {
            await sendResponse(res, auth);
            return;
          }
          owner = String(auth.extra?.sub);
          via = 'oauth';
        } else {
          res
            .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
            .end(
              JSON.stringify({
                error: 'invalid_token',
                error_description: 'Send Authorization: Bearer <api key>',
              }),
            );
          return;
        }
      } else {
        // Local mode: refuse DNS-rebinding and cross-site browser requests.
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        const origin = req.headers.origin;
        if (!LOCAL_HOSTS.has(host) || (origin && !LOCAL_HOSTS.has(new URL(origin).hostname))) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host');
          return;
        }
      }
      const response = await handler.fetch(request, {
        authInfo: { token: 'redacted', clientId: owner, scopes: [], extra: { via } },
      });
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

const UPLOAD_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'PUT, HEAD, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, content-range',
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
  const target = await runtime.uploads.verify(
    url.pathname,
    url.searchParams.get('exp'),
    url.searchParams.get('sig'),
  );
  if (!target) {
    req.resume();
    reply(403, { error: 'invalid or expired upload link; call media.upload for a new one' });
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
    const state = await runtime.uploads.receive(target.owner, target.id, req, {
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
