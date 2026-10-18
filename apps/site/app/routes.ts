import { WALKTHROUGHS } from '../content/walkthroughs.ts';

// Every public page, with the date its content last changed. The sitemap, llms.txt and the
// Markdown versions all read this list, so a new page is added in one place.
export type Route = { path: string; title: string; updated: string };

export const ROUTES: Route[] = [
  { path: '/', title: 'cuttingfloor: the video editing MCP server', updated: '2026-10-18' },
  { path: '/walkthroughs', title: 'Walkthroughs', updated: '2026-10-18' },
  ...WALKTHROUGHS.map((w) => ({
    path: `/walkthroughs/${w.slug}`,
    title: w.title,
    updated: w.updated,
  })),
];
