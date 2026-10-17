import { readFile } from 'node:fs/promises';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { configFromEnv, Runtime } from '@cuttingfloor/server';
import { createHttpServer, parseApiKeys } from './http.ts';
import { discoverAuthorizationServer, JwtTokenVerifier } from './oauth.ts';

// `cuttingfloor serve`: the long-running HTTP node. Local mode (compose) is one user on
// loopback; hosted mode requires bearer API keys or OAuth and takes provider keys per tenant.
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
const publicUrl = process.env.CUTTINGFLOOR_PUBLIC_URL?.replace(/\/$/, '');
const issuer = process.env.CUTTINGFLOOR_OAUTH_ISSUER;
if (config.mode === 'hosted' && apiKeys.size === 0 && !issuer) {
  process.stderr.write(
    'Hosted mode needs CUTTINGFLOOR_OAUTH_ISSUER, or CUTTINGFLOOR_API_KEYS (owner:key,...) or the cuttingfloor_api_keys secret\n',
  );
  process.exit(1);
}
// Download links are built from it, and it names this server to the authorization server.
if (config.mode === 'hosted' && !publicUrl) {
  process.stderr.write(
    'Hosted mode needs CUTTINGFLOOR_PUBLIC_URL, the https address clients reach this server at (download links and the OAuth resource are built from it)\n',
  );
  process.exit(1);
}
// MCP authorization: this server is the OAuth resource at /mcp; users sign in at the issuer.
const oauth =
  config.mode === 'hosted' && issuer && publicUrl
    ? {
        verifier: new JwtTokenVerifier(
          await discoverAuthorizationServer(issuer).catch((error: Error) => {
            process.stderr.write(`oauth: ${error.message}\n`);
            process.exit(1);
          }),
        ),
        resource: new URL(`${publicUrl}/mcp`),
      }
    : undefined;
// Registration settings change at the authorization server; it caches its metadata five minutes.
if (oauth && issuer)
  setInterval(() => {
    discoverAuthorizationServer(issuer).then(
      (metadata) => oauth.verifier.update(metadata),
      (error: Error) => process.stderr.write(`oauth: ${error.message}\n`),
    );
  }, 300_000).unref();

const runtime = new Runtime(config);
await runtime.start();
// Hosted, the server's own TypeSafe key answers media.analyze look for every account; no other
// provider key comes from this process's environment.
const credentials = new LocalCredentialStore(
  config.mode === 'local' ? process.env : { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY },
  config.mode === 'local',
);
const server = createHttpServer({
  runtime,
  credentials,
  ...(config.mode === 'hosted' ? { apiKeys } : {}),
  ...(oauth ? { oauth } : {}),
});
if (oauth) process.stderr.write(`oauth: sign-in at ${issuer} for ${oauth.resource}\n`);

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
