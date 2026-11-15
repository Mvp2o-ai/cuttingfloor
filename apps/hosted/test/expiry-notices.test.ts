import { mkdtemp, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import type { Mailer } from '../src/email.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';

// The file reminder: one email a day naming files going in about 3 days or within a day, off
// once the account turns it off on its account page.

const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ02';
const DAY = 86_400_000;
const metadata: Record<string, string> = {};
const sent: Array<{ subject: string; lines: string[]; key: string }> = [];
let runtime: Runtime;
let lifecycle: Lifecycle;

const realFetch = globalThis.fetch;
beforeAll(async () => {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.workos.com') return realFetch(input, init);
    if (init?.method === 'PUT')
      Object.assign(metadata, (JSON.parse(String(init.body)) as { metadata: object }).metadata);
    return Response.json({ id: USER, email: 'someone@example.com', created_at: '', metadata });
  });
  runtime = new Runtime({
    dataDir: join(await mkdtemp(join(tmpdir(), 'cf-expiry-')), 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 60_000,
    maxDownloadBytes: 1024 ** 2,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  lifecycle = new Lifecycle({
    runtime,
    access: { get: async () => ({ allowed: false }) } as unknown as AccessCheck,
    ledger: new Ledger('http://127.0.0.1:9', 'none'),
    workosKey: 'sk_test_none',
    stripeKey: 'sk_test_none',
    accountUrl: 'https://cuttingfloor.ai/account',
    accountKey: 'site-key-0123456789',
    mailer: { send: async (m: (typeof sent)[number]) => void sent.push(m) } as unknown as Mailer,
  });
});

afterAll(() => vi.unstubAllGlobals());

describe('file reminders', () => {
  it('names files going in 3 days once a day, and stops when turned off', async () => {
    const ws = runtime.ws;
    const file = ws.ownerDir(USER, 'media', 'm_one', 'media.json');
    await ws.writeJson(file, { media_id: 'm_one', name: 'interview.mp4', source: {} });
    const now = Date.parse('2026-11-15T15:05:00Z');
    // Last used 4.5 days ago: it goes in 2.5 days.
    const used = new Date(now - 4.5 * DAY);
    await utimes(file, used, used);

    await lifecycle.sweep(Date.parse('2026-11-15T14:55:00Z'));
    expect(sent).toHaveLength(0);
    await lifecycle.sweep(now);
    await lifecycle.sweep(now + 600_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('A file on cuttingfloor goes in 3 days');
    expect(sent[0]?.lines.join('\n')).toContain('Going in about 3 days:\n• interview.mp4');
    expect(sent[0]?.lines.join('\n')).toContain('https://cuttingfloor.ai/account#notifications');

    const res = await new Promise<{ status: number }>((resolve) => {
      const req = Object.assign(
        (async function* () {
          yield Buffer.from(JSON.stringify({ user: USER, expiry_emails: false }));
        })(),
        { method: 'POST', headers: { authorization: 'Bearer site-key-0123456789' } },
      );
      const out = {
        writeHead: (status: number) => ({ end: () => resolve({ status }) }),
      };
      void lifecycle.route(req as never, out as never, new URL('http://x/account/notifications'));
    });
    expect(res.status).toBe(200);
    expect(metadata.expiry_emails).toBe('off');
    // Two days on it goes within a day, but reminders are off.
    await utimes(file, used, used);
    await lifecycle.sweep(now + 2 * DAY);
    expect(sent).toHaveLength(1);
  });
});
