import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AdminAccount,
  AdminAccountListQuery,
  AdminAdjustInput,
  type AdminAdjustment,
  type AdminFile,
  type AdminLedger,
  type AdminLedgerEntry,
  type AdminMe,
  type AdminSort,
  adminComponentSchemas,
} from '@cuttingfloor/schema';
import {
  billedSeconds,
  type CallEntry,
  CLAIM_TASKS,
  CLAIMS,
  finalLink,
  meterEntries,
  ONBOARDING,
  RELEASES,
  type Runtime,
  readCalls,
  readSupportMessages,
} from '@cuttingfloor/server';
import type { AccessCheck } from './access.ts';
import type { AppsSeen } from './apps-seen.ts';
import { readDownloads } from './downloads.ts';
import { exportOf } from './expiry-notices.ts';
import type { KeyKind, ScriptKeys } from './keys.ts';
import type { CreditEntry, Ledger } from './ledger.ts';
import type { Lifecycle, WorkosUser } from './lifecycle.ts';
import { Referrals, referralCode, referralLink } from './referral.ts';
import { isUser, type Rights } from './rights.ts';
import { recipientState } from './sequence.ts';

// The admin API: REST for cuttingfloor's admins and the systems they connect (a CRM), at
// /admin/v1, described by its own OpenAPI document at /admin/v1/openapi.json (public, so it can
// be indexed). Its schemas live in @cuttingfloor/schema (admin.ts); apps/hosted/admin-openapi.json
// is the document as reviewed, and a test keeps the two the same.
// - A call carries an admin key (`Authorization: Bearer cfa_…`), which a user with the admin role
//   makes on the site's account page. The role is checked on every call, from cuttingfloor's own
//   rights table (rights.ts), so taking it away stops every key of that user at once.
// - Answers are facts, never segments: who to email and when is the caller's to decide.
// - The site manages the keys: `GET /account/admin-keys?user=`, `POST /account/admin-keys`
//   {user, label} and `POST /account/admin-keys/revoke` {user, key_id}, with the site's own key.
// - The site's admin pages call this API with the site's own key and the signed-in person's WorkOS
//   user id (`X-Cuttingfloor-Admin: user_…`). The role is checked for that person exactly as for
//   a key, so the browser never holds a key and the site can do nothing a key of theirs couldn't.
//   Not in the OpenAPI document: it is the site's door, not a client's.
// - One write: an adjustment (adjust_credits), an `adjust` entry on the credit ledger carrying the
//   admin's id and reason, idempotent by the caller's id.

/** The API's version: within v1 it only grows, so every change bumps minor or patch. */
export const ADMIN_API_VERSION = '1.12.0';
const BASE = '/admin/v1';
/** Admin keys: their own prefix and folder, so a script key never opens this API. */
export const ADMIN_KEYS: KeyKind = { prefix: 'cfa_', dir: 'admin-keys', label: 'Admin key' };
/** Accounts read at once while building a page: each reads WorkOS, the ledger and the disk. */
const PARALLEL = 10;
/** The account list, for totals and pages, is read again after a minute. */
const USERS_FRESH_MS = 60_000;
/** WorkOS pages of 100 read for the list: 50,000 accounts. */
const USERS_PAGES = 500;
/** The header naming the signed-in admin on the site's calls. */
const SITE_ADMIN = 'x-cuttingfloor-admin';
/** What one account's sorting facts (credits, exports) are kept for. */
const SUMMARY_FRESH_MS = 60_000;

type Account = AdminAccount;
type File = AdminFile;

export interface AdminApiOptions {
  runtime: Runtime;
  lifecycle: Pick<Lifecycle, 'usersPage' | 'user'>;
  access: Pick<AccessCheck, 'balance' | 'payments' | 'opened' | 'creditAccount' | 'forget'>;
  /** The credit ledger: entries to show, and adjustments to write. */
  ledger: Pick<Ledger, 'get' | 'entries' | 'credit'>;
  /** The apps each account used. */
  apps: Pick<AppsSeen, 'read'>;
  /** Admin keys (cfa_…). */
  keys: ScriptKeys;
  rights: Rights;
  /** The address the API is served at, e.g. https://api.cuttingfloor.ai. */
  publicUrl: string;
  /** The site's key, for its key management routes. */
  accountKey?: string;
  /** The site's account page, whose origin serves each account's link (/r/<code>). */
  accountUrl?: string;
}

