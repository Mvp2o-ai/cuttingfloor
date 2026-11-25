import { describe, expect, it } from 'vitest';
import { isNew, kaziLink } from '../app/kazi/link.ts';
import { KAZI_LINKS } from '../app/kazi.tsx';

// /kazi's page asks /api/kazi-link for the one-time link into Kazi; the server asks with its key.

function server(answer: Response | Error) {
  const asked: Array<{ url: string; init: RequestInit }> = [];
  const call = (async (url: string, init: RequestInit) => {
    asked.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { asked, call };
}

const ENV = { key: 'k', server: 'https://cf.test' };

describe('the Kazi link', () => {
  it('asks the server with its key for the demos share and answers a Kazi link', async () => {
    const s = server(Response.json({ url: 'https://app.apifunnel.ai/handoff/tok' }));
    expect(await kaziLink('user_1', 'chatgpt', ENV, s.call)).toBe(
      'https://app.apifunnel.ai/handoff/tok',
    );
    expect(s.asked[0]?.url).toBe('https://cf.test/account/kazi-handoff');
    expect(new Headers(s.asked[0]?.init.headers).get('authorization')).toBe('Bearer k');
    expect(JSON.parse(String(s.asked[0]?.init.body))).toEqual({
      user: 'user_1',
      share_code: KAZI_LINKS.demos,
      via: 'chatgpt',
    });
  });

  it('answers no link for a refusal, a failure, a non-Kazi url or no key', async () => {
    expect(
      await kaziLink('u', undefined, ENV, server(new Response('', { status: 502 })).call),
    ).toBeNull();
    expect(await kaziLink('u', undefined, ENV, server(new Error('down')).call)).toBeNull();
    expect(
      await kaziLink(
        'u',
        undefined,
        ENV,
        server(Response.json({ url: 'https://evil.test/x' })).call,
      ),
    ).toBeNull();
    const s = server(Response.json({ url: 'https://app.apifunnel.ai/handoff/tok' }));
    expect(await kaziLink('u', undefined, {}, s.call)).toBeNull();
    expect(s.asked).toHaveLength(0);
  });

  it('leaves out a via that is not an app name', async () => {
    const s = server(Response.json({ url: 'https://app.apifunnel.ai/handoff/tok' }));
    await kaziLink('u', 'Bad Via!', ENV, s.call);
    expect(JSON.parse(String(s.asked[0]?.init.body))).not.toHaveProperty('via');
  });

  it('counts an account as new for ten minutes', () => {
    const now = Date.parse('2026-11-25T16:40:00Z');
    expect(isNew('2026-11-25T16:30:10Z', now)).toBe(true);
    expect(isNew('2026-11-25T16:29:59Z', now)).toBe(false);
  });
});
