import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Job } from '@cuttingfloor/jobs';
import { FREE_CREDITS, LOW_CREDITS, PACKS, PLANS } from '@cuttingfloor/plans';
import { type AccountGetResult, CfError, MediaUploadInput } from '@cuttingfloor/schema';
import { listHeld, type MeterEntry, type Runtime, startUpload } from '@cuttingfloor/server';
import type { Access, AccessCheck, Balance } from './access.ts';
import type { Mailer } from './email.ts';
import type { ScriptKeys } from './keys.ts';
import { type ProviderKeys, SAVABLE } from './provider-keys.ts';
import { chargePack, savedCard } from './purchase.ts';

// What happens around an account as it is used, still without a database:
// - WorkOS metadata records the first tool call, the first export (the site's welcome page
//   waits on the first, the funnel counts both), the first export that succeeded (the sign-up
//   sequence's first edit, sequence.ts) and the app the first tool call came from.
// - Email goes out when an account's credits run low and when they run out (for a given plan, at
//   80% and 100% of the month's). An account that turned on automatic top-up instead buys its
//   pack on its saved card when it runs low, once per purchase, and is sent the receipt. The welcome is the sign-up sequence's; this sends it only while the
//   sequence is off. A notice file under the owner's data claims each message once, across
//   servers (`owners/{owner}/notices/{name}.json`, kept 400 days).
// - Stripe's webhook tells the access check credits were bought, so they show at once.
// - An account first used through a client that grants lifetime (Kazi) is tagged lifetime in its
//   WorkOS metadata, with the reason and date (`plan_reason`, `plan_since`), so exactly those
//   accounts can be found and the tag taken off again.

const NOTICE_TTL_MS = 400 * 24 * 3_600_000;
// How often new accounts are looked at: a fallback welcome arrives within this of signing up.
const SWEEP_MS = 10 * 60_000;

export interface LifecycleOptions {
  runtime: Runtime;
  access: AccessCheck;
  workosKey: string;
  stripeKey: string;
  accountUrl: string;
  mailer?: Mailer;
  /**
   * Sends the plain welcome while the sign-up sequence (sequence.ts) is off: the site's page that
   * walks a new account through connecting, and this server's address as agents connect to it.
   */
  welcome?: { url: string; serverUrl: string };
  /** Signs Stripe's webhook calls (whsec_…). Without it the webhook is refused. */
  stripeWebhookSecret?: string;
  /**
   * Lets the site act for a signed-in account: read its plan and credits (`GET /account/usage`,
   * as account.get gives them) and its files
   * (`GET /account/media`), start an upload (`POST /account/uploads`), and list, make and revoke
   * its script keys (`/account/keys`).
   */
  accountKey?: string;
  /** The accounts' script keys, made and revoked on the account page. */
  keys?: ScriptKeys;
  /** Provider keys the account saves on its page (its sync. labs key), kept encrypted in WorkOS. */
  providerKeys?: ProviderKeys;
  /** OAuth client ids whose users get lifetime, each with the name its reason records. */
  lifetimeClients?: Map<string, string>;
}

/** What to do with an account used through a lifetime client. */
export function lifetimeFor(
  metadata: Record<string, string>,
  access: Access,
): 'give' | 'tagged' | 'paying' {
  if (metadata.plan) return 'tagged';
  // An account that bought credits keeps them; giving it a plan would set them aside.
  if (access.allowed && access.plan !== 'free') return 'paying';
  return 'give';
}

