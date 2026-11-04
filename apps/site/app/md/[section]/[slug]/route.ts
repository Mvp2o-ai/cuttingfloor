import { AGENTS } from '../../../../content/agents.ts';
import { DEMOS } from '../../../../content/demos.ts';
import { GUIDES } from '../../../../content/guides.ts';
import { SKILLS } from '../../../../content/skills.ts';
import { WALKTHROUGHS } from '../../../../content/walkthroughs.ts';
import { agentMarkdown } from '../../../agents.md/markdown.ts';
import { demoMarkdown } from '../../../demos.md/markdown.ts';
import { guideMarkdown } from '../../../guides/markdown.ts';
import { markdownResponse } from '../../../lib/markdown.ts';
import type { Section } from '../../../lib/negotiate.ts';
import { skillMarkdown } from '../../../skills.md/markdown.ts';
import { walkthroughMarkdown } from '../../../walkthroughs.md/markdown.ts';

// The Markdown twins of pages under a section. The proxy sends /demos/<slug>.md, and
// /demos/<slug> asked for as text/markdown, here; a route folder can't end in .md beside [slug].

export const dynamic = 'force-static';
export const dynamicParams = false;

const BUILD: Record<Section, { slugs: () => string[]; md: (slug: string) => string | undefined }> =
  {
    demos: { slugs: () => DEMOS.map((d) => d.slug), md: demoMarkdown },
    walkthroughs: { slugs: () => WALKTHROUGHS.map((w) => w.slug), md: walkthroughMarkdown },
    skills: { slugs: () => SKILLS.map((s) => s.slug), md: skillMarkdown },
    agents: { slugs: () => AGENTS.map((a) => a.slug), md: agentMarkdown },
    guides: {
      slugs: () => GUIDES.filter((g) => g.lang === 'en').map((g) => g.slug),
      md: guideMarkdown('en'),
    },
    es: {
      slugs: () => GUIDES.filter((g) => g.lang === 'es').map((g) => g.slug),
      md: guideMarkdown('es'),
    },
  };

export function generateStaticParams() {
  return Object.entries(BUILD).flatMap(([section, b]) =>
    b.slugs().map((slug) => ({ section, slug })),
  );
}

type Props = { params: Promise<{ section: string; slug: string }> };

export async function GET(_: Request, { params }: Props) {
  const { section, slug } = await params;
  const text = BUILD[section as Section]?.md(slug);
  if (!text) return new Response('Not found\n', { status: 404 });
  return markdownResponse(`/${section}/${slug}`, text);
}
