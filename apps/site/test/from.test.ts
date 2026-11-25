import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DETECT } from '../app/from.tsx';

// The head script that tells where a visitor came from: it marks the page, and tells Kazi (a
// cookie for /kazi after sign-up, and ?via on the guest demo links).

function visit(search: string, referrer = '') {
  const store = new Map<string, string>();
  const links = [
    { href: 'https://app.apifunnel.ai/s/PsFVYwBiOA' },
    { href: 'https://app.apifunnel.ai/s/2XDlD9QfXx?x=1' },
  ];
  const handlers = new Map<string, (e: unknown) => void>();
  const page = {
    cookie: '',
    referrer,
    documentElement: { dataset: {} as Record<string, string> },
    addEventListener: (type: string, run: (e: unknown) => void) => handlers.set(type, run),
  };
  runInNewContext(DETECT, {
    URL,
    URLSearchParams,
    location: { search },
    document: page,
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: store.set.bind(store),
    },
  });
  // Each link opened, by click, middle click or the menu, after the page has loaded (as on a
  // page reached by a client-side navigation): the text inside it is what is clicked.
  for (const [i, link] of links.entries()) {
    const target = {
      closest: (sel: string) => (sel.includes('app.apifunnel.ai/s/') ? link : null),
    };
    handlers.get(['click', 'auxclick'][i] ?? 'click')?.({ target });
  }
  return { from: page.documentElement.dataset.from, cookie: page.cookie, links };
}

describe('where a visitor came from', () => {
  it('tells Kazi a ChatGPT visitor came from ChatGPT', () => {
    const got = visit('?utm_source=chatgpt.com');
    expect(got.from).toBe('chatgpt');
    expect(got.cookie).toMatch(/^cf-from=chatgpt;/);
    expect(got.links.map((l) => l.href)).toEqual([
      'https://app.apifunnel.ai/s/PsFVYwBiOA?via=chatgpt',
      'https://app.apifunnel.ai/s/2XDlD9QfXx?x=1&via=chatgpt',
    ]);
  });

  it('tells Kazi a Claude visitor came from Claude', () => {
    expect(visit('', 'https://claude.ai/chat/1').cookie).toMatch(/^cf-from=claude;/);
  });

  it('says nothing for anyone else', () => {
    const got = visit('?utm_source=reddit', 'https://www.google.com/');
    expect(got.from).toBeUndefined();
    expect(got.cookie).toBe('');
    expect(got.links[0]?.href).toBe('https://app.apifunnel.ai/s/PsFVYwBiOA');
  });
});