export class AdminApi {
  readonly #o: AdminApiOptions;
  #users: { at: number; list: WorkosUser[]; referrals: Referrals } | undefined;
  /** Each account's credits and exports, for sorting by them. */
  #summaries = new Map<string, { at: number; credits: number | null; exports: number }>();

  constructor(options: AdminApiOptions) {
    this.#o = options;
  }

  /** Answers /admin/v1/… and the site's /account/admin-keys routes; false for any other path. */
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/account/admin-keys' || url.pathname === '/account/admin-keys/revoke') {
      await this.#keysRoute(req, res, url);
      return true;
    }
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
    const path = url.pathname.slice(BASE.length) || '/';
    const adjusting = /^\/accounts\/([^/]+)\/adjustments$/.exec(path)?.[1];
    if (req.method !== (adjusting ? 'POST' : 'GET'))
      return fail(
        res,
        405,
        'method_not_allowed',
        adjusting ? 'An adjustment is a POST' : 'Every admin API call but adjust_credits is a GET',
      );
    if (path === '/openapi.json') {
      json(res, 200, adminOpenApi(this.#o.publicUrl));
      return true;
    }
    const caller = await this.#caller(req);
    if ('status' in caller) return fail(res, caller.status, caller.code, caller.message);
    try {
      if (adjusting)
        return await this.#adjust(req, res, decodeURIComponent(adjusting), caller.owner);
      const ledgerOf = /^\/accounts\/([^/]+)\/ledger$/.exec(path)?.[1];
      if (ledgerOf) return await this.#ledger(res, decodeURIComponent(ledgerOf));
      if (path === '/me') {
        if (!caller.expires_at)
          return fail(
            res,
            400,
            'bad_request',
            "/me describes an admin key; the site's calls use none",
          );
        const user = await this.#o.lifecycle.user(caller.owner);
        const me: AdminMe = {
          user: caller.owner,
          email: user?.email ?? null,
          roles: await this.#o.rights.roles(caller.owner),
          key: { key_id: caller.key_id, expires_at: caller.expires_at },
        };
        json(res, 200, me);
        return true;
      }
      if (path === '/accounts') return await this.#list(res, url);
      const id = /^\/accounts\/([^/]+)$/.exec(path)?.[1];
      if (id) {
        const owner = decodeURIComponent(id);
        const user = isUser(owner) ? await this.#o.lifecycle.user(owner) : undefined;
        if (!user)
          return fail(res, 404, 'not_found', `No account ${owner}`, 'list_accounts finds ids');
        const { referrals } = await this.#allUsers();
        json(res, 200, await this.#account(user, { links: true, referrals }));
        return true;
      }
      return fail(res, 404, 'not_found', `No admin API path ${path}`, `See ${BASE}/openapi.json`);
    } catch (error) {
      process.stderr.write(`admin api ${path}: ${(error as Error).message}\n`);
      return fail(res, 503, 'unavailable', 'Accounts could not be read just now', 'Try again');
    }
  }

  /**
   * Every account, newest first, and who each one's link brought, read from WorkOS at most once
   * a minute.
   */
  async #allUsers(): Promise<{ list: WorkosUser[]; referrals: Referrals }> {
    if (this.#users && Date.now() - this.#users.at < USERS_FRESH_MS) return this.#users;
    const list: WorkosUser[] = [];
    let after: string | undefined;
    for (let i = 0; i < USERS_PAGES; i++) {
      const page = await this.#o.lifecycle.usersPage({ limit: 100, ...(after ? { after } : {}) });
      list.push(...page.data.filter((u) => isUser(u.id)));
      if (!page.after) break;
      after = page.after;
    }
    this.#users = { at: Date.now(), list, referrals: new Referrals(list) };
    return this.#users;
  }

  async #list(res: ServerResponse, url: URL): Promise<true> {
    const query = AdminAccountListQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success)
      return fail(
        res,
        400,
        'bad_request',
        query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    const { cursor, page: asked, limit, email, q, sort } = query.data;
    const everyone = await this.#allUsers();
    const { referrals } = everyone;
    let all = email
      ? (await this.#o.lifecycle.usersPage({ limit: 100, email: email.toLowerCase() })).data.filter(
          (u) => isUser(u.id),
        )
      : everyone.list;
    if (q) {
      const part = q.toLowerCase();
      all = all.filter(
        (u) => u.email.toLowerCase().includes(part) || u.id.toLowerCase().includes(part),
      );
    }
    if (sort !== 'newest') all = await this.#sorted(all, sort);
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    // A cursor is the id of the last account on the page before.
    let from = 0;
    if (asked) from = (asked - 1) * limit;
    else if (cursor) {
      const at = all.findIndex((u) => u.id === cursor);
      if (at < 0)
        return fail(res, 400, 'bad_request', `cursor ${cursor} is not in the list`, 'Use page');
      from = at + 1;
    }
    const users = all.slice(from, from + limit);
    const data: Account[] = [];
    for (let i = 0; i < users.length; i += PARALLEL) {
      const batch = users.slice(i, i + PARALLEL);
      data.push(
        ...(await Promise.all(batch.map((u) => this.#account(u, { links: false, referrals })))),
      );
    }
    const more = from + limit < total;
    const nextCursor = more ? (users.at(-1)?.id ?? null) : null;
    const page = Math.floor(from / limit) + 1;
    const next = more
      ? `${this.#o.publicUrl}${BASE}/accounts?${new URLSearchParams({
          limit: String(limit),
          page: String(page + 1),
          ...(email ? { email } : {}),
          ...(q ? { q } : {}),
          ...(sort !== 'newest' ? { sort } : {}),
        })}`
      : null;
    json(res, 200, {
      data,
      total,
      page,
      pages,
      has_more: more,
      next_cursor: nextCursor,
      next,
    });
    return true;
  }

  /**
   * The accounts in the order asked, most first; ties stay newest first. Last active is WorkOS's
   * own field; credits (the ledger balance, accounts without one last) and exports (export.video
   * jobs that ran, from the meter) are read for every account, at most once a minute each.
   */
  async #sorted(users: WorkosUser[], sort: Exclude<AdminSort, 'newest'>): Promise<WorkosUser[]> {
    const rank = new Map<string, number>();
    if (sort === 'last_active')
      for (const u of users)
        rank.set(u.id, Date.parse(u.metadata?.last_used_at ?? '') || -Infinity);
    else {
      for (let i = 0; i < users.length; i += PARALLEL) {
        const batch = users.slice(i, i + PARALLEL);
        const facts = await Promise.all(batch.map((u) => this.#summary(u.id)));
        batch.forEach((u, j) => {
          const f = facts[j];
          rank.set(u.id, (sort === 'credits' ? f?.credits : f?.exports) ?? -Infinity);
        });
      }
    }
    // Array.prototype.sort is stable: equal ranks keep the list's newest-first order.
    return [...users].sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || 0);
  }

  async #summary(owner: string): Promise<{ credits: number | null; exports: number }> {
    const hit = this.#summaries.get(owner);
    if (hit && Date.now() - hit.at < SUMMARY_FRESH_MS) return hit;
    const [account, exports] = await Promise.all([
      this.#o.ledger.get(owner).catch(() => undefined),
      countExports(this.#o.runtime.ws, owner).catch(() => 0),
    ]);
    const facts = { at: Date.now(), credits: account?.balance ?? null, exports };
    this.#summaries.set(owner, facts);
    return facts;
  }

  /** Every ledger entry of an account, newest first. */
  async #ledger(res: ServerResponse, owner: string): Promise<true> {
    const user = isUser(owner) ? await this.#o.lifecycle.user(owner) : undefined;
    if (!user) return fail(res, 404, 'not_found', `No account ${owner}`, 'list_accounts finds ids');
    const account = await this.#o.ledger.get(owner);
    const body: AdminLedger = account
      ? {
          opened: true,
          balance: account.balance,
          entries: (await this.#o.ledger.entries(owner)).reverse().map(ledgerEntry),
        }
      : { opened: false, balance: null, entries: [] };
    json(res, 200, body);
    return true;
  }

  /**
   * Adds or takes away credits by hand: one `adjust` entry under the caller's id, with the
   * admin's id and reason. The account's ledger account is opened first if it never was, as its
   * first use would. The same id again answers the first entry; with other credits or another
   * reason it is refused, so a mistyped retry never passes for the original.
   */
  async #adjust(
    req: IncomingMessage,
    res: ServerResponse,
    owner: string,
    admin: string,
  ): Promise<true> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req, 16 * 1024));
    } catch {
      return fail(res, 400, 'bad_request', 'The body must be JSON: {id, credits, reason}');
    }
    const input = AdminAdjustInput.safeParse(raw);
    if (!input.success)
      return fail(
        res,
        400,
        'bad_request',
        input.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    const user = isUser(owner) ? await this.#o.lifecycle.user(owner) : undefined;
    if (!user) return fail(res, 404, 'not_found', `No account ${owner}`, 'list_accounts finds ids');
    const { id, credits, reason } = input.data;
    const entryId = `adjust:${id}`;
    const account = await this.#o.access.creditAccount(owner);
    const prior = (await this.#o.ledger.entries(owner)).find((e) => e.id === entryId);
    if (!prior && credits < 0 && account.balance + credits < -1e-9)
      return fail(
        res,
        409,
        'insufficient',
        `The balance is ${account.balance}; taking ${-credits} would leave it below zero`,
        'Take away at most the balance',
      );
    const done = await this.#o.ledger.credit(owner, {
      id: entryId,
      kind: 'adjust',
      credits,
      reason,
      by: admin,
    });
    if (
      done.duplicate &&
      (done.entry.kind !== 'adjust' ||
        Math.abs(done.entry.credits - credits) > 1e-6 ||
        done.entry.reason !== reason)
    )
      return fail(
        res,
        409,
        'conflict',
        `Adjustment ${id} was made before with ${done.entry.credits} credits ("${done.entry.reason ?? ''}")`,
        'Use a new id for a new adjustment',
      );
    this.#o.access.forget(owner);
    this.#summaries.delete(owner);
    const body: AdminAdjustment = {
      entry: ledgerEntry(done.entry),
      balance: done.account.balance,
      duplicate: done.duplicate,
    };
    json(res, 200, body);
    return true;
  }

  /** What the admin API says about one account. */
  async #account(
    user: WorkosUser,
    options: { links: boolean; referrals: Referrals },
  ): Promise<Account> {
    const owner = user.id;
    const rt = this.#o.runtime;
    const meta = user.metadata ?? {};
    const customer = typeof meta.stripe_customer_id === 'string' ? meta.stripe_customer_id : '';
    const [
      media,
      jobs,
      linked,
      prefs,
      claim,
      tasks,
      calls,
      messages,
      spent,
      apps,
      purchases,
      shown,
      downloads,
      released,
    ] = await Promise.all([
      rt.media.list(owner),
      rt.jobs.store.list(owner, { status: 'completed', limit: 1000 }),
      this.#o.access.opened(owner).catch(() => undefined),
      recipientState(rt.ws, owner, user.email),
      // credits.claim's record: the use case the assistant gave.
      rt.ws.records
        .collection(CLAIMS, { owner })
        .get('free-credits')
        .catch(() => undefined),
      // Every task credits.claim was given, not only the first.
      rt.ws.records
        .collection(CLAIM_TASKS, { owner })
        .find()
        .catch(() => []),
      readCalls(rt.ws, owner).catch(() => []),
      readSupportMessages(rt.ws, owner).catch(() => []),
      spend(rt.ws, owner).catch(() => []),
      this.#o.apps.read(owner).catch(() => []),
      // Stripe only for one account: a page of 50 would be 50 calls.
      !options.links ? null : customer ? this.#o.access.payments(customer).catch(() => null) : [],
      rt.ws.records
        .collection(ONBOARDING, { owner })
        .get('onboarding')
        .catch(() => undefined),
      readDownloads(rt.ws, owner).catch(() => []),
      rt.ws.records
        .collection(RELEASES, { owner })
        .find()
        .catch(() => []),
    ]);
    const now = Date.now();
    const files: File[] = [];
    const releasedAt = new Map(released.map(({ value: r }) => [r.id, r.released_at]));
    // Whether a file has the watermark now, and since when it is clean.
    const mark = async (id: string, releaseId: string) => {
      const state = rt.gate ? await rt.gate.state(owner, id).catch(() => undefined) : undefined;
      return {
        watermarked: state?.watermarked ?? false,
        release_credits: state?.watermarked ? (state.release_credits ?? null) : null,
        released_at: releasedAt.get(releaseId) ?? null,
      };
    };
    for (const m of media) {
      if (Date.parse(m.expires_at) <= now) continue;
      const source = (m.source ?? {}) as { job?: string; job_id?: string };
      files.push({
        kind: 'media',
        id: m.media_id,
        name: m.name,
        expires_at: m.expires_at,
        download_url: null,
        page_url: null,
        final_url: null,
        ...(await mark(m.media_id, source.job ?? source.job_id ?? m.media_id)),
      });
    }
    for (const job of jobs) {
      const going = exportOf(job);
      if (!going?.jobId || going.at <= now) continue;
      const signed = options.links ? await rt.signOutput(owner, going.jobId, going.name) : null;
      const marked = await mark(going.jobId, going.jobId);
      files.push({
        kind: 'export',
        id: going.jobId,
        name: going.name,
        expires_at: new Date(going.at).toISOString(),
        download_url: signed?.url ?? null,
        page_url: signed?.pageUrl ?? null,
        final_url: signed && marked.watermarked ? (finalLink(signed.url) ?? null) : null,
        ...marked,
      });
    }
    files.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
    return {
      id: owner,
      email: user.email,
      email_verified: user.email_verified !== false,
      created_at: user.created_at,
      made_by: meta.plan_reason?.startsWith('made by ') ? meta.plan_reason.slice(8) : null,
      referral: {
        code: referralCode(owner),
        link: referralLink(owner, this.#o.accountUrl ?? 'https://cuttingfloor.ai/account'),
        referred_by: meta.referred_by ?? null,
        referred_by_account: meta.referred_by ? options.referrals.owner(meta.referred_by) : null,
        referred: options.referrals.referred(referralCode(owner)),
      },
      first_call_at: meta.first_call_at ?? null,
      first_tool_at: meta.first_tool_at ?? null,
      first_edit_at: meta.first_edit_at ?? null,
      first_export_at: meta.first_export_at ?? null,
      first_client: meta.first_client ?? null,
      use_case: claim?.use_case ?? null,
      use_case_at: claim?.claimed_at ?? null,
      // Claims from before every task was kept: the claim's own task stands in.
      use_cases: tasks.length
        ? tasks.map((t) => t.value).sort((a, b) => a.at.localeCompare(b.at))
        : claim
          ? [{ use_case: claim.use_case, at: claim.claimed_at }]
          : [],
      sample: shown ? (shown.sample ?? 'animation-short') : null,
      last_used_at: meta.last_used_at ?? null,
      // Only an account already on the ledger: reading one that isn't would open it.
      credits: linked ? await this.#credits(owner) : null,
      support_messages: messages,
      activity: activity(calls),
      out_of_credits: outOfCredits(calls),
      spend: spent,
      purchases,
      apps,
      files,
      next_expiry_at: files[0]?.expires_at ?? null,
      downloads,
      releases: released
        .map(({ value: r }) => ({
          id: r.id,
          released_at: r.released_at,
          credits: r.credits,
          via: r.via,
        }))
        .sort((a, b) => b.released_at.localeCompare(a.released_at)),
      email_prefs: {
        expiry_emails: meta.expiry_emails !== 'off',
        unsubscribed: prefs.unsubscribed,
        suppressed: prefs.suppressed as Account['email_prefs']['suppressed'],
      },
    };
  }

  async #credits(owner: string): Promise<Account['credits']> {
    try {
      const b = await this.#o.access.balance(owner);
      return {
        plan: b.plan,
        left: b.left,
        used: b.used,
        free: b.free,
        bought: b.bought,
        per_month: b.per_month,
        renews: b.renews,
      };
    } catch {
      return null;
    }
  }

  /** The admin calling, by their key; or why they may not. */
  async #caller(
    req: IncomingMessage,
  ): Promise<
    | { owner: string; key_id: string; expires_at: string | null }
    | { status: number; code: string; message: string }
  > {
    // The site, for the person signed in on it: the same role check as a key.
    const named = req.headers[SITE_ADMIN];
    if (typeof named === 'string') {
      if (!this.#fromSite(req) || !isUser(named))
        return {
          status: 401,
          code: 'unauthorized',
          message: `${SITE_ADMIN} is for the cuttingfloor site's own calls`,
        };
      if (!(await this.#o.rights.has(named, 'admin')))
        return { status: 403, code: 'forbidden', message: 'This account is not an admin' };
      return { owner: named, key_id: 'site', expires_at: null };
    }
    const key = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const found = key ? await this.#o.keys.find(key) : undefined;
    if (!found)
      return {
        status: 401,
        code: 'unauthorized',
        message:
          'Send an admin key as Authorization: Bearer cfa_…; an admin makes one on the cuttingfloor account page',
      };
    if (!(await this.#o.rights.has(found.owner, 'admin')))
      return { status: 403, code: 'forbidden', message: "This key's account is not an admin" };
    return { owner: found.owner, key_id: found.key_id, expires_at: found.expires_at };
  }

  /** The site lists, makes and revokes a signed-in admin's keys. Non-admins get none. */
  async #keysRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.#fromSite(req)) return json(res, 401, { error: 'unauthorized' });
    const keys = this.#o.keys;
    if (req.method === 'GET' && url.pathname === '/account/admin-keys') {
      const owner = url.searchParams.get('user') ?? '';
      if (!isUser(owner)) return json(res, 400, { error: 'user must be a WorkOS user id' });
      const admin = await this.#o.rights.has(owner, 'admin');
      return json(res, 200, { admin, keys: admin ? await keys.list(owner) : [] });
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
    if (url.pathname === '/account/admin-keys/revoke') {
      // Revoking needs no role: someone whose role was taken away can still clear their keys.
      const revoked = await keys.revoke(owner, typeof body.key_id === 'string' ? body.key_id : '');
      return json(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: 'no such key' });
    }
    if (!(await this.#o.rights.has(owner, 'admin')))
      return json(res, 403, { error: 'Only admins make admin keys' });
    try {
      return json(
        res,
        200,
        await keys.create(owner, typeof body.label === 'string' ? body.label : ''),
      );
    } catch (error) {
      return json(res, 409, { error: (error as Error).message });
    }
  }

  #fromSite(req: IncomingMessage): boolean {
    const expected = this.#o.accountKey;
    const given = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!expected || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** The admin API's OpenAPI 3.1 document. */
export function adminOpenApi(publicUrl: string): Record<string, unknown> {
  const schemas = adminComponentSchemas();
  const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });
  const idParam = {
    name: 'id',
    in: 'path',
    required: true,
    description: 'The account id, user_… as list_accounts gives it',
    schema: { type: 'string', pattern: '^user_[0-9A-Z]{26}$' },
  };
  const ok = (id: string, description: string) => ({
    '200': { description, content: { 'application/json': { schema: ref(id) } } },
    '4XX': { $ref: '#/components/responses/Error' },
    '5XX': { $ref: '#/components/responses/Error' },
  });
  return open({
    openapi: '3.1.0',
    info: {
      title: 'cuttingfloor admin API',
      version: ADMIN_API_VERSION,
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
      description:
        "cuttingfloor's admin API: facts about cuttingfloor accounts for its admins and the systems they connect, such as a CRM. Sign in with an admin key: Authorization: Bearer cfa_…, which a cuttingfloor admin makes on the account page. Reads are GETs; the one write, adjust_credits, adds or takes away credits on the ledger. Every answer is JSON; a refusal is an HTTP error status with {error: {code, message, hint}}. Within v1 the API only grows: new fields, endpoints and optional parameters. Ignore fields you don't know.",
    },
    servers: [{ url: `${publicUrl}${BASE}` }],
    security: [{ adminKey: [] }],
    tags: [
      { name: 'me', description: 'The admin key and its user' },
      { name: 'accounts', description: 'cuttingfloor accounts' },
    ],
    paths: {
      '/me': {
        get: {
          operationId: 'get_me',
          tags: ['me'],
          summary: 'The admin key in use',
          description:
            "Who this admin key belongs to: the user's id, email and cuttingfloor roles, and the key's id and expiry (ISO 8601 UTC). Use it to check a key works and to warn before it expires.",
          responses: ok('Me', 'The key and its user'),
        },
      },
      '/accounts': {
        get: {
          operationId: 'list_accounts',
          tags: ['accounts'],
          summary: 'List accounts',
          description:
            'List cuttingfloor accounts, newest first, with what each did and what it holds: sign-up and first-use times (first_tool_at null = never ran a tool), last use, credits, files kept and when they go (next_expiry_at), its referral link and who that link brought. Filter by exact email. Each page says total and pages; jump with page, or follow next (or cursor with next_cursor) until it is null. Lists up to a minute old. Export download links and purchases are null here; get_account gives them.',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Accounts per page: default 50, at most 100',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
            {
              name: 'cursor',
              in: 'query',
              required: false,
              description: "The last page's next_cursor; leave out for the first page",
              schema: { type: 'string', maxLength: 200 },
            },
            {
              name: 'page',
              in: 'query',
              required: false,
              description: 'The page to show, from 1 to pages; instead of cursor',
              schema: { type: 'integer', minimum: 1 },
            },
            {
              name: 'email',
              in: 'query',
              required: false,
              description: 'Only the account with exactly this email (any case)',
              schema: { type: 'string', format: 'email' },
            },
            {
              name: 'q',
              in: 'query',
              required: false,
              description: 'Only accounts whose email or id contains this (any case)',
              schema: { type: 'string', minLength: 1, maxLength: 200 },
            },
            {
              name: 'sort',
              in: 'query',
              required: false,
              description:
                'newest: sign-up, newest first. last_active: last_used_at, latest first. credits: ledger balance, most first. exports: video exports that ran since the account began, most first. Accounts without the fact come last; ties stay newest first',
              schema: {
                type: 'string',
                enum: ['newest', 'last_active', 'credits', 'exports'],
                default: 'newest',
              },
            },
          ],
          responses: ok('AccountList', 'A page of accounts'),
        },
      },
      '/accounts/{id}': {
        get: {
          operationId: 'get_account',
          tags: ['accounts'],
          summary: 'Get one account',
          description:
            'One cuttingfloor account by its id (a WorkOS user id, user_…), as list_accounts gives it, with signed download links for its exports (valid for days).',
          parameters: [idParam],
          responses: ok('Account', 'The account'),
        },
      },
      '/accounts/{id}/ledger': {
        get: {
          operationId: 'get_ledger',
          tags: ['accounts'],
          summary: "An account's credit ledger",
          description:
            "Every entry on the account's credit ledger, newest first, each with the balance after it: the activation grant, the carry-over from Kazi, packs bought and refunded, watermarks removed, and adjustments with the admin who made them and why.",
          parameters: [idParam],
          responses: ok('Ledger', 'The balance and entries'),
        },
      },
      '/accounts/{id}/adjustments': {
        post: {
          operationId: 'adjust_credits',
          tags: ['accounts'],
          summary: 'Add or take away credits',
          description:
            "Writes one adjust entry on the account's credit ledger: credits plus or minus, the reason, and the admin whose key made it. Idempotent by your id: the same id again changes nothing and answers the first entry (duplicate: true); the same id with other credits or reason is refused (409 conflict). Taking away more than the balance is refused (409 insufficient). An account that never used cuttingfloor gets its ledger account opened first, with its activation grant.",
          parameters: [idParam],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('AdjustInput') } },
          },
          responses: ok('Adjustment', 'The entry and the balance after it'),
        },
      },
    },
    components: {
      securitySchemes: {
        adminKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'cfa_…',
          description: "An admin key from a cuttingfloor admin's account page",
        },
      },
      responses: {
        Error: {
          description: 'Refused: what went wrong and what to do instead',
          content: { 'application/json': { schema: ref('Error') } },
        },
      },
      schemas,
    },
  });
}

