import { readFile } from 'node:fs/promises';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { configFromEnv, Runtime } from '@cuttingfloor/server';
import { createHttpServer, parseApiKeys } from './http.ts';

// `cuttingfloor serve`: the long-running HTTP node. Local mode (compose) is one user on
// loopback; hosted mode requires bearer API keys and takes provider keys per tenant.
const config = configFromEnv();
const port = Number(process.env.PORT ?? 8787);
// 0.0.0.0 inside the container; compose publishes it on the host's loopback only.
const host = process.env.HOST ?? '127.0.0.1';

const apiKeys = parseApiKeys(
  process.env.CUTTINGFLOOR_API_KEYS ??
    (await readFile('/run/secrets/cuttingfloor_api_keys', 'utf8').then(
      (s) => s.trim(),
      () => undefined,
    )),
);
if (config.mode === 'hosted' && apiKeys.size === 0) {
  process.stderr.write(
    'Hosted mode needs CUTTINGFLOOR_API_KEYS (owner:key,...) or the cuttingfloor_api_keys secret\n',
  );
  process.exit(1);
}

const runtime = new Runtime(config);
await runtime.start();
// Hosted provider keys are per tenant and never come from this process's environment.
const credentials = new LocalCredentialStore(
  config.mode === 'local' ? process.env : {},
  config.mode === 'local',
);
const server = createHttpServer({
  runtime,
  credentials,
  ...(config.mode === 'hosted' ? { apiKeys } : {}),
});

server.listen(port, host, () => {
  process.stderr.write(
    `cuttingfloor ${config.mode} on http://${host}:${port}/mcp (data ${config.dataDir})\n`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    runtime.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
