import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PLANS, TRIAL_DAYS } from '@cuttingfloor/plans';
import { CfError, MediaUploadInput } from '@cuttingfloor/schema';
import { listHeld, type MeterEntry, type Runtime, startUpload } from '@cuttingfloor/server';
import type { Access, AccessCheck } from './access.ts';
import type { Mailer } from './email.ts';
import type { ScriptKeys } from './keys.ts';

// What happens around an account as it is used, still without a database:
// - WorkOS metadata records the first tool call and the first export (the site's welcome page
//   waits on the first, the funnel counts both).
// - Email goes out after sign-up, when the trial is about to end and once it has, at 80% and 100% of a period's
//   render minutes, and when a payment fails. A notice file under the owner's data claims each
//   message once, across servers (`owners/{owner}/notices/{name}.json`, kept 400 days).
// - Stripe's webhook tells the access check a subscription changed, so it shows at once.
// - An account first used through a client that grants lifetime (Kazi) is tagged lifetime in its
//   WorkOS metadata, with the reason and date (`plan_reason`, `plan_since`), so exactly those
//   accounts can be found and the tag taken off again.

const NOTICE_TTL_MS = 400 * 24 * 3_600_000;
// How often new accounts and trials are looked at: a welcome arrives within this of signing up.
const SWEEP_MS = 10 * 60_000;

export interface LifecycleOptions {
  runtime: Runtime;
  access: AccessCheck;
  workosKey: string;
  stripeKey: string;
  accountUrl: string;
  /** The site's page that walks a new account through connecting its agent. */
  welcomeUrl: string;
  /** This server's address, as agents connect to it. */
  serverUrl: string;
  mailer?: Mailer;
  /** Signs Stripe's webhook calls (whsec_…). Without it the webhook is refused. */
  stripeWebhookSecret?: string;
  /**
   * Lets the site act for a signed-in account: read its usage (`GET /account/usage`) and its files
   * (`GET /account/media`), start an upload (`POST /account/uploads`), and list, make and revoke
   * its script keys (`/account/keys`).
   */
  accountKey?: string;
  /** The accounts' script keys, made and revoked on the account page. */
  keys?: ScriptKeys;
  /** OAuth client ids whose users get lifetime, each with the name its reason records. */
  lifetimeClients?: Map<string, string>;
}

/** What to do with an account used through a lifetime client. */
export function lifetimeFor(
  metadata: Record<string, string>,
  access: Access,
): 'give' | 'tagged' | 'paying' {
  if (metadata.plan) return 'tagged';
  // A subscription keeps billing whatever the tag says; that stays the account owner's to end.
  if (access.allowed ? access.plan !== 'trial' : access.reason === 'payment_failed')
    return 'paying';
  return 'give';
}

