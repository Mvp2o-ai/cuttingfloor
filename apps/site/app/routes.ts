import { DEMOS } from '../content/demos.ts';
import { SKILLS, SKILLS_UPDATED } from '../content/skills.ts';
import { WALKTHROUGHS } from '../content/walkthroughs.ts';

// Every public page, with the date its content last changed. The sitemap, llms.txt and the
// Markdown versions all read this list, so a new page is added in one place.
export type Route = { path: string; title: string; updated: string };

export const ROUTES: Route[] = [
  { path: '/', title: 'cuttingfloor: the video editing MCP server', updated: '2026-10-18' },
  {
    path: '/demos',
    title: 'Demos',
    updated:
      DEMOS.map((d) => d.uploaded)
        .sort()
        .at(-1) ?? '',
  },
  ...DEMOS.map((d) => ({ path: `/demos/${d.slug}`, title: d.title, updated: d.uploaded })),
  { path: '/walkthroughs', title: 'Walkthroughs', updated: '2026-10-18' },
  ...WALKTHROUGHS.map((w) => ({
    path: `/walkthroughs/${w.slug}`,
    title: w.title,
    updated: w.updated,
  })),
  { path: '/skills', title: 'Skills', updated: SKILLS_UPDATED },
  ...SKILLS.map((s) => ({ path: `/skills/${s.slug}`, title: s.title, updated: SKILLS_UPDATED })),
  { path: '/terms', title: 'Terms', updated: '2026-10-20' },
  { path: '/privacy', title: 'Privacy', updated: '2026-10-20' },
  { path: '/refunds', title: 'Refunds', updated: '2026-10-20' },
  { path: '/acceptable-use', title: 'Acceptable use', updated: '2026-10-20' },
];
