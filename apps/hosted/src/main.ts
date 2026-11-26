import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MongoRecords } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { LOW_CREDITS } from '@cuttingfloor/plans';
import { configFromEnv, Runtime } from '@cuttingfloor/server';
import { AccessCheck } from './access.ts';
import { ADMIN_KEYS, AdminApi } from './admin-api.ts';
import { AppleCredits } from './apple.ts';
import { AppsSeen } from './apps-seen.ts';
import { recordDownload } from './downloads.ts';
import { ResendProvider } from './email.ts';
import { recordSignInStep } from './funnel.ts';
import { createHttpServer, parseApiKeys } from './http.ts';
import { Kazi } from './kazi.ts';
import { ScriptKeys } from './keys.ts';
import { FileLedger, type Ledger, MongoLedger } from './ledger.ts';
import { Lifecycle } from './lifecycle.ts';
import { discoverAuthorizationServer, JwtTokenVerifier } from './oauth.ts';
import { ProviderKeys } from './provider-keys.ts';
import { Rights } from './rights.ts';
import { Sequence, WorkosSubscribers } from './sequence.ts';
import { accountMailer, STANDBY_NOTICE, startBackground } from './standby.ts';

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

// Beside the server in production, on a copy of its data: it answers requests and does nothing
// to the data by the clock, and sends no email.
const standby = Boolean(config.standby);
if (standby) process.stderr.write(`${STANDBY_NOTICE}\n`);

const runtime = new Runtime(config);
await runtime.start();

// Plan checks for signed-in users: WorkOS holds the account, the credit ledger the balance (in
// the record database; files for a single server), Stripe the packs. Signing in without them would
// let everyone in, so hosted mode won't start that way.
const workosKey = process.env.WORKOS_API_KEY;
const stripeKey = process.env.STRIPE_SECRET_KEY;
if (oauth && (!workosKey || !stripeKey)) {
  process.stderr.write(
    "OAuth sign-in needs WORKOS_API_KEY and STRIPE_SECRET_KEY, to check each account's plan and credits\n",
  );
  process.exit(1);
}
const accountUrl = process.env.CUTTINGFLOOR_ACCOUNT_URL ?? 'https://cuttingfloor.ai/account';
const records = runtime.ws.records;
const ledger: Ledger =
  records instanceof MongoRecords
    ? new MongoLedger({ db: () => records.database(), low: LOW_CREDITS })
    : new FileLedger({ records, low: LOW_CREDITS });
const access =
  oauth && workosKey && stripeKey
    ? new AccessCheck({ workosKey, stripeKey, ledger, accountUrl, ws: runtime.ws })
    : undefined;
// Kazi's partner API, for the hand-off into Kazi after a sign-up here (optional). The variables
// keep the names they had when Kazi also kept our credits: the same key opens its partner API.
const kazi =
  process.env.KAZI_CREDITS_URL && process.env.KAZI_CREDITS_KEY
    ? new Kazi(process.env.KAZI_CREDITS_URL, process.env.KAZI_CREDITS_KEY)
    : undefined;
