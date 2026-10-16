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
import { createServer, type Runtime } from '@cuttingfloor/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

export interface HttpOptions {
  runtime: Runtime;
  credentials: CredentialStore;
  /**
   * Hosted mode: bearer API keys, each mapped to the owner it acts as. Local mode passes none and
   * the server only answers on loopback host names.
   */
  apiKeys?: Map<string, string>;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The HTTP face: Streamable HTTP MCP at /mcp (2026-07-28, with stateless 2025 fallback),
 * signed output downloads at /outputs/…, and /healthz.
 */
export function createHttpServer(options: HttpOptions): Server {
  const { runtime, credentials } = options;
  const handler = createMcpHandler(
    (ctx) => {
      const owner = ctx.authInfo?.clientId ?? 'local';
      return createServer({ runtime, credentials, owner: () => owner });
    },
    { onerror: (error) => process.stderr.write(`mcp: ${error.message}\n`) },
  );
  const hashedKeys = [...(options.apiKeys ?? new Map()).entries()].map(([key, owner]) => ({
    digest: createHash('sha256').update(key).digest(),
    owner,
  }));

  return createNodeServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        return;
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
        await sendFile(req, res, file);
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      let owner = 'local';
      if (hashedKeys.length) {
        const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        const digest = token ? createHash('sha256').update(token).digest() : undefined;
        const match = digest && hashedKeys.find((k) => timingSafeEqual(k.digest, digest));
        if (!match) {
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
        owner = match.owner;
      } else {
        // Local mode: refuse DNS-rebinding and cross-site browser requests.
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        const origin = req.headers.origin;
        if (!LOCAL_HOSTS.has(host) || (origin && !LOCAL_HOSTS.has(new URL(origin).hostname))) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host');
          return;
        }
      }
      const request = await toWebRequest(req as IncomingMessage & { method: string; url: string });
      const response = await handler.fetch(request, {
        authInfo: { token: 'redacted', clientId: owner, scopes: [] },
      });
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
    } catch (error) {
      process.stderr.write(`http: ${(error as Error).stack ?? error}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
}

/** Streams a file with single-range support, so players can seek. */
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('gone');
    return;
  }
  const type = file.endsWith('.mp4')
    ? 'video/mp4'
    : file.endsWith('.mov')
      ? 'video/quicktime'
      : 'application/octet-stream';
  const name = file.split('/').pop() ?? 'output';
  const headers: Record<string, string | number> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    'cache-control': 'private, max-age=3600',
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
