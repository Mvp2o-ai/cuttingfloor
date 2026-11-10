import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Workspace } from '@cuttingfloor/core';
import { FREE_CREDITS } from '@cuttingfloor/plans';
import { EmailError, type EmailProvider } from './email.ts';
import { madeByPartner } from './lifecycle.ts';

// The sign-up sequence: a welcome within a minute of signing up, then exactly one follow-up a
// configured time later, chosen by whether the account has finished a first edit. Two sends per
// person, never three:
// - Each send first claims `owners/{owner}/email/{welcome|follow-up}.json` with an exclusive
//   create: the data layer's unique constraint on (owner, message). Both follow-ups share one
//   slot, so an account can never get both. These records have no TTL: one welcome, ever.
// - A follow-up goes only to an account whose welcome went out.
// - Whether to send is decided at dispatch, not when the account is found: a deleted account,
//   an unsubscribe, a bounced or complained address, or a message already received stops it.
// - Bodies are versioned text files (apps/hosted/email, or CUTTINGFLOOR_EMAIL_TEMPLATES), read
//   again at every send, so a copy edit there needs no deploy.
// - Every attempt is logged, by account id and never by address, under
//   `email-log/{yyyy-mm-dd}/…` (kept 400 days).
// - `GET`/`POST /email/unsubscribe` is the signed one-click unsubscribe (RFC 8058 for the POST);
//   `POST /email/events` takes Resend's bounces and complaints and suppresses the address.

/** An account's message in the sequence; the follow-up is one slot whichever variant it is. */
export type Slot = 'welcome' | 'follow-up';
export type TemplateName = 'welcome' | 'follow-up-no-edit' | 'follow-up-first-edit';

export interface Subscriber {
  id: string;
  email: string;
  createdAt: string;
  verified: boolean;
}

/** Where sign-ups and their first edits are read from. */
export interface Subscribers {
  /** Accounts made at or after `since` (ms since the epoch), newest first. */
  createdSince(since: number): AsyncIterable<Subscriber>;
  /** The account as it is now, or undefined once it is deleted. */
  current(id: string): Promise<{ email: string; firstEditAt?: string } | undefined>;
}

export interface SequenceOptions {
  ws: Workspace;
  subscribers: Subscribers;
  provider: EmailProvider;
  /** The sender, e.g. `Ken at cuttingfloor <ken@cuttingfloor.ai>`. Never a noreply address. */
  from: string;
  /** A monitored inbox: the sequence asks for replies. */
  replyTo: string;
  /** The person who signs the emails. */
  signer: string;
  /** This server's public address; unsubscribe links point at it. */
  publicUrl: string;
  /** Signs unsubscribe links. */
  unsubscribeSecret: string;
  /** How long after signing up the follow-up goes. */
  followUpAfterMs: number;
  /** How often new accounts are looked for; a welcome goes out within about this. */
  pollMs: number;
  templatesDir: string;
  /** Resend's webhook signing secret (whsec_…). Without it, bounces and complaints aren't heard. */
  eventsSecret?: string;
}

// An account still gets its welcome up to a day after signing up (the server was down, say), and
// its follow-up up to two days late.
const WELCOME_WINDOW_MS = 86_400_000;
const FOLLOW_UP_WINDOW_MS = 2 * 86_400_000;
// Follow-ups are due by the hour, not the second: looked for less often than welcomes.
const FOLLOW_UP_SCAN_MS = 10 * 60_000;
const LOG_TTL_MS = 400 * 86_400_000;
const PLACEHOLDERS = new Set(['signer', 'unsubscribe_url', 'free_credits']);

interface Claim {
  slot: Slot;
  outcome: 'sending' | 'sent' | 'suppressed' | 'failed';
  at: string;
  template?: TemplateName;
  template_version?: string;
  provider_message_id?: string;
  reason?: string;
}

