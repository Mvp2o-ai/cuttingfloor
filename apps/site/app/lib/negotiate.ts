// Which Markdown answers a request, decided by the proxy from the path and the Accept header alone,
// never the user agent. Pure and import-free, so the proxy stays small and tests can call it.
//
// Every public page has a Markdown twin at its path plus `.md` (`/` is `/index.md`). Top-level twins
// are route folders (`app/pricing.md/route.ts`); the twins of pages under a section
// (`/demos/<slug>.md`) are served by `app/md/[section]/[slug]/route.ts`, which the proxy rewrites to.

/** Top-level pages with a twin at `/<page>.md`. A new page with a twin is added here too. */
export const TOP_TWINS = [
  'demos',
  'walkthroughs',
  'skills',
  'terms',
  'privacy',
  'refunds',
  'acceptable-use',
  'pricing',
  'features',
  'connect',
  'self-host',
  'compare',
  'agents',
] as const;

/** Sections whose pages have twins at `/<section>/<slug>.md`. */
export const SECTIONS = ['demos', 'walkthroughs', 'skills', 'agents', 'guides', 'es'] as const;
export type Section = (typeof SECTIONS)[number];

const top = new Set<string>(TOP_TWINS);
const sections = new Set<string>(SECTIONS);

/** The public address of a page's Markdown twin: `/` → `/index.md`, `/demos/x` → `/demos/x.md`. */
export function twinPath(path: string): string {
  return path === '/' ? '/index.md' : `${path.replace(/\/$/, '')}.md`;
}

/** Where a page's twin is served from inside the app, or null when the page has none. */
export function markdownRoute(path: string): string | null {
  if (path === '/' || path === '') return '/index.md';
  const parts = path.replace(/\/$/, '').split('/').slice(1);
  if (parts.length === 1 && top.has(parts[0] as string)) return `/${parts[0]}.md`;
  if (parts.length === 2 && sections.has(parts[0] as string) && /^[a-z0-9-]+$/.test(parts[1] ?? ''))
    return `/md/${parts[0]}/${parts[1]}`;
  return null;
}

/** A section page's `.md` address (`/demos/x.md`) to the route that serves it, or null. */
export function sectionTwinRoute(path: string): string | null {
  const m = /^\/([a-z-]+)\/([a-z0-9-]+)\.md$/.exec(path);
  return m && sections.has(m[1] as string) ? `/md/${m[1]}/${m[2]}` : null;
}

/** RFC 9110 quality of each media range in an Accept header; a malformed q counts as 0. */
function qualities(accept: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of accept.split(',')) {
    const [range, ...params] = part.trim().toLowerCase().split(';');
    if (!range) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q') q = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(v ?? '') ? Number(v) : 0;
    }
    out.set(range.trim(), Math.max(q, out.get(range.trim()) ?? 0));
  }
  return out;
}

/**
 * True when the client asks for Markdown by name and likes it at least as much as HTML. Wildcards
 * never choose Markdown (a browser's `*\/*` gets HTML); a tie with text/html goes to Markdown, since
 * naming it at all is the signal.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const q = qualities(accept);
  const md = Math.max(q.get('text/markdown') ?? 0, q.get('text/x-markdown') ?? 0);
  if (md <= 0) return false;
  const html = Math.max(q.get('text/html') ?? 0, q.get('application/xhtml+xml') ?? 0);
  return md >= html;
}
