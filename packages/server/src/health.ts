import { PROVIDER_ENV, type ProviderId } from '@cuttingfloor/credentials';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from './server.ts';

export const HEALTH_URI = 'video://server/health';

/** Server status as a resource: engines, providers configured (never key values). */
export function registerHealth(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'health',
    HEALTH_URI,
    {
      title: 'Server health',
      description: 'Engine versions, worker status and which providers have a key configured.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const owner = deps.owner();
      const providers = Object.fromEntries(
        await Promise.all(
          (Object.keys(PROVIDER_ENV) as ProviderId[]).map(
            async (p) => [p, await deps.credentials.status(owner, p)] as const,
          ),
        ),
      );
      const body = { server: 'cuttingfloor', engines: {}, providers };
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body) }],
      };
    },
  );
}