export class Lifecycle {
  #o: LifecycleOptions;
  #seen = new Set<string>();
  #lifetime = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: LifecycleOptions) {
    this.#o = options;
  }

  /** Meters into usage email and first-export records; sweeps new accounts and trials. */
  start(): void {
    this.#o.runtime.onMetered((job, entry) => {
      void this.#metered(job.owner, job.tool, entry).catch((error: Error) =>
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

  async #metered(owner: string, tool: string, entry: MeterEntry): Promise<void> {
    if (!isUser(owner)) return;
    this.#o.access.addSeconds(owner, entry.seconds);
    if (tool === 'export.video') await this.#markOnce(owner, 'first_export_at');
    const access = await this.#o.access.get(owner);
    if (!access.allowed) return;
    const usage = await this.#o.access.usage(owner, access);
    if (usage.included_minutes === null) return;
    const share = usage.used_minutes / usage.included_minutes;
    const period = usage.period.start.slice(0, 10);
    const renews = day(usage.period.end);
    const trial = usage.plan === 'trial';
    if (share >= 1) {
      await this.#notify(owner, `minutes-${period}-100`, {
        to: access.email,
        subject: trial ? 'Your trial minutes are used up' : 'Your render minutes are used up',
        lines: [
          `Your agent has used all ${usage.included_minutes} render minutes ${trial ? 'in the trial' : 'for this period'}.`,
          'Editing still works, and so do previews. New jobs (exports, imports, motion graphics, voiceovers) wait until the minutes renew.',
          trial
            ? 'Pick a plan to keep going now.'
            : `They renew on ${renews}. For more now, move to a bigger plan.`,
        ],
        action: { label: trial ? 'Pick a plan' : 'Open your account', url: this.#o.accountUrl },
      });
    } else if (share >= 0.8) {
      await this.#notify(owner, `minutes-${period}-80`, {
        to: access.email,
        subject: `You've used ${Math.floor(share * 100)}% of your render minutes`,
        lines: [
          `Your agent has used ${usage.used_minutes} of ${usage.included_minutes} render minutes ${trial ? 'in the trial' : `this period; they renew on ${renews}`}.`,
          'At the limit, new jobs wait. Editing and previews keep working.',
        ],
        action: { label: 'See your usage', url: this.#o.accountUrl },
      });
    }
  }

  /**
   * Email for accounts made in the last day (welcome), whose trial ends within a day, or whose
   * trial ended in the last two; and the TTL sweep of notice files.
   */
  async sweep(now = Date.now()): Promise<void> {
    const ws = this.#o.runtime.ws;
    for (const key of await ws.owners()) {
      await ws.sweep(ws.path('owners', key, 'notices'), NOTICE_TTL_MS);
    }
    await this.#o.keys?.sweep();
    if (!this.#o.mailer) return;
    const oldest = now - (TRIAL_DAYS + 2) * 86_400_000;
    for await (const user of this.#users(oldest)) {
      const created = Date.parse(user.created_at);
      if (now - created < 86_400_000) {
        await this.#notify(user.id, 'welcome', {
          to: user.email,
          subject: 'Welcome to cuttingfloor',
          lines: [
            'Your agent can edit video now. Add cuttingfloor to it once: the welcome page has the step for Claude, Claude Code, Cursor, Codex, ChatGPT and Kazi.',
            `The address is ${this.#o.serverUrl}/mcp. Your agent opens a sign-in the first time; use this same account.`,
            `Then ask it for an edit, for example: "Import my video and cut out the pauses and ums." The trial runs ${TRIAL_DAYS} days with ${PLANS.trial.limits.renderMinutes} render minutes, no card needed.`,
          ],
          action: { label: 'Connect your agent', url: this.#o.welcomeUrl },
        });
        continue;
      }
      if (now - created < (TRIAL_DAYS - 1) * 86_400_000) continue;
      const access = await this.#o.access.get(user.id);
      const ends = created + TRIAL_DAYS * 86_400_000;
      if (access.allowed && access.plan === 'trial' && now >= ends - 86_400_000) {
        await this.#notify(user.id, 'trial-ending', {
          to: user.email,
          subject: 'Your cuttingfloor trial ends tomorrow',
          lines: [
            `Your free trial ends on ${day(new Date(ends).toISOString())}.`,
            'Pick a plan to keep your agent editing. Your media and exports carry over.',
          ],
          action: { label: 'Pick a plan', url: this.#o.accountUrl },
        });
      } else if (!access.allowed && access.reason === 'trial_ended') {
        await this.#notify(user.id, 'trial-over', {
          to: user.email,
          subject: 'Your cuttingfloor trial has ended',
          lines: [
            'Your free trial is over, so your agent’s calls are paused.',
            'Pick a plan and it picks up where it left off. Media and exports are kept for 7 days.',
          ],
          action: { label: 'Pick a plan', url: this.#o.accountUrl },
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

  /** Sets a timestamp in the user's WorkOS metadata, if it isn't set yet. */
  async #markOnce(owner: string, field: string): Promise<void> {
    if (!isUser(owner)) return;
    const path = `/user_management/users/${encodeURIComponent(owner)}`;
    const user = await this.#workos(path);
    const metadata = (user.metadata ?? {}) as Record<string, string>;
    if (metadata[field]) return;
    await this.#workos(path, {
      method: 'PUT',
      body: { metadata: { ...metadata, [field]: new Date().toISOString() } },
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
    try {
      const access = await this.#o.access.get(owner);
      if (!access.allowed) return json(res, 200, { allowed: false, reason: access.reason });
      const usage = await this.#o.access.usage(owner, access);
      return json(res, 200, {
        allowed: true,
        ...usage,
        ...(access.grace_ends ? { grace_ends: access.grace_ends } : {}),
      });
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
      if (event.type === 'invoice.payment_failed') {
        const to = String(object.customer_email ?? customer.email ?? '');
        await this.#notify(owner, `payment-failed-${object.id}-${object.attempt_count ?? 1}`, {
          to,
          subject: 'Your cuttingfloor payment didn’t go through',
          lines: [
            'We couldn’t take your last payment for cuttingfloor. Stripe will try the card again over the next few days.',
            'Your agent keeps working for 7 days. Update the card before then to keep it that way.',
          ],
          action: { label: 'Update your card', url: this.#o.accountUrl },
        });
      }
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