export class Sequence {
  #o: SequenceOptions;
  #followUpsAt = Number.NEGATIVE_INFINITY;
  #running = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: SequenceOptions) {
    for (const address of [options.from, options.replyTo])
      if (isNoReply(address)) throw new Error(`${address} is a noreply address; replies must land`);
    this.#o = options;
  }

  start(): void {
    const tick = () => {
      if (this.#running) return;
      this.#running = true;
      void this.tick()
        .catch((error: Error) => process.stderr.write(`sequence: ${error.message}\n`))
        .finally(() => {
          this.#running = false;
        });
    };
    tick();
    this.#timer = setInterval(tick, this.#o.pollMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Sends what is due: welcomes every time, follow-ups every ten minutes. */
  async tick(now = Date.now()): Promise<void> {
    const { subscribers } = this.#o;
    for await (const user of subscribers.createdSince(now - WELCOME_WINDOW_MS)) {
      // An address nobody has confirmed yet gets nothing; its welcome goes once it is.
      if (user.verified) await this.#dispatchLogged(user.id, 'welcome');
    }
    if (now - this.#followUpsAt < FOLLOW_UP_SCAN_MS) return;
    this.#followUpsAt = now;
    const due = now - this.#o.followUpAfterMs;
    for await (const user of subscribers.createdSince(due - FOLLOW_UP_WINDOW_MS)) {
      if (Date.parse(user.createdAt) <= due) await this.#dispatchLogged(user.id, 'follow-up');
    }
    const ws = this.#o.ws;
    await ws.sweep(ws.path('email-log'), LOG_TTL_MS);
  }

  /** The signed link that unsubscribes this account in one click. */
  unsubscribeUrl(owner: string): string {
    const query = new URLSearchParams({ u: owner, t: this.#token(owner) });
    return `${this.#o.publicUrl}/email/unsubscribe?${query}`;
  }

  /** `GET`/`POST /email/unsubscribe` and `POST /email/events`; false for any other path. */
  async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/email/unsubscribe') {
      await this.#unsubscribeRoute(req, res, url);
      return true;
    }
    if (url.pathname === '/email/events' && req.method === 'POST') {
      await this.#eventsRoute(req, res);
      return true;
    }
    return false;
  }

  async #dispatchLogged(owner: string, slot: Slot): Promise<void> {
    try {
      await this.#dispatch(owner, slot);
    } catch (error) {
      process.stderr.write(`sequence: ${owner} ${slot}: ${(error as Error).message}\n`);
    }
  }

  async #dispatch(owner: string, slot: Slot): Promise<void> {
    const { ws } = this.#o;
    if (slot === 'follow-up') {
      const welcome = await ws.readJson<Claim>(ws.ownerDir(owner, 'email', 'welcome.json'));
      if (welcome?.outcome !== 'sent') return;
    }
    const file = ws.ownerDir(owner, 'email', `${slot}.json`);
    const claim: Claim = { slot, outcome: 'sending', at: new Date().toISOString() };
    if (!(await ws.writeJson(file, claim, { exclusive: true }))) return;
    let sent = false;
    try {
      const state = await this.#o.subscribers.current(owner);
      const reason = state ? await this.#suppressed(owner, slot, state.email) : 'account_deleted';
      if (!state || reason) {
        await this.#settle(owner, file, { ...claim, outcome: 'suppressed', reason: reason ?? '' });
        return;
      }
      const name: TemplateName =
        slot === 'welcome'
          ? 'welcome'
          : state.firstEditAt
            ? 'follow-up-first-edit'
            : 'follow-up-no-edit';
      const template = await loadTemplate(this.#o.templatesDir, name);
      const unsubscribe = this.unsubscribeUrl(owner);
      const sending = { ...claim, template: name, template_version: template.version };
      try {
        const message = await this.#o.provider.send({
          from: this.#o.from,
          to: state.email,
          replyTo: this.#o.replyTo,
          subject: template.subject,
          text: render(template.body, {
            signer: this.#o.signer,
            unsubscribe_url: unsubscribe,
            free_credits: String(FREE_CREDITS),
          }),
          headers: {
            'List-Unsubscribe': `<${unsubscribe}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
          idempotencyKey: `sequence:${owner}:${slot}`,
        });
        sent = true;
        await this.#settle(owner, file, {
          ...sending,
          outcome: 'sent',
          provider_message_id: message.id,
        });
      } catch (error) {
        if (sent || !(error instanceof EmailError && error.permanent)) throw error;
        await this.#settle(owner, file, { ...sending, outcome: 'failed', reason: error.message });
      }
    } catch (error) {
      // Once sent, the claim stays whatever went wrong after. Otherwise it goes, so the next tick
      // tries again: WorkOS or the provider may answer then.
      if (!sent) {
        await this.#log(owner, { ...claim, outcome: 'failed', reason: (error as Error).message });
        await ws.remove(file);
      }
      throw error;
    }
  }

  /** Why this message must not go to this account now, if it mustn't. */
  async #suppressed(owner: string, slot: Slot, email: string): Promise<string | undefined> {
    const { ws } = this.#o;
    if (await ws.readJson(ws.ownerDir(owner, 'email', 'unsubscribed.json'))) return 'unsubscribed';
    const blocked = await ws.readJson<{ reason: string }>(suppressionFile(ws, email));
    if (blocked) return blocked.reason;
    // Accounts made before this sequence got the lifecycle's welcome instead.
    if (slot === 'welcome' && (await ws.readJson(ws.ownerDir(owner, 'notices', 'welcome.json'))))
      return 'already_received';
    return undefined;
  }

  /** Records how a claimed send ended, on the claim and in the send log. */
  async #settle(owner: string, file: string, claim: Claim): Promise<void> {
    await this.#o.ws.writeJson(file, { ...claim, at: new Date().toISOString() });
    await this.#log(owner, claim);
  }

  async #log(owner: string, claim: Claim): Promise<void> {
    const at = new Date().toISOString();
    const entry = {
      at,
      subscriber: owner,
      message: claim.slot,
      template: claim.template ?? null,
      template_version: claim.template_version ?? null,
      provider_message_id: claim.provider_message_id ?? null,
      outcome: claim.outcome,
      ...(claim.reason ? { reason: claim.reason } : {}),
    };
    process.stderr.write(
      `sequence: ${owner} ${claim.slot} ${claim.outcome}${claim.template ? ` ${claim.template}@${claim.template_version}` : ''}${claim.provider_message_id ? ` ${claim.provider_message_id}` : ''}${claim.reason ? ` (${claim.reason})` : ''}\n`,
    );
    const ws = this.#o.ws;
    await ws.writeJson(
      ws.path(
        'email-log',
        at.slice(0, 10),
        `${at.slice(11, 19).replaceAll(':', '')}-${randomBytes(4).toString('hex')}.json`,
      ),
      entry,
      { exclusive: true },
    );
  }

  #token(owner: string): string {
    return createHmac('sha256', this.#o.unsubscribeSecret)
      .update(`unsubscribe\n${owner}`)
      .digest('base64url');
  }

  /**
   * The unsubscribe link from the email (GET) and mail clients' one-click (POST, RFC 8058): either
   * unsubscribes at once.
   */
  async #unsubscribeRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST')
      return page(res, 405, 'Use the link from the email.');
    const owner = url.searchParams.get('u') ?? '';
    const token = url.searchParams.get('t') ?? '';
    if (!owner || !same(token, this.#token(owner)))
      return page(
        res,
        400,
        'This unsubscribe link isn’t valid. Reply to any of our emails instead and we’ll take you off.',
      );
    if (req.method === 'POST') await readBody(req, 4096).catch(() => '');
    const ws = this.#o.ws;
    await ws.writeJson(
      ws.ownerDir(owner, 'email', 'unsubscribed.json'),
      { at: new Date().toISOString() },
      { exclusive: true },
    );
    page(res, 200, 'You’re unsubscribed. cuttingfloor won’t send you these emails again.');
  }

  /** Resend's webhook (signed by Svix): a bounce or a complaint suppresses the address for good. */
  async #eventsRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secret = this.#o.eventsSecret;
    if (!secret) return json(res, 503, { error: 'email events are off on this server' });
    const body = await readBody(req, 256 * 1024);
    const header = (name: string) => String(req.headers[name] ?? '');
    if (
      !verifySvix(
        body,
        header('svix-id'),
        header('svix-timestamp'),
        header('svix-signature'),
        secret,
      )
    )
      return json(res, 400, { error: 'bad signature' });
    let event: { type?: string; data?: { email_id?: string; to?: string[] | string } };
    try {
      event = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'body must be JSON' });
    }
    const reason =
      event.type === 'email.bounced'
        ? 'bounced'
        : event.type === 'email.complained'
          ? 'complained'
          : undefined;
    if (!reason) return json(res, 200, { ignored: true });
    const to = event.data?.to;
    const ws = this.#o.ws;
    for (const address of Array.isArray(to) ? to : to ? [to] : []) {
      await ws.writeJson(suppressionFile(ws, address), {
        reason,
        at: new Date().toISOString(),
        email_id: event.data?.email_id ?? null,
      });
    }
    json(res, 200, { received: true });
  }
}

export interface Template {
  version: string;
  subject: string;
  body: string;
}

/**
 * A template file: `version:` and `subject:` lines, a `---` line, then the plain-text body. The
 * body may use `{{signer}}` and `{{free_credits}}` (a new account's, from the plans) and must carry
 * `{{unsubscribe_url}}`.
 */
export async function loadTemplate(dir: string, name: TemplateName): Promise<Template> {
  const text = (await readFile(join(dir, `${name}.txt`), 'utf8')).replaceAll('\r\n', '\n');
  const split = text.indexOf('\n---\n');
  if (split < 0) throw new Error(`template ${name}: no --- line between header and body`);
  const header = new Map(
    text
      .slice(0, split)
      .split('\n')
      .map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as const;
      }),
  );
  const version = header.get('version');
  const subject = header.get('subject');
  if (!version || !subject) throw new Error(`template ${name}: needs version: and subject:`);
  const body = `${text.slice(split + 5).trim()}\n`;
  for (const [, key] of body.matchAll(/\{\{\s*(\w+)\s*\}\}/g))
    if (!PLACEHOLDERS.has(key ?? '')) throw new Error(`template ${name}: unknown {{${key}}}`);
  if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(body))
    throw new Error(`template ${name}: must carry {{unsubscribe_url}}`);
  return { version, subject, body };
}

function render(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => values[key] ?? '');
}

/** Sign-ups and first edits from WorkOS: accounts, and `first_edit_at` in their metadata. */
export class WorkosSubscribers implements Subscribers {
  #key: string;

  constructor(workosKey: string) {
    this.#key = workosKey;
  }

  async *createdSince(since: number): AsyncGenerator<Subscriber> {
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams({
        limit: '100',
        order: 'desc',
        ...(after ? { after } : {}),
      });
      const res = await this.#get(`/user_management/users?${query}`);
      const list = (await res.json()) as {
        data?: {
          id: string;
          email: string;
          email_verified?: boolean;
          created_at: string;
          metadata?: Record<string, string>;
        }[];
        list_metadata?: { after?: string | null };
      };
      for (const user of list.data ?? []) {
        if (Date.parse(user.created_at) < since) return;
        // A partner's users hear from the partner; its app is what they signed up for.
        if (madeByPartner(user.metadata)) continue;
        yield {
          id: user.id,
          email: user.email,
          createdAt: user.created_at,
          verified: user.email_verified !== false,
        };
      }
      after = list.list_metadata?.after ?? undefined;
      if (!after) return;
    }
  }

  async current(id: string): Promise<{ email: string; firstEditAt?: string } | undefined> {
    const res = await this.#get(`/user_management/users/${encodeURIComponent(id)}`, [404]);
    if (res.status === 404) return undefined;
    const user = (await res.json()) as { email: string; metadata?: Record<string, string> };
    const firstEditAt = user.metadata?.first_edit_at;
    return { email: user.email, ...(firstEditAt ? { firstEditAt } : {}) };
  }

  async #get(path: string, allowed: number[] = []): Promise<Response> {
    const res = await fetch(`https://api.workos.com${path}`, {
      headers: { authorization: `Bearer ${this.#key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok && !allowed.includes(res.status))
      throw new Error(`WorkOS ${path.split('?')[0]}: ${res.status}`);
    return res;
  }
}

/** Checks a Svix-signed webhook (Resend's): v1 signatures, five minutes' tolerance. */
export function verifySvix(
  body: string,
  id: string,
  timestamp: string,
  signatures: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!id || !timestamp || !signatures || Math.abs(now / 1000 - Number(timestamp)) > 300)
    return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return signatures.split(' ').some((part) => {
    const [version, signature] = part.split(',');
    return version === 'v1' && same(signature ?? '', expected);
  });
}

/** Whether an address is one nobody reads (noreply@, no-reply@, donotreply@ and the like). */
export function isNoReply(address: string): boolean {
  const mailbox = /<([^>]+)>/.exec(address)?.[1] ?? address;
  return /^(no-?reply|do-?not-?reply)([+.@-]|$)/i.test(mailbox.trim());
}

/** A suppressed address, kept by its hash rather than the address itself. */
function suppressionFile(ws: Workspace, email: string): string {
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  return ws.path('email-suppressions', `${hash}.json`);
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function page(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    })
    .end(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cuttingfloor</title></head><body style="margin:0;padding:48px 16px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111"><p style="max-width:520px;margin:0 auto">${message}</p></body></html>`,
    );
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
