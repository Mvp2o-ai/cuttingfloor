import type { CredentialStore } from '@cuttingfloor/credentials';
import type { JobStore } from '@cuttingfloor/jobs';
import { McpServer } from '@modelcontextprotocol/server';
import { registerHealth } from './health.ts';
import { registerTasks } from './tasks.ts';

export const SERVER_NAME = 'cuttingfloor';
export const SERVER_VERSION = '0.0.0';

export interface ServerDeps {
  jobs: JobStore;
  credentials: CredentialStore;
  /** Identity that owns jobs, keys and projects: `local` on stdio, the token's `sub` hosted. */
  owner: () => string;
}

/** Builds one MCP server instance. Transports (stdio, HTTP) live in apps/. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTasks(server, deps);
  registerHealth(server, deps);
  // Tool groups register here as they're built: project, media, timeline/clip, transition,
  // filter, title/caption/marker, audio, create.*, render.*, export.*, job.*, qa.check.
  return server;
}
