import { createServer as createHttpServer } from 'node:http';
import { EnvCredentialStore } from '@cuttingfloor/credentials';
import { MemoryJobStore } from '@cuttingfloor/jobs';
import { createServer } from '@cuttingfloor/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';

// Development entry point: stateless Streamable HTTP on loopback, no auth yet.
// Production adds OAuth 2.1 (PRM, CIMD, RFC 8707, RFC 9207), per-tenant stores,
// Postgres jobs and the provider connect pages (plans/spec.md §12.3).
const port = Number(process.env.PORT ?? 8787);
const jobs = new MemoryJobStore();
const credentials = new EnvCredentialStore({});
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createHttpServer(async (req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const server = createServer({ jobs, credentials, owner: () => 'dev' });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(port, '127.0.0.1', () => {
  process.stderr.write(`cuttingfloor hosted (dev) on http://127.0.0.1:${port}/mcp\n`);
});
