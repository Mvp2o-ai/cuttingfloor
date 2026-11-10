import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { configFromEnv, Runtime } from '@cuttingfloor/server';
import { AccessCheck } from './access.ts';
import { Mailer, ResendProvider } from './email.ts';
import { recordSignInStep } from './funnel.ts';
import { createHttpServer, parseApiKeys } from './http.ts';
import { ScriptKeys } from './keys.ts';
import { Lifecycle } from './lifecycle.ts';
import { discoverAuthorizationServer, JwtTokenVerifier } from './oauth.ts';
import { ProviderKeys } from './provider-keys.ts';
import { Sequence, WorkosSubscribers } from './sequence.ts';

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

// Plan checks for signed-in users: WorkOS holds the account, Stripe the credits bought.
// Signing in without them would let everyone in, so hosted mode won't start that way.
const workosKey = process.env.WORKOS_API_KEY;
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (oauth && (!workosKey || !stripeKey)) {
  process.stderr.write(
    "OAuth sign-in needs WORKOS_API_KEY and STRIPE_SECRET_KEY, to check each account's plan\n",
  );
  process.exit(1);
}
const accountUrl = process.env.CUTTINGFLOOR_ACCOUNT_URL ?? 'https://cuttingfloor.ai/account';
const access =
  oauth && workosKey && stripeKey
    ? new AccessCheck({ workosKey, stripeKey, accountUrl, ws: runtime.ws })
    : undefined;
// Keys users make on the account page for scripts: only where accounts are checked.
const scriptKeys = access ? new ScriptKeys(runtime.ws) : undefined;
// OAuth clients whose users get lifetime: `<client_id>=<name>`, comma-separated (Kazi's two).
const lifetimeClients = new Map(
  (process.env.CUTTINGFLOOR_LIFETIME_CLIENTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf('=');
      return [entry.slice(0, at), entry.slice(at + 1)] as [string, string];
    })
    .filter(([id, name]) => id && name),
);
// Partners that get keys for their users: `<name>=<sha256 of its secret>`, comma-separated.
const partners = new Map(
  (process.env.CUTTINGFLOOR_PARTNER_KEYS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf('=');
      return [entry.slice(at + 1).toLowerCase(), entry.slice(0, at)] as [string, string];
    })
    .filter(([hash, name]) => /^[0-9a-f]{64}$/.test(hash) && name),
);
// Provider keys users save on the account page, encrypted with this server-only secret.
const keySecret = process.env.CUTTINGFLOOR_KEY_SECRET;
const providerKeys =
  access && workosKey && keySecret ? new ProviderKeys(workosKey, keySecret) : undefined;
// The sign-up sequence: a welcome, then one follow-up chosen by whether a first edit is done.
// Everything about it comes from the environment; it is off until all of it is set, and the
// lifecycle's plain welcome goes out instead meanwhile.
const sequenceEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  CUTTINGFLOOR_EMAIL_FROM: process.env.CUTTINGFLOOR_EMAIL_FROM,
  CUTTINGFLOOR_EMAIL_REPLY_TO: process.env.CUTTINGFLOOR_EMAIL_REPLY_TO,
  CUTTINGFLOOR_EMAIL_SIGNER: process.env.CUTTINGFLOOR_EMAIL_SIGNER,
  CUTTINGFLOOR_UNSUBSCRIBE_SECRET: process.env.CUTTINGFLOOR_UNSUBSCRIBE_SECRET,
};
const followUpHours = Number(process.env.CUTTINGFLOOR_FOLLOW_UP_AFTER_HOURS ?? 72);
const creditsHours = Number(process.env.CUTTINGFLOOR_CREDITS_AFTER_HOURS ?? 168);
const pollSeconds = Number(process.env.CUTTINGFLOOR_SEQUENCE_POLL_SECONDS ?? 30);
if (!(followUpHours > 0) || !(creditsHours > 0) || !(pollSeconds > 0)) {
  process.stderr.write(
    'CUTTINGFLOOR_FOLLOW_UP_AFTER_HOURS, CUTTINGFLOOR_CREDITS_AFTER_HOURS and CUTTINGFLOOR_SEQUENCE_POLL_SECONDS must be positive numbers\n',
  );
  process.exit(1);
}
const unset = Object.entries(sequenceEnv)
  .filter(([, value]) => !value)
  .map(([name]) => name);
