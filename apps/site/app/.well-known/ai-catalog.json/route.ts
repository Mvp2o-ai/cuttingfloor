import { createHash } from 'node:crypto';
import { REPO_URL } from '../../../content/facts.ts';
import { abs } from '../../lib/markdown.ts';
import { DESCRIPTION, MCP_ADDRESS } from '../../seo.ts';

// The domain's AI Catalog (ai-catalog.io, the discovery document of MCP Server Cards, SEP-2127):
// where an agent or registry pointed at cuttingfloor.ai finds the MCP server's card, and the
// documents that describe it. The card itself is served by the MCP server at <mcp-url>/server-card.
export const dynamic = 'force-static';

const PUBLISHER = {
  identifier: 'cuttingfloor.ai',
  displayName: 'cuttingfloor',
  identityType: 'dns',
};

const CATALOG = {
  specVersion: '1.0',
  host: {
    displayName: 'cuttingfloor',
    identifier: 'cuttingfloor.ai',
    documentationUrl: abs('/llms.txt'),
    logoUrl: abs('/icon.svg'),
  },
  entries: [
    {
      identifier: 'urn:air:cuttingfloor.ai:mcp:cuttingfloor',
      type: 'application/mcp-server-card+json',
      url: `${MCP_ADDRESS}/server-card`,
      tags: ['video', 'video-editing', 'mcp'],
      publisher: PUBLISHER,
    },
    {
      identifier: 'urn:air:cuttingfloor.ai:docs:llms',
      displayName: 'llms.txt',
      description: `${DESCRIPTION} An index for agents: running it, pricing, keys, connecting, every page.`,
      type: 'text/plain',
      url: abs('/llms.txt'),
      publisher: PUBLISHER,
    },
    {
      identifier: 'urn:air:cuttingfloor.ai:docs:llms-full',
      displayName: 'llms-full.txt',
      description: 'The key pages in full, as Markdown, in one file.',
      type: 'text/plain',
      url: abs('/llms-full.txt'),
      publisher: PUBLISHER,
    },
    {
      identifier: 'urn:air:cuttingfloor.ai:pricing',
      displayName: 'Pricing',
      description: 'Pricing as JSON: credits, packs and each option’s limits.',
      type: 'application/json',
      url: abs('/pricing.json'),
      publisher: PUBLISHER,
    },
    {
      identifier: 'urn:air:cuttingfloor.ai:docs:source',
      displayName: 'Source and docs',
      description: 'The open-source repository: README, self-hosting and the tool reference.',
      type: 'text/html',
      url: REPO_URL,
      publisher: PUBLISHER,
    },
  ],
};

export function GET() {
  const body = `${JSON.stringify(CATALOG, null, 2)}\n`;
  return new Response(body, {
    headers: {
      'content-type': 'application/ai-catalog+json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET',
      'access-control-allow-headers': 'Content-Type, If-None-Match',
      'access-control-expose-headers': 'ETag',
      'cache-control': 'public, max-age=3600',
      etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`,
    },
  });
}