/**
 * The document without `additionalProperties: false`: answers gain fields within v1, and a client
 * generated from the document must not refuse them.
 */
function open<T>(value: T): T {
  if (Array.isArray(value)) return value.map(open) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'additionalProperties' && v === false) continue;
    out[k] = open(v);
  }
  return out as T;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(body));
}

function fail(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  hint?: string,
): true {
  json(res, status, { error: { code, message, ...(hint ? { hint } : {}) } });
  return true;
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

/** The call log as counts per tool and the latest errors. */
export function activity(calls: CallEntry[]): Account['activity'] {
  const tools = new Map<string, { tool: string; calls: number; failed: number; jobs: number }>();
  let last: string | null = null;
  const errors: Account['activity']['recent_errors'] = [];
  for (const c of calls) {
    const row = tools.get(c.tool) ?? { tool: c.tool, calls: 0, failed: 0, jobs: 0 };
    tools.set(c.tool, row);
    // A job's end has a status; a tool call has none.
    if (c.status) row.jobs += 1;
    else {
      row.calls += 1;
      if (!last || c.at > last) last = c.at;
    }
    if (!c.ok) {
      row.failed += 1;
      if (c.error) errors.push({ at: c.at, tool: c.tool, ...c.error });
    }
  }
  const rows = [...tools.values()].sort((a, b) => b.calls - a.calls || b.jobs - a.jobs);
  const sum = (k: 'calls' | 'failed' | 'jobs') => rows.reduce((n, r) => n + r[k], 0);
  const days = [...new Set(calls.filter((c) => !c.status).map((c) => c.at.slice(0, 10)))].sort();
  let streak = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    const gap = i ? (Date.parse(days[i] ?? '') - Date.parse(days[i - 1] ?? '')) / 86_400_000 : 0;
    run = gap === 1 ? run + 1 : 1;
    streak = Math.max(streak, run);
  }
  return {
    active_days: days.length,
    longest_streak: streak,
    calls: sum('calls'),
    failed: sum('failed'),
    jobs: sum('jobs'),
    last_call_at: last,
    tools: rows,
    recent_errors: errors.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
  };
}

