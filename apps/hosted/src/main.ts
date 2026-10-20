import { readFile } from 'node:fs/promises';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { configFromEnv, Runtime } from '@cuttingfloor/server';
import { AccessCheck } from './access.ts';
import { Mailer } from './email.ts';
import { createHttpServer, parseApiKeys } from './http.ts';
import { Lifecycle } from './lifecycle.ts';
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

// Trial and plan checks for signed-in users: WorkOS holds the account, Stripe the subscription.
// Signing in without them would let everyone in, so hosted mode won't start that way.
const workosKey = process.env.WORKOS_API_KEY;
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (oauth && (!workosKey || !stripeKey)) {
  process.stderr.write(
    "OAuth sign-in needs WORKOS_API_KEY and STRIPE_SECRET_KEY, to check each account's trial and plan\n",
  );
  process.exit(1);
}
const accountUrl = process.env.CUTTINGFLOOR_ACCOUNT_URL ?? 'https://cuttingfloor.ai/account';
const access =
  oauth && workosKey && stripeKey
    ? new AccessCheck({ workosKey, stripeKey, accountUrl, ws: runtime.ws })
    : undefined;
const lifecycle =
  access && workosKey && stripeKey
    ? new Lifecycle({
        runtime,
        access,
        workosKey,
        stripeKey,
        accountUrl,
        welcomeUrl: new URL('/welcome', accountUrl).toString(),
        serverUrl: publicUrl ?? '',
        ...(process.env.RESEND_API_KEY ? { mailer: new Mailer(process.env.RESEND_API_KEY) } : {}),
        ...(process.env.STRIPE_WEBHOOK_SECRET
          ? { stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
          : {}),
        ...(process.env.CUTTINGFLOOR_ACCOUNT_KEY
          ? { accountKey: process.env.CUTTINGFLOOR_ACCOUNT_KEY }
          : {}),
      })
    : undefined;
if (lifecycle) {
  lifecycle.start();
  for (const [name, set] of [
    ['RESEND_API_KEY', process.env.RESEND_API_KEY],
    ['STRIPE_WEBHOOK_SECRET', process.env.STRIPE_WEBHOOK_SECRET],
    ['CUTTINGFLOOR_ACCOUNT_KEY', process.env.CUTTINGFLOOR_ACCOUNT_KEY],
  ] as const)
    if (!set) process.stderr.write(`lifecycle: ${name} unset; that part is off\n`);
}
// Hosted, the server's own TypeSafe key answers judge.ask and media.analyze look for every
// account; no other provider key comes from this process's environment.
const credentials = new LocalCredentialStore(
  config.mode === 'local' ? process.env : { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY },
  config.mode === 'local',
);
const server = createHttpServer({
  runtime,
  credentials,
  ...(config.mode === 'hosted' ? { apiKeys } : {}),
  ...(oauth ? { oauth } : {}),
  ...(access
    ? {
        access: async (owner: string) => void (await access.require(owner)),
        limits: (owner: string) => access.limits(owner),
      }
    : {}),
  ...(lifecycle
    ? {
        onCall: (owner: string) => lifecycle.called(owner),
        route: (req, res, url) => lifecycle.route(req, res, url),
      }
    : {}),
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
    lifecycle?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
