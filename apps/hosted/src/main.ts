import { createServer as createHttpServer } from 'node:http';
import { EnvCredentialStore } from '@cuttingfloor/credentials';
import { MemoryJobStore } from '@cuttingfloor/jobs';
import { createServer } from '@cuttingfloor/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';

// Streamable HTTP entry point (`cuttingfloor serve`), stateless per request. No auth yet.
// Production adds OAuth 2.1 (PRM, CIMD, RFC 8707, RFC 9207), per-tenant stores,
// Postgres jobs and the provider connect pages (plans/spec.md §12.3).
const port = Number(process.env.PORT ?? 8787);
// 0.0.0.0 inside the container; compose publishes it on the host's loopback only.
const host = process.env.HOST ?? '127.0.0.1';
const jobs = new MemoryJobStore();
// Local mode (compose) is single-user: keys come from the container's environment.
// Hosted keys are per tenant (plans/spec.md §12.3) and never come from the process env.
const local = process.env.CUTTINGFLOOR_MODE === 'local';
const credentials = new EnvCredentialStore(local ? process.env : {});
const owner = local ? 'local' : 'dev';
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createHttpServer(async (req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const server = createServer({ jobs, credentials, owner: () => owner });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(port, host, () => {
  process.stderr.write(`cuttingfloor on http://${host}:${port}/mcp\n`);
});
