import { AGENTS, AGENTS_UPDATED } from '../content/agents.ts';
import { DEMOS } from '../content/demos.ts';
import { GUIDES, guidePath } from '../content/guides.ts';
import { SKILLS, SKILLS_UPDATED } from '../content/skills.ts';
import { WALKTHROUGHS } from '../content/walkthroughs.ts';

// Every public page, with the date its content last changed. The sitemap, llms.txt and the
// Markdown versions all read this list, so a new page is added in one place.
export type Route = { path: string; title: string; updated: string };

export const ROUTES: Route[] = [
  { path: '/', title: 'cuttingfloor: the video editing MCP server', updated: '2026-11-01' },
  {
    path: '/demos',
    title: 'Demos',
    updated:
      DEMOS.map((d) => d.uploaded)
        .sort()
        .at(-1) ?? '',
  },
  ...DEMOS.map((d) => ({ path: `/demos/${d.slug}`, title: d.title, updated: d.uploaded })),
  {
    path: '/alternatives',
    title: 'AI video editor your agent runs: a CapCut, Descript and VEED alternative',
    updated: '2026-10-29',
  },
  { path: '/features', title: 'Features', updated: '2026-11-01' },
  { path: '/pricing', title: 'Pricing', updated: '2026-11-01' },
  {
    path: '/connect',
    title: 'Connect cuttingfloor to Claude, ChatGPT, Codex, Cursor and more',
    updated: '2026-11-01',
  },
  {
    path: '/self-host',
    title: 'Run cuttingfloor yourself: free and open source',
    updated: '2026-11-01',
  },
  {
    path: '/compare',
    title: 'Compare AI video editing: MCP servers, APIs and editing apps',
    updated: '2026-11-01',
  },
  {
    path: '/agents',
    title: 'Edit videos with your AI agent: Kazi, Claude and ChatGPT',
    updated: AGENTS_UPDATED,
  },
  ...AGENTS.map((a) => ({ path: `/agents/${a.slug}`, title: a.title, updated: AGENTS_UPDATED })),
  ...GUIDES.map((g) => ({ path: guidePath(g), title: g.title, updated: g.updated })),
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
