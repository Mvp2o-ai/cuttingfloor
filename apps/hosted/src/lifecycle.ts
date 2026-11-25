import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineCollection, TIMELINES } from '@cuttingfloor/core';
import type { Job } from '@cuttingfloor/jobs';
import { FREE_CREDITS, LOW_CREDITS, PACKS, PLANS, packOf } from '@cuttingfloor/plans';
import { type AccountGetResult, CfError, MediaUploadInput } from '@cuttingfloor/schema';
import {
  activateWithDemo,
  billedSeconds,
  DRAIN_RETRY_SECONDS,
  drainingError,
  listHeld,
  type MeterEntry,
  type Runtime,
  startUpload,
} from '@cuttingfloor/server';
import type { Access, AccessCheck, Balance } from './access.ts';
import type { Mailer } from './email.ts';
import { dueFiles, expiryMessage, exportOf, type Going } from './expiry-notices.ts';
import type { ScriptKeys } from './keys.ts';
import type { Ledger, LedgerUsage } from './ledger.ts';
import { oneWriteAtATime } from './metadata.ts';
import { type ProviderKeys, SAVABLE } from './provider-keys.ts';
import { savedCard } from './purchase.ts';
import type { Rights } from './rights.ts';
import { forgetRecipient } from './sequence.ts';
import { jsonBody, share } from './sound-routes.ts';

// What happens around an account as it is used, still without a database:
// - WorkOS metadata records the first signed-in request (`first_call_at`: connecting counts; the
//   site's welcome page waits on it), the first tool call that ran (`first_tool_at`), the first
//   export, the first export that succeeded (the sign-up sequence's first edit, sequence.ts) and
//   the app the first request came from, and the latest day a tool call ran (`last_used_at`,
//   written at most once a day). Writes go one at a time per user (metadata.ts).
// - Each job that ends is spent on Kazi's credit ledger (access.ts), once: a marker file
//   (`owners/{owner}/ledger-spent/{job_id}.json`) says it was taken, and the sweep spends any job
//   a server missed. Given plans are counted from the meter instead.
// - Email goes out when the ledger says a spend took the balance low or to zero (for a given plan,
//   at 80% and 100% of the month's), and with what the ledger's automatic top-up did there, when
//   the account turned it on (`POST /account/top-up`). The welcome is the sign-up sequence's;
//   this sends it only while the sequence is off. A notice file under the owner's data claims
//   each message once, across servers (`owners/{owner}/notices/{name}.json`, kept 400 days).
// - Once a day from 15:00 UTC, an account with files going in about 3 days or within a day gets
//   one email naming them (expiry-notices.ts), unless it turned these off on its account page
//   (`POST /account/notifications`, kept as `expiry_emails: off` in its WorkOS metadata).
// - Stripe's webhook tells the access check credits were bought, so they show at once.
// - Lifetime is not given for using a client, or for being a Kazi member: only the `plan` tag gives
//   it (access.ts).
// - A partner whose users never sign in here (the Cutting Floor AI app, through one-mcp) gets a
//   script key for each of them (`POST /partner/keys`). The account is the one with that email,
//   made when there is none; one the partner made (`plan_reason: made by <partner>`, with no plan)
//   gets no welcome email from us. The partner's
//   user id is kept with the key and in `partners/{name}/{sha256(sub)}.json`, so a user id never
//   moves to another email or account.
// - The same partner deletes its user's account here when the person deletes theirs there
//   (`DELETE /partner/users`): the login is shared, so it is the account with that email (or the
//   one tied to the partner's user id), however it was made. Everything kept for it goes: its
//   folder (timelines, media, jobs, outputs, uploads, meter, call log, notices, ledger link), its
//   script keys, partner links, cached frames of its timelines, its lines in the email log, its
//   address's suppression, and last its WorkOS user, so a retry still finds what a failure left.
//   The credit ledger is the partner's to delete; Stripe keeps its payments.

const NOTICE_TTL_MS = 400 * 24 * 3_600_000;
// A release spend's marker, kept until what it crossed has been emailed and a while after.
const SPENT_TTL_MS = 60 * 24 * 3_600_000;
// How often new accounts are looked at: a fallback welcome arrives within this of signing up.
const SWEEP_MS = 10 * 60_000;
/** The task a sign-up through the Kazi demo is activated with: the demo's own. */
const KAZI_DEMO_TASK = 'Kazi live demo: give the Big Buck Bunny ending a happier ending';
// The hour (UTC) the day's file reminders go: afternoon in Europe, morning in the Americas.
const EXPIRY_HOUR_UTC = 15;

export interface LifecycleOptions {
  runtime: Runtime;
  access: AccessCheck;
  /** Kazi's credit ledger, where jobs on an account without a given plan are spent. */
  ledger: Ledger;
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
  /** Admin keys and the rights table (admin-api.ts): both go when an account is deleted. */
  adminKeys?: ScriptKeys;
  rights?: Rights;
  /** Provider keys the account saves on its page (its sync. labs key), kept encrypted in WorkOS. */
  providerKeys?: ProviderKeys;
  /**
   * Partners that get script keys for their users (`POST /partner/keys`), each by the SHA-256 of
   * its secret, with its name.
   */
  partners?: Map<string, string>;
  /**
   * A standby server (CUTTINGFLOOR_STANDBY=1) on a copy of production's data: nothing it does
   * may cost anyone money, message a person or change what production shares with it. Jobs run
   * unmetered (no ledger spend, no usage report, no automatic top-up, no notice markers), no
   * WorkOS metadata is written (first-use markers, last used), and the routes that charge, delete
   * an account or take Stripe's events answer 503. Sign-in and reads work as ever.
   */
  standby?: boolean;
}

