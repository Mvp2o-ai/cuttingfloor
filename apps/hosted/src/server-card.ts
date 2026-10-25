import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVER_NAME, SERVER_VERSION } from '@cuttingfloor/server';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

const SITE = 'https://cuttingfloor.ai';
/** The stateless protocol /mcp speaks first; the SDK exports only the 2025 versions it falls back to. */
const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'];
export const CARD_TYPE = 'application/mcp-server-card+json';

/**
 * The Server Card (MCP Server Cards extension, SEP-2127): public metadata a client reads before
 * it connects or signs in. It names the server and where to connect; tools stay with tools/list.
 */
export function serverCard(publicUrl: string): Record<string, unknown> {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'ai.cuttingfloor/cuttingfloor',
    version: SERVER_VERSION,
    title: SERVER_NAME,
    description:
      'Headless video editor: cut, caption, mix, analyze and render video with granular tools.',
    websiteUrl: SITE,
    repository: { url: 'https://github.com/Mvp2o-ai/cuttingfloor', source: 'github' },
    icons: [{ src: `${SITE}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }],
    remotes: [
      {
        type: 'streamable-http',
        url: `${publicUrl}/mcp`,
        supportedProtocolVersions: [...MODERN_PROTOCOL_VERSIONS, ...SUPPORTED_PROTOCOL_VERSIONS],
      },
    ],
  };
}

/** The AI Catalog (`/.well-known/ai-catalog.json`) that points at the card. */
export function aiCatalog(publicUrl: string): Record<string, unknown> {
  return {
    specVersion: '1.0',
    entries: [
      {
        identifier: 'urn:air:cuttingfloor.ai:mcp:cuttingfloor',
        type: CARD_TYPE,
        url: `${publicUrl}/mcp/server-card`,
      },
    ],
  };
}

const DISCOVERY_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET',
  'access-control-allow-headers': 'content-type, if-none-match',
  'access-control-expose-headers': 'etag',
  'access-control-max-age': '86400',
};

/** Serves a public discovery document: CORS for browsers, an hour's caching, ETag revalidation. */
export function sendDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
  type: string,
): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, DISCOVERY_CORS).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...DISCOVERY_CORS, allow: 'GET, HEAD, OPTIONS' }).end();
    return;
  }
  const json = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(json).digest('base64url').slice(0, 22)}"`;
  const headers = { ...DISCOVERY_CORS, 'cache-control': 'public, max-age=3600', etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': type });
  res.end(req.method === 'HEAD' ? undefined : json);
}