const sequenceOn = !unset.length && Boolean(publicUrl);
const lifecycle =
  access && workosKey && stripeKey
    ? new Lifecycle({
        runtime,
        access,
        workosKey,
        stripeKey,
        accountUrl,
        ...(sequenceOn
          ? {}
          : {
              welcome: {
                url: new URL('/welcome', accountUrl).toString(),
                serverUrl: publicUrl ?? '',
              },
            }),
        ...(scriptKeys ? { keys: scriptKeys } : {}),
        ...(process.env.RESEND_API_KEY
          ? {
              // Account email comes from the same person as the sign-up sequence, when one is set.
              mailer: new Mailer(process.env.RESEND_API_KEY, {
                ...(process.env.CUTTINGFLOOR_EMAIL_FROM
                  ? { from: process.env.CUTTINGFLOOR_EMAIL_FROM }
                  : {}),
                ...(process.env.CUTTINGFLOOR_EMAIL_REPLY_TO
                  ? { replyTo: process.env.CUTTINGFLOOR_EMAIL_REPLY_TO }
                  : {}),
              }),
            }
          : {}),
        ...(process.env.STRIPE_WEBHOOK_SECRET
          ? { stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
          : {}),
        ...(process.env.CUTTINGFLOOR_ACCOUNT_KEY
          ? { accountKey: process.env.CUTTINGFLOOR_ACCOUNT_KEY }
          : {}),
        ...(lifetimeClients.size ? { lifetimeClients } : {}),
        ...(partners.size ? { partners } : {}),
        ...(providerKeys ? { providerKeys } : {}),
      })
    : undefined;
if (lifecycle) {
  lifecycle.start();
  for (const [name, set] of [
    ['RESEND_API_KEY', process.env.RESEND_API_KEY],
    ['STRIPE_WEBHOOK_SECRET', process.env.STRIPE_WEBHOOK_SECRET],
    ['CUTTINGFLOOR_ACCOUNT_KEY', process.env.CUTTINGFLOOR_ACCOUNT_KEY],
    ['CUTTINGFLOOR_KEY_SECRET', process.env.CUTTINGFLOOR_KEY_SECRET],
  ] as const)
    if (!set) process.stderr.write(`lifecycle: ${name} unset; that part is off\n`);
}
let sequence: Sequence | undefined;
if (lifecycle && access && workosKey && publicUrl) {
  const env = sequenceEnv as Record<keyof typeof sequenceEnv, string>;
  if (unset.length) process.stderr.write(`sequence: off; set ${unset.join(', ')}\n`);
  else {
    try {
      sequence = new Sequence({
        ws: runtime.ws,
        subscribers: new WorkosSubscribers(workosKey),
        provider: new ResendProvider(env.RESEND_API_KEY),
        from: env.CUTTINGFLOOR_EMAIL_FROM,
        replyTo: env.CUTTINGFLOOR_EMAIL_REPLY_TO,
        signer: env.CUTTINGFLOOR_EMAIL_SIGNER,
        publicUrl,
        unsubscribeSecret: env.CUTTINGFLOOR_UNSUBSCRIBE_SECRET,
        followUpAfterMs: followUpHours * 3_600_000,
        creditsAfterMs: creditsHours * 3_600_000,
        creditsLeft: async (owner) => {
          const balance = await access.balance(owner);
          // A plan given by the month (lifetime, enterprise) renews; only a balance waits.
          return balance.renews === null ? balance.left : null;
        },
        pollMs: pollSeconds * 1000,
        templatesDir:
          process.env.CUTTINGFLOOR_EMAIL_TEMPLATES ??
          fileURLToPath(new URL('../email/', import.meta.url)),
        ...(process.env.RESEND_WEBHOOK_SECRET
          ? { eventsSecret: process.env.RESEND_WEBHOOK_SECRET }
          : {}),
      });
    } catch (error) {
      process.stderr.write(`sequence: ${(error as Error).message}\n`);
      process.exit(1);
    }
    sequence.start();
    if (!process.env.RESEND_WEBHOOK_SECRET)
      process.stderr.write(
        'sequence: RESEND_WEBHOOK_SECRET unset; bounces and complaints are not heard\n',
      );
  }
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
  ...(scriptKeys ? { scriptKeys } : {}),
  ...(oauth ? { oauth } : {}),
  ...(providerKeys ? { savedKeys: providerKeys } : {}),
  ...(access
    ? {
        access: async (owner: string) => void (await access.require(owner)),
        limits: (owner: string) => access.limits(owner),
      }
    : {}),
  ...(lifecycle
    ? {
        onCall: (owner: string, client?: string) => lifecycle.called(owner, client),
        onApp: (owner: string, app: string) => lifecycle.usedFrom(owner, app),
        account: (owner: string) => lifecycle.account(owner),
        route: async (req, res, url) =>
          (await sequence?.route(req, res, url)) || lifecycle.route(req, res, url),
      }
    : {}),
  ...(process.env.CUTTINGFLOOR_OPENAI_CHALLENGE
    ? { openaiChallenge: process.env.CUTTINGFLOOR_OPENAI_CHALLENGE.trim() }
    : {}),
  ...(oauth
    ? {
        onSignInStep: (step, userAgent) =>
          void recordSignInStep(runtime.ws, step, userAgent).catch((error: Error) =>
            process.stderr.write(`funnel: ${error.message}\n`),
          ),
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
    sequence?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
