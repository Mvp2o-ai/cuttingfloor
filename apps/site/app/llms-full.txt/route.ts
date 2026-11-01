import { markdown as home } from '../index.md/markdown.ts';
import { markdown as skills } from '../skills.md/markdown.ts';

// llms-full.txt: the key pages' Markdown twins, whole, in one file, for an agent that wants
// everything in a single fetch. Each page's twin keeps its text in `app/<page>.md/markdown.ts`,
// which exports `markdown(): string`; a page is added here by importing that function.
export const dynamic = 'force-static';

/** In reading order: what it is, every tool, the price, connecting, self-hosting, compared, skills. */
const PAGES: (() => string)[] = [
  home,
  // features, pricing, connect, self-host, compare: added with their pages.
  skills,
];

export function GET() {
  return new Response(PAGES.map((page) => page()).join('\n---\n\n'), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