// The Cutting Floor AI app's credits and App Store purchases.
const apple = access ? new AppleCredits({ ledger, access }) : undefined;
// Keys users make on the account page for scripts: only where accounts are checked.
const scriptKeys = access ? new ScriptKeys(runtime.ws) : undefined;
// The admin API's keys and cuttingfloor's own rights table (who is an admin).
const adminKeys = access ? new ScriptKeys(runtime.ws, ADMIN_KEYS) : undefined;
const rights = access ? new Rights(runtime.ws) : undefined;
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
/** The apps each account's requests came from, for the admin API. */
const apps = new AppsSeen(runtime.ws);
const mailer = accountMailer(process.env, standby);
const lifecycle =
  access && workosKey && stripeKey
    ? new Lifecycle({
        runtime,
        access,
        ledger,
        ...(kazi ? { kazi } : {}),
        ...(apple ? { apple } : {}),
        workosKey,
        stripeKey,
        accountUrl,
        standby,
        ...(sequenceOn
          ? {}
          : {
              welcome: {
                url: new URL('/welcome', accountUrl).toString(),
                serverUrl: publicUrl ?? '',
              },
            }),
        ...(scriptKeys ? { keys: scriptKeys } : {}),
        ...(adminKeys && rights ? { adminKeys, rights } : {}),
        ...(mailer ? { mailer } : {}),
        ...(process.env.STRIPE_WEBHOOK_SECRET
          ? { stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
          : {}),
        ...(process.env.CUTTINGFLOOR_ACCOUNT_KEY
          ? { accountKey: process.env.CUTTINGFLOOR_ACCOUNT_KEY }
          : {}),
        ...(partners.size ? { partners } : {}),
        ...(providerKeys ? { providerKeys } : {}),
      })
    : undefined;
// The download gate: pictures leave with the watermark until their owner removes it,
// spent on the credit ledger. Only with plans and credits to go by (the hosted service).
if (access && lifecycle) {
  runtime.useGate({
    exempt: (owner) => access.exempt(owner),
    balance: async (owner) => (await access.balance(owner)).left,
    spend: (owner, ref, credits, tool) => lifecycle.spendRelease(owner, ref, credits, tool),
    // The QR code on a review copy's cards: the site's page where the owner signs in to release it.
    releasePage: (id) => new URL(`/r/${id}`, accountUrl).href,
  });
}
// A shared sound with no name given is credited to its sharer's first name.
if (lifecycle && runtime.sharing) runtime.sharing.author = (owner) => lifecycle.soundAuthor(owner);
if (lifecycle) {
  for (const [name, set] of [
    ['RESEND_API_KEY', process.env.RESEND_API_KEY],
    ['STRIPE_WEBHOOK_SECRET', process.env.STRIPE_WEBHOOK_SECRET],
    ['CUTTINGFLOOR_ACCOUNT_KEY', process.env.CUTTINGFLOOR_ACCOUNT_KEY],
    ['CUTTINGFLOOR_KEY_SECRET', process.env.CUTTINGFLOOR_KEY_SECRET],
  ] as const)
    if (!set) process.stderr.write(`lifecycle: ${name} unset; that part is off\n`);
}
/** The sign-up sequence, when everything it needs is set. Never asked for on standby. */
const makeSequence = (): Sequence | undefined => {
  if (!(lifecycle && access && workosKey && publicUrl)) return undefined;
  const env = sequenceEnv as Record<keyof typeof sequenceEnv, string>;
  if (unset.length) {
    process.stderr.write(`sequence: off; set ${unset.join(', ')}\n`);
    return undefined;
  }
  try {
    return new Sequence({
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
      credits: async (owner) => {
        const balance = await access.balance(owner);
        return { left: balance.left, perMonth: balance.per_month, bought: balance.bought };
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
};
const sequence = startBackground({ standby, lifecycle, sequence: makeSequence });
if (sequence && !process.env.RESEND_WEBHOOK_SECRET)
  process.stderr.write(
    'sequence: RESEND_WEBHOOK_SECRET unset; bounces and complaints are not heard\n',
  );
const adminApi =
  lifecycle && access && adminKeys && rights && publicUrl
    ? new AdminApi({
        runtime,
        lifecycle,
        access,
        apps,
        keys: adminKeys,
        rights,
        publicUrl,
        accountUrl,
        ...(process.env.CUTTINGFLOOR_ACCOUNT_KEY
          ? { accountKey: process.env.CUTTINGFLOOR_ACCOUNT_KEY }
          : {}),
      })
    : undefined;
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
        limits: (owner: string, options?: { buy?: boolean }) => access.limits(owner, options),
      }
    : {}),
  ...(lifecycle
    ? {
        onCall: (owner: string) => lifecycle.called(owner),
        onApp: (owner: string, app: string) => {
          lifecycle.usedFrom(owner, app);
          apps.seen(owner, app);
        },
        account: (owner: string) => lifecycle.account(owner),
        ...(apple ? { credits: apple } : {}),
        activeBefore: (owner: string) => lifecycle.activeBefore(owner),
        route: async (req, res, url) =>
          (await adminApi?.route(req, res, url)) ||
          (await sequence?.route(req, res, url)) ||
          lifecycle.route(req, res, url),
      }
    : {}),
  ...(config.mode === 'hosted'
    ? {
        onDownload: (seen) =>
          void recordDownload(runtime.ws, seen).catch((error: Error) =>
            process.stderr.write(`downloads: ${error.message}\n`),
          ),
      }
    : {}),
  accountUrl,
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
    `cuttingfloor ${config.mode} on http://${host}:${port}/mcp (data ${config.dataDir}${config.records ? `, records in MongoDB database ${config.records.db}` : ''})\n`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    lifecycle?.stop();
    sequence?.stop();
    runtime.stop();
    // The record store closes after the requests in flight have ended (they still read and
    // write it), handing its leases back so another server takes the periodic work over.
    // Whatever the database does, the process is gone a second after the 5 s cutoff.
    const end = () =>
      void runtime.close(1000).then(
        () => process.exit(0),
        () => process.exit(0),
      );
    server.close(end);
    setTimeout(end, 5000).unref();
  });
}
