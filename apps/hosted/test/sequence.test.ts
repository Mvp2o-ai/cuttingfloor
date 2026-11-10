import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspace } from '@cuttingfloor/core';
import { FREE_CREDITS } from '@cuttingfloor/plans';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailError, type EmailProvider, type OutboundEmail } from '../src/email.ts';
import {
  appName,
  isNoReply,
  loadTemplate,
  Sequence,
  type SequenceOptions,
  type Subscriber,
  type Subscribers,
} from '../src/sequence.ts';

// The sign-up sequence against a fake account source and a fake provider: who gets which email
// when, that nothing goes twice, and that suppression is decided at the moment of sending.

const TEMPLATES = fileURLToPath(new URL('../email/', import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EVENTS_SECRET = `whsec_${Buffer.from('events-secret-0123456789').toString('base64')}`;
const T0 = Date.parse('2026-11-01T12:00:00Z');

class FakeAccounts implements Subscribers {
  users = new Map<
    string,
    Subscriber & { firstEditAt?: string; firstClient?: string; deleted?: boolean }
  >();
  credits = new Map<string, number | null>();

  add(
    n: number,
    createdAt: number,
    extra: { verified?: boolean; firstEditAt?: string; firstClient?: string } = {},
  ) {
    const id = `user_${String(n).padStart(26, '0')}`;
    this.users.set(id, {
      id,
      email: `person${n}@example.com`,
      createdAt: new Date(createdAt).toISOString(),
      verified: extra.verified ?? true,
      ...(extra.firstEditAt ? { firstEditAt: extra.firstEditAt } : {}),
      ...(extra.firstClient ? { firstClient: extra.firstClient } : {}),
    });
    return id;
  }

  async *createdSince(since: number) {
    const live = [...this.users.values()].filter((u) => !u.deleted);
    live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const u of live) {
      if (Date.parse(u.createdAt) < since) return;
      yield { id: u.id, email: u.email, createdAt: u.createdAt, verified: u.verified };
    }
  }

  async current(id: string) {
    const u = this.users.get(id);
    if (!u || u.deleted) return undefined;
    return {
      email: u.email,
      ...(u.firstEditAt ? { firstEditAt: u.firstEditAt } : {}),
      ...(u.firstClient ? { firstClient: u.firstClient } : {}),
    };
  }
}

class FakeProvider implements EmailProvider {
  sent: OutboundEmail[] = [];
  fail: EmailError | undefined;

  async send(email: OutboundEmail) {
    if (this.fail) throw this.fail;
    this.sent.push(email);
    return { id: `msg_${this.sent.length}` };
  }
}

async function setup(overrides: Partial<SequenceOptions> = {}) {
  const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-sequence-')));
  const accounts = new FakeAccounts();
  const provider = new FakeProvider();
  const options: SequenceOptions = {
    ws,
    subscribers: accounts,
    provider,
    from: 'Ken at cuttingfloor <ken@cuttingfloor.ai>',
    replyTo: 'support@cuttingfloor.ai',
    signer: 'Ken',
    publicUrl: 'https://api.cuttingfloor.ai',
    unsubscribeSecret: 'unsubscribe-secret',
    followUpAfterMs: 3 * DAY,
    creditsAfterMs: 7 * DAY,
    creditsLeft: async (owner) => {
      const left = accounts.credits.get(owner);
      return left === undefined ? 23.1 : left;
    },
    pollMs: 30_000,
    templatesDir: TEMPLATES,
    eventsSecret: EVENTS_SECRET,
    ...overrides,
  };
  return { ws, accounts, provider, options, sequence: new Sequence(options) };
}

async function logEntries(ws: Workspace) {
  const entries: Record<string, unknown>[] = [];
  for (const day of await ws.list(ws.path('email-log')))
    for (const file of await readdir(ws.path('email-log', day)))
      entries.push(JSON.parse(await readFile(ws.path('email-log', day, file), 'utf8')));
  return entries;
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function serve(sequence: Sequence) {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void sequence.route(req, res, url).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('welcome', () => {
  it('goes once to a new, confirmed account, from a person, with a reply-to and one-click unsubscribe', async () => {
    const { ws, accounts, provider, sequence } = await setup();
    const id = accounts.add(1, T0 - 20_000);
    accounts.add(2, T0 - 10_000, { verified: false });
    await sequence.tick(T0);
    await sequence.tick(T0 + 30_000);
    expect(provider.sent).toHaveLength(1);
    const [mail] = provider.sent;
    expect(mail?.to).toBe('person1@example.com');
    expect(mail?.subject).toBe("You're in - start with one clip");
    expect(mail?.from).toBe('Ken at cuttingfloor <ken@cuttingfloor.ai>');
    expect(mail?.replyTo).toBe('support@cuttingfloor.ai');
    expect(mail?.text).toContain('what are you hoping to edit?');
    expect(mail?.text).toContain('https://github.com/Mvp2o-ai/cuttingfloor');
    expect(mail?.text).toMatch(/\nKen\n/);
    const unsubscribe = sequence.unsubscribeUrl(id);
    expect(mail?.text).toContain(unsubscribe);
    expect(mail?.headers['List-Unsubscribe']).toBe(`<${unsubscribe}>`);
    expect(mail?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail?.text).not.toContain('{{');
    expect(mail?.text).toContain(`You start with ${FREE_CREDITS} free credits`);

    const [entry] = await logEntries(ws);
    expect(entry).toMatchObject({
      subscriber: id,
      message: 'welcome',
      template: 'welcome',
      template_version: '2',
      provider_message_id: 'msg_1',
      outcome: 'sent',
    });
    expect(typeof entry?.at).toBe('string');
    expect(JSON.stringify(entry)).not.toContain('@example.com');
  });

  it('goes once even when two servers send at the same moment', async () => {
    const { accounts, provider, options } = await setup();
    accounts.add(1, T0 - 1000);
    const a = new Sequence(options);
    const b = new Sequence(options);
    await Promise.all([a.tick(T0), b.tick(T0), a.tick(T0 + 1), b.tick(T0 + 1)]);
    expect(provider.sent).toHaveLength(1);
  });

  it('goes again after a failure that may pass, never after one that won’t', async () => {
    const { ws, accounts, provider, sequence } = await setup();
    accounts.add(1, T0 - 1000);
    provider.fail = new EmailError('Resend 503', false);
    await sequence.tick(T0);
    provider.fail = undefined;
    await sequence.tick(T0 + 30_000);
    expect(provider.sent).toHaveLength(1);

    accounts.add(2, T0 + 40_000);
    provider.fail = new EmailError('Resend 422: invalid to', true);
    await sequence.tick(T0 + 60_000);
    provider.fail = undefined;
    await sequence.tick(T0 + 90_000);
    expect(provider.sent.map((m) => m.to)).toEqual(['person1@example.com']);
    const outcomes = (await logEntries(ws)).map((e) => e.outcome).sort();
    expect(outcomes).toEqual(['failed', 'failed', 'sent']);
  });

  it('skips an account that already had the welcome the lifecycle sent before this', async () => {
    const { ws, accounts, provider, sequence } = await setup();
    const id = accounts.add(1, T0 - 1000);
    await ws.writeJson(ws.ownerDir(id, 'notices', 'welcome.json'), { at: 'earlier' });
    await sequence.tick(T0);
    await sequence.tick(T0 + 3 * DAY);
    expect(provider.sent).toHaveLength(0);
  });
});

describe('follow-up', () => {
  it('asks whether it worked when there is no first edit, after the configured time', async () => {
    const { accounts, provider, sequence } = await setup();
    accounts.add(1, T0);
    await sequence.tick(T0 + 1000);
    await sequence.tick(T0 + 3 * DAY - HOUR);
    expect(provider.sent.map((m) => m.subject)).toEqual(["You're in - start with one clip"]);
    await sequence.tick(T0 + 3 * DAY + 60_000);
    expect(provider.sent.map((m) => m.subject)).toEqual([
      "You're in - start with one clip",
      'Did it work?',
    ]);
    expect(provider.sent[1]?.text).toContain('https://cuttingfloor.ai/welcome');
  });

  it('asks how the first edit went after one, with no link but the unsubscribe', async () => {
    const { accounts, provider, sequence } = await setup();
    const id = accounts.add(1, T0);
    await sequence.tick(T0 + 1000);
    const user = accounts.users.get(id);
    if (user) user.firstEditAt = new Date(T0 + HOUR).toISOString();
    await sequence.tick(T0 + 3 * DAY + 60_000);
    const mail = provider.sent[1];
    expect(mail?.subject).toBe('How was the first edit?');
    const links = mail?.text.match(/https?:\/\/\S+/g) ?? [];
    expect(links).toEqual([sequence.unsubscribeUrl(id)]);
  });

  it('is one email, never both, never a second', async () => {
    const { ws, accounts, provider, options } = await setup();
    const id = accounts.add(1, T0);
    await new Sequence(options).tick(T0 + 1000);
    await new Sequence(options).tick(T0 + 3 * DAY);
    const user = accounts.users.get(id);
    if (user) user.firstEditAt = new Date(T0 + 3 * DAY + HOUR).toISOString();
    await new Sequence(options).tick(T0 + 4 * DAY);
    await new Sequence(options).tick(T0 + 4 * DAY + 1);
    expect(provider.sent.map((m) => m.subject)).toEqual([
      "You're in - start with one clip",
      'Did it work?',
    ]);
    const claim = await ws.readJson(ws.ownerDir(id, 'email', 'follow-up.json'));
    expect(claim).toMatchObject({ outcome: 'sent', template: 'follow-up-no-edit' });
  });

  it('follows the configured delay', async () => {
    const { accounts, provider, sequence } = await setup({ followUpAfterMs: 2 * HOUR });
    accounts.add(1, T0);
    await sequence.tick(T0 + 1000);
    await sequence.tick(T0 + 2 * HOUR + 1000);
    expect(provider.sent.map((m) => m.subject)).toEqual([
      "You're in - start with one clip",
      'Did it work?',
    ]);
  });

  it('goes only to accounts whose welcome went out', async () => {
    const { accounts, provider, sequence } = await setup();
    accounts.add(1, T0 - 3 * DAY - HOUR);
    await sequence.tick(T0);
    expect(provider.sent).toHaveLength(0);
  });
});

describe('credits reminder', () => {
  const subject = 'Your cuttingfloor credits are waiting';

  it('goes once, a week in, with the whole credits left and the app the account edits from', async () => {
    const { ws, accounts, provider, options } = await setup();
    const id = accounts.add(1, T0, { firstClient: 'openai-mcp' });
    await new Sequence(options).tick(T0 + 1000);
    await new Sequence(options).tick(T0 + 7 * DAY - HOUR);
    expect(provider.sent.map((m) => m.subject)).not.toContain(subject);
    await new Sequence(options).tick(T0 + 7 * DAY + 60_000);
    await new Sequence(options).tick(T0 + 8 * DAY);
    const reminders = provider.sent.filter((m) => m.subject === subject);
    expect(reminders).toHaveLength(1);
    const text = reminders[0]?.text ?? '';
    expect(text).toContain('You still have 23 credits');
    expect(text).toContain('Pick up where you left off in ChatGPT');
    expect(text).not.toContain('apifunnel');
    expect(text).toContain('https://api.cuttingfloor.ai/openapi.json');
    expect(text).toContain(new Sequence(options).unsubscribeUrl(id));
    const claim = await ws.readJson(ws.ownerDir(id, 'email', 'credits.json'));
    expect(claim).toMatchObject({ outcome: 'sent', template: 'credits-app' });
  });

  it('sends an account with no AI app of its own to Kazi, tagged for attribution', async () => {
    const { accounts, provider, sequence } = await setup();
    for (const [n, client] of [
      [1, undefined],
      [2, 'rest'],
      [3, 'kazi'],
    ] as const)
      accounts.add(n, T0, client ? { firstClient: client } : {});
    await sequence.tick(T0 + 1000);
    await sequence.tick(T0 + 7 * DAY + 60_000);
    const reminders = provider.sent.filter((m) => m.subject === subject);
    expect(reminders).toHaveLength(3);
    for (const mail of reminders) {
      expect(mail.text).toContain('Pick up where you left off in Kazi');
      expect(mail.text).toMatch(
        /https:\/\/app\.apifunnel\.ai\/\S*offer=cuttingfloor\S*utm_campaign=credits-drip/,
      );
    }
  });

  it('goes to nobody with less than one credit left or no balance, and only after a welcome', async () => {
    const { ws, accounts, provider, sequence } = await setup();
    const spent = accounts.add(1, T0);
    const capless = accounts.add(2, T0);
    accounts.credits.set(spent, 0.4);
    accounts.credits.set(capless, null);
    accounts.add(3, T0 - 7 * DAY - HOUR);
    await sequence.tick(T0 + 1000);
    await sequence.tick(T0 + 7 * DAY + 60_000);
    expect(provider.sent.filter((m) => m.subject === subject)).toHaveLength(0);
    expect(await ws.readJson(ws.ownerDir(spent, 'email', 'credits.json'))).toMatchObject({
      outcome: 'suppressed',
      reason: 'no_credits_left',
    });
    expect(await ws.readJson(ws.ownerDir(capless, 'email', 'credits.json'))).toMatchObject({
      outcome: 'suppressed',
      reason: 'no_balance',
    });
  });

  it('names the app from its first tool call', () => {
    expect(appName('openai-mcp')).toBe('ChatGPT');
    expect(appName('codex-mcp-client')).toBe('Codex');
    expect(appName('claude-code')).toBe('Claude');
    expect(appName('Anthropic/Toolbox')).toBe('Claude');
    expect(appName('instinct-video-pilot')).toBe('your AI app');
    expect(appName('rest')).toBeUndefined();
    expect(appName('kazi')).toBeUndefined();
    expect(appName(undefined)).toBeUndefined();
  });
});

describe('suppression, at the moment of sending', () => {
  it('honours the unsubscribe link at once, and a mail client’s one-click POST', async () => {
    const { ws, accounts, provider, sequence } = await setup();
    const one = accounts.add(1, T0);
    const two = accounts.add(2, T0);
    await sequence.tick(T0 + 1000);
    const base = await serve(sequence);
    const link = (id: string) =>
      sequence.unsubscribeUrl(id).replace('https://api.cuttingfloor.ai', base);

    const clicked = await fetch(link(one));
    expect(clicked.status).toBe(200);
    expect(await clicked.text()).toContain('unsubscribed');
    const posted = await fetch(link(two), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(posted.status).toBe(200);
    expect((await fetch(link(two))).status).toBe(200);

    const forged = await fetch(`${base}/email/unsubscribe?u=${one}&t=forged`);
    expect(forged.status).toBe(400);

    await sequence.tick(T0 + 3 * DAY + 60_000);
    expect(provider.sent).toHaveLength(2);
    const reasons = (await logEntries(ws)).filter((e) => e.outcome === 'suppressed');
    expect(reasons.map((e) => e.reason)).toEqual(['unsubscribed', 'unsubscribed']);
  });

  it('suppresses a bounced or complained address from Resend’s signed events, by its hash', async () => {
    const { ws, accounts, provider, sequence } = await setup();
    accounts.add(1, T0);
    accounts.add(2, T0);
    await sequence.tick(T0 + 1000);
    const base = await serve(sequence);
    const post = (body: string, secret = EVENTS_SECRET) => {
      const id = 'msg_evt';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
      const signature = createHmac('sha256', key)
        .update(`${id}.${timestamp}.${body}`)
        .digest('base64');
      return fetch(`${base}/email/events`, {
        method: 'POST',
        headers: {
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        },
        body,
      });
    };
    const event = (type: string, to: string) =>
      JSON.stringify({ type, data: { email_id: 'e1', to: [to] } });
    const forged = `whsec_${Buffer.from('not the secret').toString('base64')}`;
    expect((await post(event('email.bounced', 'person1@example.com'), forged)).status).toBe(400);
    expect((await post(event('email.bounced', 'Person1@Example.com'))).status).toBe(200);
    expect((await post(event('email.complained', 'person2@example.com'))).status).toBe(200);
    expect((await post(event('email.delivered', 'person2@example.com'))).status).toBe(200);
    const stored = await readdir(ws.path('email-suppressions'));
    expect(stored).toHaveLength(2);
    for (const file of stored)
      expect(await readFile(ws.path('email-suppressions', file), 'utf8')).not.toContain('@');

    await sequence.tick(T0 + 3 * DAY + 60_000);
    expect(provider.sent).toHaveLength(2);
    const reasons = (await logEntries(ws)).filter((e) => e.outcome === 'suppressed');
    expect(reasons.map((e) => e.reason).sort()).toEqual(['bounced', 'complained']);
  });

  it('sends nothing to a deleted account', async () => {
    const { accounts, provider, sequence, ws } = await setup();
    const id = accounts.add(1, T0);
    await sequence.tick(T0 + 1000);
    const user = accounts.users.get(id);
    if (user) user.deleted = true;
    // Deleted after it was found: the check at sending still stops it.
    accounts.createdSince = async function* () {
      yield {
        id,
        email: 'person1@example.com',
        createdAt: new Date(T0).toISOString(),
        verified: true,
      };
    };
    await sequence.tick(T0 + 3 * DAY + 60_000);
    expect(provider.sent).toHaveLength(1);
    const last = (await logEntries(ws)).find((e) => e.message === 'follow-up');
    expect(last).toMatchObject({ outcome: 'suppressed', reason: 'account_deleted' });
  });
});

describe('templates and configuration', () => {
  it('reads the copy from the template files at every send', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-templates-'));
    for (const name of ['welcome', 'follow-up-no-edit', 'follow-up-first-edit'])
      await writeFile(join(dir, `${name}.txt`), await readFile(join(TEMPLATES, `${name}.txt`)));
    const { ws, accounts, provider, sequence } = await setup({ templatesDir: dir });
    accounts.add(1, T0);
    await writeFile(
      join(dir, 'welcome.txt'),
      'version: 2\nsubject: Edited without a deploy\n---\nHi.\n\n{{signer}}\n\n{{unsubscribe_url}}\n',
    );
    await sequence.tick(T0 + 1000);
    expect(provider.sent[0]?.subject).toBe('Edited without a deploy');
    expect((await logEntries(ws))[0]).toMatchObject({ template_version: '2' });
  });

  it('refuses a template without its unsubscribe link or with an unknown placeholder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-templates-'));
    await writeFile(join(dir, 'welcome.txt'), 'version: 1\nsubject: Hi\n---\nNo way out.\n');
    await expect(loadTemplate(dir, 'welcome')).rejects.toThrow(/unsubscribe_url/);
    await writeFile(
      join(dir, 'welcome.txt'),
      'version: 1\nsubject: Hi\n---\n{{name}} {{unsubscribe_url}}\n',
    );
    await expect(loadTemplate(dir, 'welcome')).rejects.toThrow(/unknown/);
  });

  it('every bundled template loads', async () => {
    for (const name of [
      'follow-up-no-edit',
      'follow-up-first-edit',
      'credits-app',
      'credits-kazi',
    ] as const)
      expect((await loadTemplate(TEMPLATES, name)).version).toBe('1');
    // Version 2 says a new account's free credits from the plans, not a number of its own.
    const welcome = await loadTemplate(TEMPLATES, 'welcome');
    expect(welcome.version).toBe('2');
    expect(welcome.body).toContain('You start with {{free_credits}} free credits');
  });

  it('refuses a noreply sender or reply-to', async () => {
    expect(isNoReply('noreply@cuttingfloor.ai')).toBe(true);
    expect(isNoReply('cuttingfloor <no-reply@cuttingfloor.ai>')).toBe(true);
    expect(isNoReply('DoNotReply@x.io')).toBe(true);
    expect(isNoReply('Ken <ken@cuttingfloor.ai>')).toBe(false);
    expect(isNoReply('support@cuttingfloor.ai')).toBe(false);
    await expect(setup({ from: 'cuttingfloor <noreply@cuttingfloor.ai>' })).rejects.toThrow(
      /noreply/,
    );
  });
});