export class Lifecycle {
  #o: LifecycleOptions;
  #seen = new Set<string>();
  #apps = new Set<string>();
  #lifetime = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: LifecycleOptions) {
    this.#o = options;
  }

  /** Meters into usage email and first-export records; sweeps new accounts. */
  start(): void {
    this.#o.runtime.onMetered((job, entry) => {
      void this.#metered(job, entry).catch((error: Error) =>
        process.stderr.write(`lifecycle: ${job.owner}: ${error.message}\n`),
      );
    });
    const sweep = () =>
      void this.sweep().catch((error: Error) =>
        process.stderr.write(`lifecycle: sweep: ${error.message}\n`),
      );
    sweep();
    this.#timer = setInterval(sweep, SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /**
   * A signed-in owner made a tool call: records the first one on their account, and first gives
   * lifetime to an account used through a client that grants it, so this call already counts it.
   */
  async called(owner: string, client?: string): Promise<void> {
    const via = client ? this.#o.lifetimeClients?.get(client) : undefined;
    if (via && !this.#lifetime.has(owner)) {
      try {
        await this.#giveLifetime(owner, via);
        this.#lifetime.add(owner);
      } catch (error) {
        process.stderr.write(`lifecycle: ${owner}: lifetime: ${(error as Error).message}\n`);
      }
    }
    if (this.#seen.has(owner)) return;
    this.#seen.add(owner);
    void this.#markOnce(owner, 'first_call_at').catch((error: Error) => {
      this.#seen.delete(owner);
      process.stderr.write(`lifecycle: ${owner}: ${error.message}\n`);
    });
  }

  /**
   * A signed-in owner's request came from an app: records the first app's name on their account
   * (`first_client`), so the funnel can tell which agents people use.
   */
  usedFrom(owner: string, app: string | undefined): void {
    const name = clientName(app);
    if (!name || this.#apps.has(owner)) return;
    this.#apps.add(owner);
    void this.#markOnce(owner, 'first_client', name).catch((error: Error) => {
      this.#apps.delete(owner);
      process.stderr.write(`lifecycle: ${owner}: ${error.message}\n`);
    });
  }

  async #metered(job: Job, entry: MeterEntry): Promise<void> {
    const owner = job.owner;
    if (!isUser(owner)) return;
    this.#o.access.addSeconds(owner, entry.seconds);
    if (job.tool === 'export.video') {
      await this.#markOnce(owner, 'first_export_at');
      if (job.status === 'completed' && !job.result?.isError)
        await this.#markOnce(owner, 'first_edit_at');
    }
    const access = await this.#o.access.get(owner);
    if (!access.allowed) return;
    const balance = await this.#o.access.balance(owner, access);
    if (balance.left === null) return;
    if (balance.renews === null) await this.#runningLow(owner, access, balance);
    else await this.#monthUsed(owner, access, balance);
  }

  /** A balance below LOW_CREDITS: tops up on its own when turned on, else says so by email. */
  async #runningLow(owner: string, access: Access & { allowed: true }, balance: Balance) {
    const left = balance.left ?? 0;
    if (left >= LOW_CREDITS) return;
    if (access.refill && access.customer && (await this.#topUp(owner, access, balance))) return;
    const out = left <= 0;
    await this.#notify(owner, warningName(balance, out ? 'out' : 'low'), {
      to: access.email,
      subject: out ? 'Your credits are used up' : `You have ${left} credits left`,
      lines: [
        out
          ? 'Your agent has used all its credits.'
          : `Your agent has ${left} credits left. A credit is one minute of a job running (an export, an import, a transcript).`,
        out
          ? 'Editing still works, and so do previews. New jobs (exports, imports, motion graphics, voiceovers) wait until you top up.'
          : 'At zero, new jobs wait. Editing and previews keep working.',
        `Top up on your account page: packs start at $${PACKS[0]?.price} for ${PACKS[0]?.credits} credits, and they never expire. Turn on automatic top-up there and this won't stop you again.`,
      ],
      action: { label: 'Top up', url: `${this.#o.accountUrl}#credits` },
    });
  }

  /**
   * Buys the account's top-up pack on its saved card, claimed once per purchase so servers and
   * retries never charge twice. True when the credits are in.
   */
  async #topUp(owner: string, access: Access & { allowed: true }, balance: Balance) {
    const pack = access.refill;
    const customer = access.customer;
    if (!pack || !customer) return false;
    const ws = this.#o.runtime.ws;
    const claim = ws.ownerDir(owner, 'notices', `top-up-${balance.purchases}.json`);
    if (!(await ws.writeJson(claim, { at: new Date().toISOString() }, { exclusive: true })))
      return true;
    const card = await savedCard(this.#o.stripeKey, customer).catch(() => undefined);
    const paid = card
      ? await chargePack(this.#o.stripeKey, {
          customer,
          owner,
          pack,
          card,
          key: `${owner}:top-up:${balance.purchases}`,
          reason: 'automatic top-up',
        })
      : { ok: false as const, message: 'no card is saved' };
    this.#o.access.forget(owner);
    if (paid.ok) {
      await this.#notify(owner, `top-up-${paid.id}`, {
        to: access.email,
        subject: `Topped up: ${pack.credits} credits`,
        lines: [
          `Your credits were running low, so we bought ${pack.credits} credits for $${pack.price} on your ${card?.brand} ending ${card?.last4}, as you asked.`,
          'Your agent keeps working. Change or turn off automatic top-up on your account page.',
        ],
        action: { label: 'Open your account', url: `${this.#o.accountUrl}#credits` },
      });
      return true;
    }
    process.stderr.write(`lifecycle: ${owner}: top-up: ${paid.message}\n`);
    await this.#notify(owner, `top-up-failed-${balance.purchases}`, {
      to: access.email,
      subject: 'We couldn’t top up your credits',
      lines: [
        `Your credits are running low, and the automatic top-up of ${pack.credits} credits for $${pack.price} didn’t go through (${paid.message}).`,
        'Top up on your account page to keep your agent working; it saves the card for next time.',
      ],
      action: { label: 'Top up', url: `${this.#o.accountUrl}#credits` },
    });
    return false;
  }

  /** A given plan's month: email at 80% and 100% of its credits. */
  async #monthUsed(owner: string, access: Access & { allowed: true }, balance: Balance) {
    const included = balance.per_month;
    if (!included) return;
    const share = balance.used / included;
    const renews = day(balance.renews ?? balance.since);
    if (share >= 1)
      await this.#notify(owner, warningName(balance, 'out'), {
        to: access.email,
        subject: 'This month’s credits are used up',
        lines: [
          `Your agent has used all ${included} credits for this month.`,
          'Editing still works, and so do previews. New jobs (exports, imports, motion graphics, voiceovers) wait until the credits renew.',
          `They renew on ${renews}.`,
        ],
        action: { label: 'Open your account', url: this.#o.accountUrl },
      });
    else if (share >= 0.8)
      await this.#notify(owner, warningName(balance, 'low'), {
        to: access.email,
        subject: `You've used ${Math.floor(share * 100)}% of this month’s credits`,
        lines: [
          `Your agent has used ${balance.used} of ${included} credits this month; they renew on ${renews}.`,
          'At the limit, new jobs wait. Editing and previews keep working.',
        ],
        action: { label: 'See your credits', url: this.#o.accountUrl },
      });
  }

  /** The signed-in account's plan and credits, for account.get and the account page. */
  async account(owner: string): Promise<AccountGetResult> {
    const access = await this.#o.access.require(owner);
    const balance = await this.#o.access.balance(owner, access);
    const plan = PLANS[access.plan];
    const bought = plan.credits.kind === 'balance';
    const card =
      bought && access.customer
        ? await savedCard(this.#o.stripeKey, access.customer).catch(() => undefined)
        : undefined;
    const ws = this.#o.runtime.ws;
    const sent = async (kind: 'low' | 'out') =>
      Boolean(
        await ws.readJson(ws.ownerDir(owner, 'notices', `${warningName(balance, kind)}.json`)),
      );
    const warnings: AccountGetResult['warnings'] = [];
    if (balance.left !== null) {
      const lowAt = bought ? LOW_CREDITS : Math.round((balance.per_month ?? 0) * 0.2 * 10) / 10;
      warnings.push({ at_credits: lowAt, kind: 'low', emailed: await sent('low') });
      warnings.push({ at_credits: 0, kind: 'out', emailed: await sent('out') });
    }
    const l = plan.limits;
    return {
      plan: access.plan,
      plan_name: plan.name,
      credits: {
        left: balance.left,
        used: balance.used,
        free: balance.free,
        bought: balance.bought,
        per_month: balance.per_month,
        renews: balance.renews,
      },
      warnings,
      top_up: bought
        ? {
            automatic: Boolean(access.refill),
            pack: access.refill
              ? { price_usd: access.refill.price, credits: access.refill.credits }
              : null,
            below: LOW_CREDITS,
            card_saved: Boolean(card),
          }
        : null,
      packs: bought ? PACKS.map((p) => ({ price_usd: p.price, credits: p.credits })) : [],
      limits: {
        jobs: l.jobs,
        export_short_side: l.shortSide,
        judgments_per_day: l.judgmentsPerDay,
        storage_gb: l.storageGb,
      },
      account_url: this.#o.accountUrl,
    };
  }

  /**
   * Email for accounts made in the last day (a welcome, while the sign-up sequence is off), and
   * the TTL sweep of notice files.
   */
  async sweep(now = Date.now()): Promise<void> {
    const ws = this.#o.runtime.ws;
    for (const key of await ws.owners()) {
      await ws.sweep(ws.path('owners', key, 'notices'), NOTICE_TTL_MS);
    }
    await this.#o.keys?.sweep();
    const welcome = this.#o.welcome;
    if (!this.#o.mailer || !welcome) return;
    const oldest = now - 86_400_000;
    for await (const user of this.#users(oldest)) {
      const created = Date.parse(user.created_at);
      if (now - created < 86_400_000) {
        await this.#notify(user.id, 'welcome', {
          to: user.email,
          subject: 'Welcome to cuttingfloor',
          lines: [
            'Your agent can edit video now. Add cuttingfloor to it once: the welcome page has the step for Claude, Claude Code, Cursor, Codex, ChatGPT and Kazi.',
            `The address is ${welcome.serverUrl}/mcp. Your agent opens a sign-in the first time; use this same account.`,
            `Then ask it for an edit, for example: "Import my video and cut out the pauses and ums." You start with ${FREE_CREDITS} free credits: a credit is one minute of our servers working (an export, a transcript), and editing itself is free. No card, no time limit.`,
          ],
          action: { label: 'Connect your agent', url: welcome.url },
        });
      }
    }
  }

  /** WorkOS users, newest first, back to `oldest`. */
  async *#users(oldest: number): AsyncGenerator<{ id: string; email: string; created_at: string }> {
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({
        limit: '100',
        order: 'desc',
        ...(after ? { after } : {}),
      });
      const list = (await this.#workos(`/user_management/users?${query}`)) as {
        data?: { id: string; email: string; created_at: string }[];
        list_metadata?: { after?: string | null };
      };
      for (const user of list.data ?? []) {
        if (Date.parse(user.created_at) < oldest) return;
        yield user;
      }
      after = list.list_metadata?.after ?? undefined;
      if (!after) return;
    }
  }

  /** Sends a message once per owner and name; false when it was sent before. */
  async #notify(
    owner: string,
    name: string,
    message: Omit<Parameters<Mailer['send']>[0], 'key'>,
  ): Promise<boolean> {
    const { mailer } = this.#o;
    if (!mailer || !message.to) return false;
    const ws = this.#o.runtime.ws;
    const file = ws.ownerDir(owner, 'notices', `${name}.json`);
    if (!(await ws.writeJson(file, { at: new Date().toISOString() }, { exclusive: true })))
      return false;
    try {
      await mailer.send({ ...message, key: `${owner}:${name}` });
      return true;
    } catch (error) {
      // Unclaimed again, so the next chance sends it.
      await ws.remove(file).catch(() => undefined);
      throw error;
    }
  }

  /** Tags an account lifetime, recording why and when, unless it has a plan given or bought. */
  async #giveLifetime(owner: string, via: string): Promise<void> {
    if (!isUser(owner)) return;
    const path = `/user_management/users/${encodeURIComponent(owner)}`;
    const user = await this.#workos(path);
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    const decision = lifetimeFor(metadata, await this.#o.access.get(owner));
    if (decision === 'paying')
      process.stderr.write(`lifecycle: ${owner} used ${via} while on a paid plan; left on it\n`);
    if (decision !== 'give') return;
    await this.#workos(path, {
      method: 'PUT',
      body: {
        metadata: {
          ...metadata,
          plan: 'lifetime',
          plan_reason: `via ${via}`,
          plan_since: new Date().toISOString(),
        },
      },
    });
    this.#o.access.forget(owner);
    process.stderr.write(`lifecycle: ${owner}: lifetime via ${via}\n`);
  }

  /** Sets a field in the user's WorkOS metadata (the time, by default), if it isn't set yet. */
  async #markOnce(owner: string, field: string, value = new Date().toISOString()): Promise<void> {
    if (!isUser(owner)) return;
    const path = `/user_management/users/${encodeURIComponent(owner)}`;
    const user = await this.#workos(path);
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    if (metadata[field]) return;
    await this.#workos(path, {
      method: 'PUT',
      body: { metadata: { ...metadata, [field]: value } },
    });
  }

  /**
   * The routes the site and Stripe call: `POST /stripe/webhook`, `GET /account/usage`,
   * `GET /account/media`, `POST /account/uploads`, and `GET`/`POST /account/keys` and
   * `POST /account/keys/revoke`. Returns false for any other path.
   */
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/stripe/webhook' && req.method === 'POST') {
      await this.#webhook(req, res);
      return true;
    }
    if (url.pathname === '/account/usage' && req.method === 'GET') {
      await this.#usageRoute(req, res, url);
      return true;
    }
    if (url.pathname === '/account/media' && req.method === 'GET') {
      await this.#mediaRoute(req, res, url);
      return true;
    }
    if (url.pathname === '/account/uploads' && req.method === 'POST') {
      await this.#uploadRoute(req, res);
      return true;
    }
    if (
      url.pathname === '/account/provider-keys' ||
      url.pathname === '/account/provider-keys/remove'
    ) {
      await this.#providerKeysRoute(req, res, url);
      return true;
    }
    if (url.pathname === '/account/keys' || url.pathname === '/account/keys/revoke') {
      await this.#keysRoute(req, res, url);
      return true;
    }
    return false;
  }

  /**
   * The account's script keys. GET ?user= lists them; POST {user, label} makes one and is the
   * only answer that carries the key; POST /revoke {user, key_id} stops one at once.
   */
  async #keysRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    const keys = this.#o.keys;
    if (!keys) return json(res, 503, { error: 'script keys are off on this server' });
    if (req.method === 'GET' && url.pathname === '/account/keys') {
      const owner = url.searchParams.get('user') ?? '';
      if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
      return json(res, 200, { keys: await keys.list(owner) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    let body: { user?: unknown; label?: unknown; key_id?: unknown };
    try {
      body = JSON.parse(await readBody(req, 16 * 1024));
    } catch {
      return json(res, 400, { error: 'body must be JSON' });
    }
    const owner = typeof body.user === 'string' ? body.user : '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    if (url.pathname === '/account/keys/revoke') {
      const revoked = await keys.revoke(owner, typeof body.key_id === 'string' ? body.key_id : '');
      return json(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: 'no such key' });
    }
    try {
      const made = await keys.create(owner, typeof body.label === 'string' ? body.label : '');
      return json(res, 200, made);
    } catch (error) {
      return json(res, 409, { error: (error as Error).message });
    }
  }

  /**
   * The account's own provider keys. GET ?user= lists which are saved, by their last four
   * characters; POST {user, provider, key} saves one (the key is never sent back); POST /remove
   * {user, provider} takes it off.
   */
  async #providerKeysRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    const keys = this.#o.providerKeys;
    if (!keys) return json(res, 503, { error: 'saved keys are off on this server' });
    try {
      if (req.method === 'GET') {
        const owner = url.searchParams.get('user') ?? '';
        if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
        return json(res, 200, { keys: await keys.list(owner), providers: SAVABLE });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
      let body: { user?: unknown; provider?: unknown; key?: unknown };
      try {
        body = JSON.parse(await readBody(req, 16 * 1024));
      } catch {
        return json(res, 400, { error: 'body must be JSON' });
      }
      const owner = typeof body.user === 'string' ? body.user : '';
      if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
      const provider = SAVABLE.find((p) => p === body.provider);
      if (!provider)
        return json(res, 400, { error: `provider must be one of ${SAVABLE.join(', ')}` });
      if (url.pathname === '/account/provider-keys/remove') {
        await keys.remove(owner, provider);
        return json(res, 200, { removed: true });
      }
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key || key.length > 500 || /\s/.test(key))
        return json(res, 400, { error: 'Paste the key itself: one line, no spaces' });
      await keys.save(owner, provider, key);
      return json(res, 200, { saved: true, provider, ends: key.slice(-4) });
    } catch {
      return json(res, 503, { error: 'keys could not be read or saved just now' });
    }
  }

  /** Whether the call comes from the site, carrying the account key. */
  #fromSite(req: IncomingMessage): boolean {
    const key = this.#o.accountKey;
    const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    return Boolean(key) && same(given, key ?? '');
  }

  /** The account's media, uploads not imported yet and storage, as media.list gives them. */
  async #mediaRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    const owner = url.searchParams.get('user') ?? '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    try {
      const access = await this.#o.access.get(owner);
      if (!access.allowed) return json(res, 200, { allowed: false, reason: access.reason });
      const limits = await this.#o.access.limits(owner);
      return json(res, 200, { allowed: true, ...(await listHeld(this.#o.runtime, owner, limits)) });
    } catch {
      return json(res, 503, { error: 'account check unavailable' });
    }
  }

  /** Starts an upload for the account: a signed URL the browser sends the file to directly. */
  async #uploadRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    let body: { user?: unknown; name?: unknown; bytes?: unknown };
    try {
      body = JSON.parse(await readBody(req, 16 * 1024));
    } catch {
      return json(res, 400, { error: 'body must be JSON: {user, name, bytes}' });
    }
    const owner = typeof body.user === 'string' ? body.user : '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    const file = MediaUploadInput.safeParse({ name: body.name, bytes: body.bytes });
    if (!file.success) return json(res, 400, { error: 'name must be a file name; bytes its size' });
    try {
      const limits = await this.#o.access.limits(owner);
      const upload = await startUpload(
        this.#o.runtime,
        owner,
        file.data.name,
        file.data.bytes,
        limits,
        'account_page',
      );
      return json(res, 200, upload);
    } catch (error) {
      if (error instanceof CfError && error.code !== 'service_unavailable')
        return json(
          res,
          error.code === 'quota_exceeded' || error.code === 'bad_request' ? 413 : 403,
          {
            error: error.message,
            code: error.code,
            ...(error.hint ? { hint: error.hint } : {}),
          },
        );
      return json(res, 503, { error: 'account check unavailable' });
    }
  }

  async #usageRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    const owner = url.searchParams.get('user') ?? '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    // fresh=1 after the account changed on the site (credits bought, top-up set): read it again.
    if (url.searchParams.get('fresh') === '1') this.#o.access.forget(owner);
    try {
      const access = await this.#o.access.get(owner);
      if (!access.allowed) return json(res, 200, { allowed: false, reason: access.reason });
      return json(res, 200, { allowed: true, account: await this.account(owner) });
    } catch {
      return json(res, 503, { error: 'account check unavailable' });
    }
  }

  async #webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, 1024 * 1024);
    const secret = this.#o.stripeWebhookSecret;
    if (!secret || !verifyStripe(body, String(req.headers['stripe-signature'] ?? ''), secret))
      return json(res, 400, { error: 'bad signature' });
    const event = JSON.parse(body) as {
      id: string;
      type: string;
      data: { object: Record<string, unknown> };
    };
    const object = event.data.object;
    const customerId = typeof object.customer === 'string' ? object.customer : undefined;
    if (!customerId) return json(res, 200, { ignored: true });
    try {
      // The Stripe account is shared with other products; only cuttingfloor's customers count.
      const customer = await this.#stripe(`/v1/customers/${encodeURIComponent(customerId)}`);
      const meta = (customer.metadata ?? {}) as Record<string, string>;
      const owner = meta.workos_user_id;
      if (meta.app !== 'cuttingfloor' || !owner) return json(res, 200, { ignored: true });
      this.#o.access.forget(owner);
      return json(res, 200, { received: true });
    } catch (error) {
      process.stderr.write(`stripe webhook ${event.id}: ${(error as Error).message}\n`);
      // Stripe retries a failed delivery.
      return json(res, 500, { error: 'not handled' });
    }
  }

  async #workos(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await fetch(`https://api.workos.com${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.#o.workosKey}`,
        'content-type': 'application/json',
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`WorkOS ${path.split('?')[0]}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async #stripe(path: string) {
    const res = await fetch(`https://api.stripe.com${path}`, {
      headers: { authorization: `Bearer ${this.#o.stripeKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Stripe ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** Checks a Stripe-Signature header (v1, five minutes' tolerance). */
export function verifyStripe(body: string, header: string, secret: string, now = Date.now()) {
  const parts = header.split(',').map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !signatures.length || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return signatures.some((s) => same(s, expected));
}

/** An app's MCP clientInfo name, made safe to keep: printable, trimmed, at most 80 characters. */
export function clientName(app: string | undefined): string | undefined {
  const name = app
    ?.replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 80);
  return name || undefined;
}

/**
 * The notice a credit warning is claimed under: once per balance (its free and bought credits, so
 * a top-up arms it again), or once per month of a given plan.
 */
function warningName(balance: Balance, kind: 'low' | 'out'): string {
  return balance.renews === null
    ? `credits-${balance.free + balance.bought}-${kind}`
    : `minutes-${balance.since.slice(0, 10)}-${kind === 'low' ? 80 : 100}`;
}

const isUser = (owner: string) => /^user_[0-9A-Z]{26}$/.test(owner);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