/** Jobs refused for want of credits in the call log; null when none. */
export function outOfCredits(calls: CallEntry[]): Account['out_of_credits'] {
  const refused = calls.filter((c) => c.error?.code === 'quota_exceeded');
  const first = refused[0];
  const last = refused.at(-1);
  return first && last ? { first_at: first.at, last_at: last.at, refusals: refused.length } : null;
}

/** Credits spent per tool since the account began, from the server's meter. */
async function spend(ws: Runtime['ws'], owner: string): Promise<Account['spend']> {
  const tools = new Map<string, { tool: string; credits: number; jobs: number }>();
  for await (const entry of meterEntries(ws, owner, new Date(0))) {
    const row = tools.get(entry.tool) ?? { tool: entry.tool, credits: 0, jobs: 0 };
    tools.set(entry.tool, row);
    row.credits += billedSeconds(entry) / 60;
    row.jobs += 1;
  }
  return [...tools.values()]
    .map((r) => ({ ...r, credits: Math.round(r.credits * 1000) / 1000 }))
    .sort((a, b) => b.credits - a.credits);
}

/** Video exports that ran, since the account began, from the server's meter. */
async function countExports(ws: Runtime['ws'], owner: string): Promise<number> {
  let n = 0;
  for await (const entry of meterEntries(ws, owner, new Date(0)))
    if (entry.tool === 'export.video') n += 1;
  return n;
}

/** A ledger entry as the admin API shows it: without the owner, which the path names. */
function ledgerEntry(e: CreditEntry): AdminLedgerEntry {
  return {
    id: e.id,
    kind: e.kind,
    credits: e.credits,
    at: e.at,
    balance: e.balance,
    ...(e.tool ? { tool: e.tool } : {}),
    ...(e.pack ? { pack: e.pack } : {}),
    ...(e.payment_intent ? { payment_intent: e.payment_intent } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
    ...(e.by ? { by: e.by } : {}),
  };
}