/**
 * When accounts began activating with credits.claim (the release that refuses an unclaimed
 * account's calls): an account that ran a tool before then was already active, claim or not.
 */
export const ACTIVATION_FROM = Date.parse('2026-11-23T01:27:36Z');

/** How long a partner's user id stays tied to its account after its last key. */
const PARTNER_LINK_TTL_MS = 400 * 24 * 3_600_000;
/** The plan reason on an account a partner made, so we never send it our own welcome. */
const MADE_BY = 'made by ';

/** Whether a partner made this account (its users hear from the partner, not from us). */
export function madeByPartner(metadata: Record<string, string> | undefined): boolean {
  return Boolean(metadata?.plan_reason?.startsWith(MADE_BY));
}

export class Lifecycle {
  #o: LifecycleOptions;
  #seen = new Set<string>();
  #apps = new Set<string>();
  #tools = new Set<string>();
  /** Whether each owner was active before activation; the answer never changes. */
  #activeBefore = new Map<string, boolean>();
  /** The UTC day each owner's `last_used_at` was last written by this server. */
  #usedOn = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  /** The UTC day whose file reminders this server has sent. */
  #expiryDay = '';

  constructor(options: LifecycleOptions) {
    this.#o = options;
  }

  /**
   * Meters into usage email and first-export records; sweeps new accounts. Without `sweep` it
   * only hears this server's own calls and jobs: nothing runs by the clock (a standby server).
   */
  start(options: { sweep?: boolean } = {}): void {
    this.#o.runtime.onToolCall((owner) => this.#toolCalled(owner));
    this.#o.runtime.onMetered((owner, entry, job) => {
      void this.#metered(owner, entry, job).catch((error: Error) =>
        process.stderr.write(`lifecycle: ${owner}: ${error.message}\n`),
      );
    });
    if (options.sweep === false) return;
    // One server's turn among those sharing the record store: the others would only look
    // through the same accounts and find every notice already sent.
    const sweep = () =>
      void this.#o.runtime.ws.records
        .leader('lifecycle')
        .then((mine) => (mine ? this.sweep() : undefined))
        .catch((error: Error) => process.stderr.write(`lifecycle: sweep: ${error.message}\n`));
    sweep();
    this.#timer = setInterval(sweep, SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /**
   * A signed-in owner's request reached the server (any request: connecting counts): records the
   * first one on their account (`first_call_at`), which the welcome page waits on.
   */
  async called(owner: string): Promise<void> {
    if (this.#seen.has(owner)) return;
    this.#seen.add(owner);
    void this.#markOnce(owner, 'first_call_at').catch((error: Error) => {
      this.#seen.delete(owner);
      process.stderr.write(`lifecycle: ${owner}: ${error.message}\n`);
    });
  }

  /** An owner's tool call ran (not just a sign-in or a tool list): records the first one. */
  #toolCalled(owner: string): void {
    if (!isUser(owner)) return;
    this.#lastUsed(owner);
    if (this.#tools.has(owner)) return;
    this.#tools.add(owner);
    void this.#markOnce(owner, 'first_tool_at').catch((error: Error) => {
      this.#tools.delete(owner);
      process.stderr.write(`lifecycle: ${owner}: ${error.message}\n`);
    });
  }

  /** Records the day of the owner's latest tool call, at most once a day. */
  #lastUsed(owner: string): void {
    if (this.#o.standby) return;
    const today = new Date().toISOString().slice(0, 10);
    if (this.#usedOn.get(owner) === today) return;
    this.#usedOn.set(owner, today);
    const path = `/user_management/users/${encodeURIComponent(owner)}`;
    void oneWriteAtATime(owner, async () => {
      const user = await this.#workos(path);
      const metadata = (user.metadata ?? {}) as Record<string, string>;
      if (metadata.last_used_at?.slice(0, 10) === today) return;
      await this.#workos(path, {
        method: 'PUT',
        body: { metadata: { ...metadata, last_used_at: new Date().toISOString() } },
      });
    }).catch((error: Error) => {
      this.#usedOn.delete(owner);
      process.stderr.write(`lifecycle: ${owner}: last used: ${error.message}\n`);
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

  async #metered(owner: string, entry: MeterEntry, job?: Job): Promise<void> {
    if (!isUser(owner) || this.#o.standby) return;
    // Jobs spend nothing (making is free); the meter still counts them, for analytics.
    this.#o.access.addSeconds(owner, billedSeconds(entry));
    if (job?.tool === 'export.video') {
      await this.#markOnce(owner, 'first_export_at');
      if (job.status === 'completed' && !job.result?.isError)
        await this.#markOnce(owner, 'first_edit_at');
    }
  }

  /**
   * Spends the credits for removing a watermark on the ledger under `ref` (the ledger takes a ref once, however
   * often it is sent), then emails what the spend crossed: running low, out, or what the ledger's
   * automatic top-up did there. A marker keeps the ledger's answer until the email is sent, so a
   * server that stops in between sends it on the sweep. Fails closed: a ledger that can't be
   * reached refuses the release, retryable, and nothing is spent.
   */
  async spendRelease(
    owner: string,
    ref: string,
    credits: number,
    tool: string,
  ): Promise<{ balance: number | null }> {
    const access = await this.#o.access.require(owner);
    const link = access.ledger;
    // Every account that isn't on a given plan (exempt before this) has a link; without one
    // nothing is spent, so nothing is released.
    if (!link)
      throw new CfError('service_unavailable', 'The watermark could not be removed just now', {
        hint: 'Nothing was spent. Call export.release again in a minute',
        detail: { retry: true, retry_after_seconds: 60 },
      });
    let spent: LedgerUsage;
    try {
      spent = await this.#o.ledger.usage({
        account_id: link.account_id,
        job_id: ref,
        credits,
        tool,
        finished_at: new Date().toISOString(),
      });
    } catch (error) {
      process.stderr.write(`lifecycle: ${owner}: release ${ref}: ${(error as Error).message}\n`);
      throw new CfError('service_unavailable', 'The watermark could not be removed just now', {
        hint: 'Nothing was spent. Call export.release again in a minute',
        detail: { retry: true, retry_after_seconds: 60 },
      });
    }
    this.#o.access.spent(owner, spent.balance);
    const mark: Spent = {
      at: new Date().toISOString(),
      told: spent.duplicate || (!spent.crossed && !spent.top_up),
      crossed: spent.crossed,
      top_up: spent.top_up,
    };
    const marks = this.#o.runtime.ws.records.collection(LEDGER_SPENT, { owner });
    await marks.put(ref, mark);
    if (!mark.told) {
      void this.#tell(owner, access, ref, mark)
        .then(() => marks.put(ref, { ...mark, told: true }))
        .catch((error: Error) => process.stderr.write(`lifecycle: ${owner}: ${error.message}\n`));
    }
    return { balance: spent.balance };
  }

  /** Emails what a spend crossed, and what automatic top-up did there. */
  async #tell(owner: string, access: Access & { allowed: true }, jobId: string, mark: Spent) {
    const top = mark.top_up;
    if (top?.ok) {
      await this.#notify(owner, `top-up-${jobId}`, {
        to: access.email,
        subject: `Topped up: ${top.credits} credits`,
        lines: [
          `Your credits were running low, so we bought ${top.credits} credits for $${top.price} on your ${top.card.brand} ending ${top.card.last4}, as you asked.`,
          'Your agent keeps working. Change or turn off automatic top-up on your account page.',
        ],
        action: { label: 'Open your account', url: `${this.#o.accountUrl}#credits` },
      });
      return;
    }
    if (top) {
      process.stderr.write(`lifecycle: ${owner}: top-up: ${top.message}\n`);
      await this.#notify(owner, `top-up-failed-${jobId}`, {
        to: access.email,
        subject: 'We couldn’t top up your credits',
        lines: [
          `Your credits are running low, and the automatic top-up of ${top.credits} credits for $${top.price} didn’t go through (${top.message}).`,
          'Top up on your account page to keep your agent working; it saves the card for next time.',
        ],
        action: { label: 'Top up', url: `${this.#o.accountUrl}#credits` },
      });
    }
    if (mark.crossed) await this.#runningLow(owner, access, mark.crossed);
  }

  /** The balance just fell below LOW_CREDITS, or to zero: says so by email. */
  async #runningLow(owner: string, access: Access & { allowed: true }, kind: 'low' | 'out') {
    const balance = await this.#o.access.balance(owner, access);
    const left = balance.left ?? 0;
    const out = kind === 'out';
    await this.#notify(owner, warningName(balance, kind), {
      to: access.email,
      subject: out ? 'Your credits are used up' : `You have ${left} credits left`,
      lines: [
        out
          ? 'Your credits are used up.'
          : `You have ${left} credits left. Credits remove watermarks, priced by each video's length.`,
        out
          ? 'Making still works, all of it: editing, exports, motion graphics, voiceovers. Exports download with a cuttingfloor watermark; removing watermarks waits until you top up.'
          : 'At zero, everything still works and exports download with a cuttingfloor watermark; removing watermarks waits until you top up.',
        `Top up on your account page: packs start at $${PACKS[0]?.price} for ${PACKS[0]?.credits} credits, and they never expire. Turn on automatic top-up there and this won't stop you again.`,
      ],
      action: { label: 'Top up', url: `${this.#o.accountUrl}#credits` },
    });
  }

  /**
   * Sends what a release's spend crossed when the server stopped before it could (the marker
   * kept the ledger's answer), and lets old markers go.
   */
  async #tellMissed(key: string): Promise<void> {
    const ws = this.#o.runtime.ws;
    const marks = ws.records.collection(LEDGER_SPENT, { owner: key });
    await marks.expire(SPENT_TTL_MS);
    if (!isUser(key)) return;
    const waiting = await marks.find({ told: false });
    if (!waiting.length) return;
    const access = await this.#o.access.require(key);
    for (const { id, value } of waiting) {
      await this.#tell(key, access, id, value);
      await marks.put(id, { ...value, told: true });
    }
  }

  /** The signed-in account's plan and credits, for account.get and the account page. */
  async account(owner: string): Promise<AccountGetResult> {
    const access = await this.#o.access.require(owner);
    const balance = await this.#o.access.balance(owner, access);
    const plan = PLANS[access.plan];
    const bought = plan.credits.kind === 'balance';
    const refill = packOf(balance.refill);
    const card =
      bought && access.customer
        ? await savedCard(this.#o.stripeKey, access.customer).catch(() => undefined)
        : undefined;
    const ws = this.#o.runtime.ws;
    const sent = async (kind: 'low' | 'out') =>
      Boolean(await ws.records.collection(NOTICES, { owner }).get(warningName(balance, kind)));
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
            automatic: Boolean(refill),
            pack: refill ? { price_usd: refill.price, credits: refill.credits } : null,
            below: LOW_CREDITS,
            card_saved: Boolean(card),
          }
        : null,
      packs: bought ? PACKS.map((p) => ({ price_usd: p.price, credits: p.credits })) : [],
      limits: {
        export_short_side: l.shortSide,
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
    for (const key of await ws.records.owners()) {
      await ws.records.collection(NOTICES, { owner: key }).expire(NOTICE_TTL_MS);
      await this.#tellMissed(key).catch((error: Error) =>
        process.stderr.write(`lifecycle: ${key}: spend: ${error.message}\n`),
      );
    }
    for (const name of await ws.records.parents(PARTNER_LINKS)) {
      await ws.records.collection(PARTNER_LINKS, { parent: name }).expire(PARTNER_LINK_TTL_MS);
    }
    await this.#o.keys?.sweep();
    await this.#o.adminKeys?.sweep();
    await this.#expiryNotices(now);
    const welcome = this.#o.welcome;
    if (!this.#o.mailer || !welcome) return;
    const oldest = now - 86_400_000;
    for await (const user of this.#users(oldest)) {
      const created = Date.parse(user.created_at);
      if (now - created < 86_400_000 && !madeByPartner(user.metadata)) {
        await this.#notify(user.id, 'welcome', {
          to: user.email,
          subject: 'Welcome to cuttingfloor',
          lines: [
            'Your agent can edit video now. Add cuttingfloor to it once: the welcome page has the step for Claude, Claude Code, Cursor, Codex, ChatGPT and Kazi.',
            `The address is ${welcome.serverUrl}/mcp. Your agent opens a sign-in the first time; use this same account.`,
            `Then ask it for an edit, for example: "Import my video and cut out the pauses and ums." Making is free: edits, exports, motion graphics, voiceovers. Exports download with a cuttingfloor watermark, and removing the watermark costs credits, priced by the video's length; your account gets ${FREE_CREDITS} credits when your agent activates it. No card, no time limit.`,
          ],
          action: { label: 'Connect your agent', url: welcome.url },
        });
      }
    }
  }

  /** The day's file reminders, once a day from EXPIRY_HOUR_UTC; each account's at most once. */
  async #expiryNotices(now: number): Promise<void> {
    const at = new Date(now);
    const day = at.toISOString().slice(0, 10);
    if (!this.#o.mailer || at.getUTCHours() < EXPIRY_HOUR_UTC || this.#expiryDay === day) return;
    this.#expiryDay = day;
    for (const owner of await this.#o.runtime.ws.records.owners()) {
      if (!isUser(owner)) continue;
      await this.#expiring(owner, day, now).catch((error: Error) =>
        process.stderr.write(`lifecycle: ${owner}: expiry email: ${error.message}\n`),
      );
    }
  }

  async #expiring(owner: string, day: string, now: number): Promise<void> {
    const rt = this.#o.runtime;
    const [media, jobs] = await Promise.all([
      rt.media.list(owner),
      rt.jobs.store.list(owner, { status: 'completed', limit: 1000 }),
    ]);
    const files: Going[] = [
      ...media.map((m) => ({ name: m.name, at: Date.parse(m.expires_at) })),
      ...jobs.flatMap((job) => exportOf(job) ?? []),
    ];
    const due = dueFiles(files, now);
    if (!due) return;
    const user = await this.#workosUser(owner);
    if (!user || madeByPartner(user.metadata) || user.metadata?.expiry_emails === 'off') return;
    // Fresh download links for exports: the ones the job was made with may have run out.
    const linked = async (list: Going[]) =>
      Promise.all(
        list.map(async (f) => {
          return f.jobId ? { ...f, url: (await rt.signOutput(owner, f.jobId, f.name)).url } : f;
        }),
      );
    const message = expiryMessage(
      { soon: await linked(due.soon), later: await linked(due.later) },
      this.#o.accountUrl,
    );
    await this.#notify(owner, `expiry-${day}`, { to: user.email, ...message });
  }

  /**
   * One page of WorkOS users, newest first, for the admin API: `after` is WorkOS's own cursor.
   * With `email`, only the users with it.
   */
  async usersPage(page: {
    after?: string;
    limit: number;
    email?: string;
  }): Promise<{ data: WorkosUser[]; after: string | null }> {
    const query = new URLSearchParams({
      limit: String(page.limit),
      order: 'desc',
      ...(page.after ? { after: page.after } : {}),
      ...(page.email ? { email: page.email } : {}),
    });
    const list = (await this.#workos(`/user_management/users?${query}`)) as {
      data?: WorkosUser[];
      list_metadata?: { after?: string | null };
    };
    return { data: list.data ?? [], after: list.list_metadata?.after ?? null };
  }

  /**
   * Whether the account ran a tool before activation existed (`first_tool_at` before
   * ACTIVATION_FROM), so it is active without a claim. Read once per account: a first tool use
   * still to come is after that date. True when WorkOS can't be read, so the call runs.
   */
  async activeBefore(owner: string): Promise<boolean> {
    const known = this.#activeBefore.get(owner);
    if (known !== undefined) return known;
    if (!isUser(owner)) return false;
    try {
      const user = await this.#workosUser(owner);
      const first = Date.parse(user?.metadata?.first_tool_at ?? '');
      const active = first < ACTIVATION_FROM;
      this.#activeBefore.set(owner, active);
      return active;
    } catch (error) {
      process.stderr.write(`lifecycle: ${owner}: ${(error as Error).message}\n`);
      return true;
    }
  }

  /** One WorkOS user, or undefined when there is none with this id. */
  user(id: string): Promise<WorkosUser | undefined> {
    return this.#workosUser(id);
  }

  /** WorkOS users, newest first, back to `oldest`. */
  async *#users(oldest: number): AsyncGenerator<WorkosUser> {
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({
        limit: '100',
        order: 'desc',
        ...(after ? { after } : {}),
      });
      const list = (await this.#workos(`/user_management/users?${query}`)) as {
        data?: WorkosUser[];
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
    if (!mailer || !message.to || this.#o.standby) return false;
    const ws = this.#o.runtime.ws;
    const notices = ws.records.collection(NOTICES, { owner });
    if (!(await notices.insertOnce(name, { at: new Date().toISOString() }))) return false;
    try {
      await mailer.send({ ...message, key: `${owner}:${name}` });
      return true;
    } catch (error) {
      // Unclaimed again, so the next chance sends it.
      await notices.delete(name).catch(() => undefined);
      throw error;
    }
  }

  /** Sets a field in the user's WorkOS metadata (the time, by default), if it isn't set yet. */
  async #markOnce(owner: string, field: string, value = new Date().toISOString()): Promise<void> {
    if (!isUser(owner) || this.#o.standby) return;
    const path = `/user_management/users/${encodeURIComponent(owner)}`;
    await oneWriteAtATime(owner, async () => {
      const user = await this.#workos(path);
      const metadata = (user.metadata ?? {}) as Record<string, string>;
      if (metadata[field]) return;
      await this.#workos(path, {
        method: 'PUT',
        body: { metadata: { ...metadata, [field]: value } },
      });
    });
  }

  /**
   * The routes the site and Stripe call: `POST /stripe/webhook`, `GET /account/usage`,
   * `POST /account/top-up`, `GET /account/media`, `POST /account/uploads`, and `GET`/`POST /account/keys` and
   * `POST /account/keys/revoke`, `POST /account/kazi-handoff`, and partners' `POST /partner/keys`
   * and `DELETE /partner/users`. Returns false for any other path.
   */
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    // On standby: nothing that charges, deletes an account or acts on a payment.
    if (
      this.#o.standby &&
      ((url.pathname === '/partner/users' && req.method === 'DELETE') ||
        url.pathname === '/stripe/webhook' ||
        url.pathname === '/account/top-up')
    ) {
      req.resume();
      json(res, 503, { error: 'This server is a standby copy and does not do that' });
      return true;
    }
    // Draining (drain.ts): no new uploads from the account page.
    if (url.pathname === '/account/uploads' && this.#o.runtime.drain.active) {
      req.resume();
      res.setHeader('retry-after', String(DRAIN_RETRY_SECONDS));
      json(res, 503, { error: drainingError().message });
      return true;
    }
    if (url.pathname === '/partner/keys') {
      await this.#partnerRoute(req, res);
      return true;
    }
    if (url.pathname === '/partner/users') {
      await this.#partnerDeleteRoute(req, res);
      return true;
    }
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
    if (url.pathname === '/account/notifications' && req.method === 'POST') {
      await this.#notificationsRoute(req, res);
      return true;
    }
    if (url.pathname === '/account/top-up' && req.method === 'POST') {
      await this.#topUpRoute(req, res);
      return true;
    }
    if (url.pathname === '/account/keys' || url.pathname === '/account/keys/revoke') {
      await this.#keysRoute(req, res, url);
      return true;
    }
    if (url.pathname === '/account/kazi-handoff' && req.method === 'POST') {
      await this.#kaziHandoffRoute(req, res);
      return true;
    }
    if (url.pathname === '/account/sounds' || url.pathname === '/account/sounds/remove') {
      await this.#soundsRoute(req, res, url);
      return true;
    }
    return false;
  }

  /**
   * The sounds the account shared in the community pack. GET ?user= lists them; POST {user,
   * upload_id or media_id, name, description, tags, category, author?} shares one of its files;
   * POST /remove {user, sound_id} takes one down.
   */
  async #soundsRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    const sharing = this.#o.runtime.sharing;
    if (!sharing) return json(res, 503, { error: 'sound sharing is off on this server' });
    if (req.method === 'GET' && url.pathname === '/account/sounds') {
      const owner = url.searchParams.get('user') ?? '';
      if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
      return json(res, 200, { sounds: await sharing.mine(owner) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    const body = (await jsonBody(req)) as
      | { user?: unknown; upload_id?: unknown; media_id?: unknown; sound_id?: unknown }
      | undefined;
    if (!body) return json(res, 400, { error: 'body must be JSON' });
    const owner = typeof body.user === 'string' ? body.user : '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    if (url.pathname === '/account/sounds/remove') {
      const id = typeof body.sound_id === 'string' ? body.sound_id : '';
      const removed = await sharing.unshare(owner, id);
      return json(
        res,
        removed ? 200 : 404,
        removed ? { removed: true } : { error: 'no such sound' },
      );
    }
    const from =
      typeof body.upload_id === 'string'
        ? { upload_id: body.upload_id }
        : typeof body.media_id === 'string'
          ? { media_id: body.media_id }
          : undefined;
    if (!from) return json(res, 400, { error: 'name the file: upload_id or media_id' });
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const { user: _, upload_id: __, media_id: ___, ...meta } = body as Record<string, unknown>;
    const answer = await share(this.#o.runtime, owner, from, meta, abort.signal);
    return json(res, answer.status, answer.body);
  }

  /**
   * The name a shared sound is credited to when its sharer gives none: their first name and the
   * first letter of their last, from their account; null when the account has no name.
   */
  async soundAuthor(owner: string): Promise<string | null> {
    if (!isUser(owner)) return null;
    const user = await this.#workosUser(owner);
    const first = user?.first_name?.trim();
    if (!first) return null;
    const last = user?.last_name?.trim();
    return last ? `${first} ${last[0]?.toUpperCase()}.` : first;
  }

  /**
   * Automatic top-up, set on the account page: POST {user, pack} with a pack's id, or pack null
   * for off. The ledger keeps it and buys the pack when the balance runs low.
   */
  async #topUpRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    let body: { user?: unknown; pack?: unknown };
    try {
      body = JSON.parse(await readBody(req, 16 * 1024));
    } catch {
      return json(res, 400, { error: 'body must be JSON: {user, pack}' });
    }
    const owner = typeof body.user === 'string' ? body.user : '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    const pack = body.pack === null ? null : packOf(typeof body.pack === 'string' ? body.pack : '');
    if (pack === undefined) return json(res, 400, { error: 'pack must be a pack id or null' });
    try {
      await this.#o.access.setRefill(owner, pack?.id ?? null);
    } catch (error) {
      process.stderr.write(`lifecycle: ${owner}: top-up: ${(error as Error).message}\n`);
      return json(res, 503, { error: 'top-up could not be set just now' });
    }
    return json(res, 200, { account: await this.account(owner) });
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
   * Someone who just signed up on the site goes on into Kazi: POST {user, share_code} answers
   * Kazi's one-time link `{url, expires_at}`, signed in as them with cuttingfloor connected to this
   * account. The email and its verification come from WorkOS here, never from the caller, and an
   * unverified one is refused (403), since Kazi signs in whoever has it.
   */
  async #kaziHandoffRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    let body: { user?: unknown; share_code?: unknown; via?: unknown };
    try {
      body = JSON.parse(await readBody(req, 16 * 1024));
    } catch {
      return json(res, 400, { error: 'body must be JSON: {user, share_code, via?}' });
    }
    const owner = typeof body.user === 'string' ? body.user : '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    const share = typeof body.share_code === 'string' ? body.share_code : '';
    if (!/^[A-Za-z0-9]{4,32}$/.test(share))
      return json(res, 400, { error: 'share_code must be a Kazi share code' });
    // The AI app they came from (chatgpt, claude): a hint for Kazi, so a bad one is left out.
    const via =
      typeof body.via === 'string' && /^[a-z0-9-]{1,32}$/.test(body.via) ? body.via : undefined;
    let user: { email?: string; email_verified?: boolean; first_name?: string; last_name?: string };
    try {
      user = (await this.#workos(`/user_management/users/${encodeURIComponent(owner)}`)) as {
        email?: string;
        email_verified?: boolean;
        first_name?: string;
        last_name?: string;
      };
    } catch (error) {
      process.stderr.write(`lifecycle: ${owner}: kazi handoff: ${(error as Error).message}\n`);
      return json(res, 503, { error: 'the account could not be read just now' });
    }
    if (!user.email || !user.email_verified) return json(res, 403, { error: 'email_unverified' });
    // Activated with the demo's clip in their library while Kazi makes the link, and done before
    // the link is answered, so Kazi's first call finds it ready instead of importing it. Kazi's
    // own credits.claim still activates them if this fails.
    const activated = activateWithDemo(this.#o.runtime, owner, KAZI_DEMO_TASK, 'kazi-demo').catch(
      (error: Error) =>
        process.stderr.write(`lifecycle: ${owner}: kazi demo clip: ${error.message}\n`),
    );
    try {
      const name = [user.first_name, user.last_name].filter((part) => part?.trim()).join(' ');
      const link = await this.#o.ledger
        .handoff({
          email: user.email,
          workos_user_id: owner,
          share_code: share,
          ...(name ? { name } : {}),
          ...(via ? { via } : {}),
        })
        .finally(() => activated);
      return json(res, 200, { url: link.url, expires_at: link.expires_at });
    } catch (error) {
      process.stderr.write(`lifecycle: ${owner}: kazi handoff: ${(error as Error).message}\n`);
      return json(res, 502, { error: 'Kazi could not open a link just now' });
    }
  }

  /**
   * A partner's key for its user: POST {email, sub} with the partner's secret as the bearer.
   * Finds the account with that email, or makes it (email verified: the partner proved it), and
   * answers with a new script key for it; the partner's earlier key for the account stops working.
   */
  async #partnerRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const partner = this.#partner(req);
    if (!partner) return json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
    const keys = this.#o.keys;
    if (!keys) return json(res, 503, { error: 'script keys are off on this server' });
    const user = await partnerUser(req);
    if ('error' in user) return json(res, 400, user);
    const { email, sub } = user;
    const ws = this.#o.runtime.ws;
    const links = ws.records.collection(PARTNER_LINKS, { parent: partner });
    const linked = await links.get(sha256(sub));
    if (linked && linked.email !== email)
      return json(res, 409, {
        error: `This ${partner} user is tied to another email; ask for its key with that one`,
      });
    let account: { owner: string; created: boolean };
    try {
      account = await this.#accountFor(email, partner);
    } catch (error) {
      process.stderr.write(`partner ${partner}: ${(error as Error).message}\n`);
      return json(res, 503, { error: 'accounts could not be read or made just now' });
    }
    try {
      const made = await keys.rotate(account.owner, { name: partner, sub });
      await links.put(sha256(sub), { email, owner: account.owner });
      process.stderr.write(
        `partner ${partner}: key ${made.key_id} for ${account.owner}${account.created ? ' (new)' : ''}\n`,
      );
      return json(res, 200, {
        key: made.key,
        key_id: made.key_id,
        owner: account.owner,
        expires_at: made.expires_at,
        created: account.created,
      });
    } catch (error) {
      return json(res, 409, { error: (error as Error).message });
    }
  }

  /** The partner whose secret the call carries as its bearer, if any. */
  #partner(req: IncomingMessage): string | undefined {
    const given = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    return given ? this.#o.partners?.get(sha256(given)) : undefined;
  }

  /**
   * The partner's user deleted their account there: DELETE {email, sub} with the partner's secret
   * as the bearer deletes the account with that email, and the one tied to that user id, here.
   * Answers `{deleted: true}`, or 404 `{error: 'account_not_found'}` when there is none (so a
   * repeat is a 404). Any other answer means part of it is still here; calling again finishes it.
   */
  async #partnerDeleteRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const partner = this.#partner(req);
    if (!partner) return json(res, 401, { error: 'unauthorized' });
    if (req.method !== 'DELETE') return json(res, 405, { error: 'DELETE' });
    const user = await partnerUser(req);
    if ('error' in user) return json(res, 400, user);
    const { email, sub } = user;
    const ws = this.#o.runtime.ws;
    const links = ws.records.collection(PARTNER_LINKS, { parent: partner });
    // Each account to delete, and whether WorkOS still has its user.
    let accounts: { id: string; email: string; user: boolean }[];
    let linked: { owner?: string } | undefined;
    try {
      accounts = (await this.#usersWith(email)).map((u) => ({ id: u.id, email, user: true }));
      linked = await links.get(sha256(sub));
      const tied = linked?.owner;
      if (tied && isUser(tied) && !accounts.some((a) => a.id === tied)) {
        const found = await this.#workosUser(tied);
        // A link whose user is already gone still has files to remove.
        accounts.push({ id: tied, email: found?.email.toLowerCase() ?? '', user: Boolean(found) });
      }
    } catch (error) {
      process.stderr.write(`partner ${partner}: delete: ${(error as Error).message}\n`);
      return json(res, 503, { error: 'accounts could not be read just now' });
    }
    if (!accounts.length && !linked) return json(res, 404, { error: 'account_not_found' });
    try {
      for (const account of accounts) await this.#erase(account.id, account.email);
      await this.#unlink(new Set(accounts.map((a) => a.id)), email);
      await links.delete(sha256(sub));
      // Last: while the WorkOS user is there, a retry finds the account and finishes the rest.
      for (const account of accounts) if (account.user) await this.#deleteUser(account.id);
    } catch (error) {
      process.stderr.write(`partner ${partner}: delete: ${(error as Error).message}\n`);
      return json(res, 503, { error: 'the account could not be deleted just now; call again' });
    }
    process.stderr.write(
      `partner ${partner}: deleted ${accounts.map((a) => a.id).join(', ') || 'a stale link'}\n`,
    );
    return json(res, 200, { deleted: true });
  }

  /**
   * Removes everything kept here for an owner except its WorkOS user: its running jobs stop first
   * (so none writes into its folder after it goes), then its script keys, cached frames of its
   * timelines, its email log lines and suppression, and its folder.
   */
  async #erase(owner: string, email: string): Promise<void> {
    if (!isUser(owner)) return;
    const runtime = this.#o.runtime;
    const ws = runtime.ws;
    const working = await runtime.jobs.store.list(owner, {
      status: 'working',
      limit: Number.POSITIVE_INFINITY,
    });
    for (const job of working) await runtime.jobs.cancel(job.id, owner);
    await this.#o.keys?.removeAll(owner);
    await this.#o.adminKeys?.removeAll(owner);
    await this.#o.rights?.revoke(owner, 'admin');
    const timelines = new Set(await ws.records.collection(TIMELINES, { owner }).ids());
    if (timelines.size) {
      const frames = `${ws.blobs.keys.cache('frames')}/`;
      for (const { key } of await ws.blobs.list(frames)) {
        const name = key.slice(frames.length);
        if (timelines.has(name.slice(0, name.indexOf('-')))) await ws.blobs.delete(key);
      }
    }
    await forgetRecipient(ws, owner, email);
    await runtime.uploads.forget(owner);
    await ws.blobs.forget(owner);
    await ws.records.forget(owner);
    this.#o.access.forget(owner);
    this.#seen.delete(owner);
    this.#apps.delete(owner);
    this.#usedOn.delete(owner);
  }

  /** Removes every partner's link to these accounts or this email. */
  async #unlink(owners: Set<string>, email: string): Promise<void> {
    const ws = this.#o.runtime.ws;
    for (const name of await ws.records.parents(PARTNER_LINKS)) {
      const links = ws.records.collection(PARTNER_LINKS, { parent: name });
      for (const id of await links.ids()) {
        const link = await links.get(id).catch(() => undefined);
        if (link?.email === email || (link?.owner && owners.has(link.owner)))
          await links.delete(id);
      }
    }
  }

  /** The WorkOS users with this email. */
  async #usersWith(email: string): Promise<WorkosUser[]> {
    const list = (await this.#workos(
      `/user_management/users?${new URLSearchParams({ email })}`,
    )) as {
      data?: WorkosUser[];
    };
    return (list.data ?? []).filter(
      (user) => user.email.toLowerCase() === email && isUser(user.id),
    );
  }

  /** The WorkOS user with this id, or undefined when there is none. */
  async #workosUser(id: string): Promise<WorkosUser | undefined> {
    const res = await this.#workosCall(`/user_management/users/${encodeURIComponent(id)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`WorkOS user: ${res.status}`);
    return (await res.json()) as WorkosUser;
  }

  /** Deletes a WorkOS user (its sign-in, sessions and metadata); one already gone is fine. */
  async #deleteUser(id: string): Promise<void> {
    const res = await this.#workosCall(
      `/user_management/users/${encodeURIComponent(id)}`,
      'DELETE',
    );
    if (!res.ok && res.status !== 404) throw new Error(`WorkOS delete user: ${res.status}`);
  }

  /** The WorkOS user with this email, made (verified, marked as the partner's) when none is. */
  async #accountFor(email: string, partner: string): Promise<{ owner: string; created: boolean }> {
    const find = async () => {
      const list = (await this.#workos(
        `/user_management/users?${new URLSearchParams({ email })}`,
      )) as { data?: WorkosUser[] };
      return list.data?.find((user) => user.email.toLowerCase() === email)?.id;
    };
    const found = await find();
    if (found) return { owner: found, created: false };
    try {
      const user = await this.#workos('/user_management/users', {
        method: 'POST',
        body: {
          email,
          email_verified: true,
          metadata: { plan_reason: `${MADE_BY}${partner}` },
        },
      });
      return { owner: String(user.id), created: true };
    } catch (error) {
      // Made by a call at the same moment: that one is the account.
      const raced = await find();
      if (raced) return { owner: raced, created: false };
      throw error;
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

  /** Turns the account's file reminders on or off: POST {user, expiry_emails: boolean}. */
  async #notificationsRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    let body: { user?: unknown; expiry_emails?: unknown };
    try {
      body = JSON.parse(await readBody(req, 4096));
    } catch {
      return json(res, 400, { error: 'body must be JSON: {user, expiry_emails}' });
    }
    const owner = typeof body.user === 'string' ? body.user : '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    if (typeof body.expiry_emails !== 'boolean')
      return json(res, 400, { error: 'expiry_emails must be true or false' });
    const value = body.expiry_emails ? 'on' : 'off';
    try {
      const path = `/user_management/users/${encodeURIComponent(owner)}`;
      await oneWriteAtATime(owner, async () => {
        const user = await this.#workos(path);
        const metadata = (user.metadata ?? {}) as Record<string, string>;
        await this.#workos(path, {
          method: 'PUT',
          body: { metadata: { ...metadata, expiry_emails: value } },
        });
      });
      return json(res, 200, { expiry_emails: body.expiry_emails });
    } catch {
      return json(res, 503, { error: 'The setting could not be saved just now; try again' });
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

  /**
   * Starts an upload for the account: a signed URL the browser sends the file to directly. With
   * `upload_id` instead, the URL of that unfinished upload again, to carry on where it stopped.
   */
  async #uploadRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    let body: { user?: unknown; name?: unknown; bytes?: unknown; upload_id?: unknown };
    try {
      body = JSON.parse(await readBody(req, 16 * 1024));
    } catch {
      return json(res, 400, {
        error: 'body must be JSON: {user, name, bytes} or {user, upload_id}',
      });
    }
    const owner = typeof body.user === 'string' ? body.user : '';
    if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
    if (body.upload_id !== undefined) {
      try {
        const upload = await this.#o.runtime.uploads.resume(owner, String(body.upload_id));
        return json(res, 200, upload);
      } catch (error) {
        if (!(error instanceof CfError)) throw error;
        return json(res, error.code === 'not_found' ? 404 : 400, {
          error: error.message,
          code: error.code,
          ...(error.hint ? { hint: error.hint } : {}),
        });
      }
    }
    const file = MediaUploadInput.safeParse({ name: body.name, bytes: body.bytes });
    // The account page always knows the file it sends.
    if (!file.success || !file.data.name)
      return json(res, 400, { error: 'name must be a file name; bytes its size' });
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
    const res = await this.#workosCall(path, init.method, init.body);
    if (!res.ok) throw new Error(`WorkOS ${path.split('?')[0]}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  #workosCall(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`https://api.workos.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#o.workosKey}`,
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
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

/** A job spent on the ledger: its answer, kept until the email it calls for is sent. */
interface Spent {
  at: string;
  told: boolean;
  crossed?: LedgerUsage['crossed'];
  top_up?: LedgerUsage['top_up'];
}

/** That a job was spent on the ledger, by job id (`owners/{owner}/ledger-spent/`). */
export const LEDGER_SPENT = defineCollection<Spent>({
  name: 'ledger_spent',
  scope: 'owner',
  fs: { dir: 'ledger-spent' },
  db: { ttlMs: SPENT_TTL_MS },
});

/** That a notice was sent to an account, by its name: written once, so it is sent once. */
export const NOTICES = defineCollection<{ at: string }>({
  name: 'notices',
  scope: 'owner',
  fs: { dir: 'notices' },
  db: { ttlMs: NOTICE_TTL_MS },
});

/** A partner's user and the account its key is for, by the user id's SHA-256, per partner. */
export const PARTNER_LINKS = defineCollection<{ email?: string; owner?: string }>({
  name: 'partners',
  scope: 'global',
  fs: { dir: (partner) => `partners/${partner}` },
  db: { indexesAcross: [['email'], ['owner']] },
});

export interface WorkosUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  email_verified?: boolean;
  created_at: string;
  metadata?: Record<string, string>;
}

/** A partner's call naming its user: {email, sub}, the email lowercased. */
async function partnerUser(
  req: IncomingMessage,
): Promise<{ email: string; sub: string } | { error: string }> {
  let body: { email?: unknown; sub?: unknown };
  try {
    body = JSON.parse(await readBody(req, 16 * 1024));
  } catch {
    return { error: 'body must be JSON: {email, sub}' };
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const sub = typeof body.sub === 'string' ? body.sub.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)
    return { error: 'email must be an email address' };
  if (!sub || sub.length > 200) return { error: 'sub must be the user id' };
  return { email, sub };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const isUser = (owner: string) => /^user_[0-9A-Z]{26}$/.test(owner);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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
