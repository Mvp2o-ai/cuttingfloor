import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cell } from '../app/lib/markdown.ts';
import {
  markdownRoute,
  prefersMarkdown,
  sectionTwinRoute,
  twinPath,
} from '../app/lib/negotiate.ts';

// The agent-facing layer: which requests get Markdown, that every public page has a twin that
// builds, and the discovery files. The site reads skills/ relative to its own folder, as next does.
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('Markdown table cells', () => {
  it('escapes backslashes before pipes, so a cell can never end a row early', () => {
    expect(cell('a|b')).toBe('a\\|b');
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
    expect(cell('one\n  two')).toBe('one two');
  });
});

describe('Accept negotiation', () => {
  it('chooses Markdown only when it is named and liked at least as much as HTML', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html, */*')).toBe(true);
    expect(prefersMarkdown('text/html;q=0.5, text/markdown')).toBe(true);
    expect(prefersMarkdown('text/x-markdown')).toBe(true);
    expect(prefersMarkdown('text/html, text/markdown;q=0.5')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/*')).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });

  it('maps pages to their twins', () => {
    expect(markdownRoute('/')).toBe('/index.md');
    expect(markdownRoute('/pricing')).toBe('/pricing.md');
    expect(markdownRoute('/demos/a-b')).toBe('/md/demos/a-b');
    expect(markdownRoute('/account')).toBeNull();
    expect(markdownRoute('/demos/a/b')).toBeNull();
    expect(sectionTwinRoute('/skills/x-y.md')).toBe('/md/skills/x-y');
    expect(sectionTwinRoute('/account/x.md')).toBeNull();
    expect(twinPath('/')).toBe('/index.md');
    expect(twinPath('/demos/x')).toBe('/demos/x.md');
  });
});

// The sign-in half of the proxy is WorkOS's; here it only has to be the one that answers.
vi.mock('@workos-inc/authkit-nextjs', () => ({
  authkitProxy: () => () => new Response(null, { status: 307, headers: { location: '/sign-in' } }),
}));

describe('the proxy', () => {
  let proxy: typeof import('../proxy.ts').default;
  beforeAll(async () => {
    proxy = (await import('../proxy.ts')).default;
  });
  const run = async (path: string, accept?: string) => {
    const req = new NextRequest(`https://cuttingfloor.ai${path}`, {
      headers: accept ? { accept } : {},
    });
    const res = await proxy(req, {} as never);
    return res?.headers.get('x-middleware-rewrite') ?? null;
  };

  it('rewrites Markdown requests to the twin and leaves HTML alone', async () => {
    expect(await run('/', 'text/markdown')).toBe('https://cuttingfloor.ai/index.md');
    expect(await run('/demos/x', 'text/markdown')).toBe('https://cuttingfloor.ai/md/demos/x');
    expect(await run('/demos/x.md')).toBe('https://cuttingfloor.ai/md/demos/x');
    expect(await run('/', 'text/html, text/markdown;q=0.1')).toBeNull();
    expect(await run('/alternatives', 'text/markdown')).toBeNull();
  });

  it('still sends signed-in pages through sign-in, whatever they accept', async () => {
    for (const accept of [undefined, 'text/markdown']) {
      const req = new NextRequest('https://cuttingfloor.ai/account', {
        headers: accept ? { accept } : {},
      });
      expect((await proxy(req, {} as never))?.headers.get('location')).toBe('/sign-in');
    }
  });
});

describe('Markdown twins and discovery files', () => {
  let routes: typeof import('../app/routes.ts').ROUTES;
  const cwd = process.cwd();
  afterAll(() => process.chdir(cwd));
  beforeAll(async () => {
    process.chdir(SITE);
    routes = (await import('../app/routes.ts')).ROUTES;
  });

  /** Public pages that have no twin yet; anything else without one fails here. */
  const NO_TWIN = new Set(['/alternatives']);

  it('gives every public page a twin', () => {
    const missing = routes.filter((r) => !NO_TWIN.has(r.path) && !markdownRoute(r.path));
    expect(missing.map((r) => r.path)).toEqual([]);
  });

  it('builds each existing page’s twin as Markdown with its canonical address', async () => {
    const section = await import('../app/md/[section]/[slug]/route.ts');
    for (const r of routes.filter((x) => markdownRoute(x.path))) {
      const target = markdownRoute(r.path) as string;
      let res: Response;
      if (target.startsWith('/md/')) {
        const [, , s, slug] = target.split('/');
        res = await section.GET(new Request('https://x'), {
          params: Promise.resolve({ section: s as string, slug: slug as string }),
        });
      } else {
        const mod = await import(`../app${target}/route.ts`).catch(() => null);
        if (!mod) continue; // a sibling page not on this branch yet
        res = mod.GET();
      }
      expect(res.status, r.path).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(res.headers.get('vary')).toBe('Accept');
      expect(res.headers.get('link')).toBe(
        `<${new URL(r.path, 'https://cuttingfloor.ai')}>; rel="canonical"`,
      );
      const text = await res.text();
      // A skill's twin is its file, front matter first; every other twin starts with its title.
      expect(/^(# |---\n)/.test(text), r.path).toBe(true);
      expect(text).toContain(`Canonical: ${new URL(r.path, 'https://cuttingfloor.ai')}`);
      expect(text).not.toContain('[object Object]');
    }
  });

  it('keeps the policy pages’ sections and links', async () => {
    const { markdown } = await import('../app/terms.md/markdown.ts');
    const md = markdown();
    expect(md).toContain('## Payments and cancelling');
    expect(md).toContain('[refunds page](https://cuttingfloor.ai/refunds)');
    expect(md).toMatch(/- Every new account gets \d+ free credits/);
  });

  it('publishes an AI Catalog that points at the server card', async () => {
    const { GET } = await import('../app/.well-known/ai-catalog.json/route.ts');
    const res = GET();
    expect(res.headers.get('content-type')).toBe('application/ai-catalog+json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const catalog = await res.json();
    expect(catalog.specVersion).toBe('1.0');
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({
        type: 'application/mcp-server-card+json',
        url: 'https://api.cuttingfloor.ai/mcp/server-card',
      }),
    );
  });

  it('lists every page and its twin in llms.txt', async () => {
    const { GET } = await import('../app/llms.txt/route.ts');
    const text = await GET().text();
    for (const r of routes)
      expect(text).toContain(`(${new URL(r.path, 'https://cuttingfloor.ai')})`);
    expect(text).toContain('https://cuttingfloor.ai/index.md');
    for (const agent of ['Kazi', 'Claude Cowork', 'Claude Code', 'ChatGPT Work', 'Codex', 'Cursor'])
      expect(text).toContain(`**${agent}**`);
    expect(text).toContain('create.lipsync');
  });
});
