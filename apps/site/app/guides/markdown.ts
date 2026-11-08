import { AGENTS } from '../../content/agents.ts';
import { DEMOS, lengths } from '../../content/demos.ts';
import { guide, guidePath, type Lang } from '../../content/guides.ts';
import { doc, list, pageLink } from '../lib/markdown.ts';

// Each guide as Markdown, in its own language: /guides/<slug>.md and /es/<slug>.md.

const HEAD: Record<
  Lang,
  { steps: string; say: string; agents: string; demos: string; does: string; proof: string }
> = {
  en: {
    steps: 'How',
    say: 'What to type',
    agents: 'Do it from your agent',
    demos: 'Watch',
    does: 'What it does',
    proof: 'Before and after',
  },
  es: {
    steps: 'Cómo',
    say: 'Qué escribir',
    agents: 'Hazlo desde tu agente',
    demos: 'Ejemplos',
    does: 'Qué hace',
    proof: 'Antes y después',
  },
};

export const guideMarkdown = (lang: Lang) => (slug: string) => {
  const g = guide(lang, slug);
  if (!g) return undefined;
  const h = HEAD[lang];
  const demos = g.demos.flatMap((s) => DEMOS.filter((d) => d.slug === s));
  const f = g.feature;
  const proof = f ? DEMOS.find((d) => d.id === f.proof) : undefined;
  const say = f
    ? f.prompts.map((p) => `**${p.label}**\n\n\`\`\`\n${p.text}\n\`\`\``).join('\n\n')
    : `\`\`\`\n${g.prompt}\n\`\`\``;
  return doc({
    path: guidePath(g),
    title: g.title,
    summary: g.answer,
    updated: g.updated,
    body: [
      proof
        ? `## ${h.proof}\n\n${pageLink(proof.title, `/demos/${proof.slug}`)} (${proof.agent}, ${lengths(proof)}): ${proof.description}`
        : '',
      f
        ? `## ${h.does}\n\n${f.does.map((d, i) => `${i + 1}. **${d.title}.** ${d.body}`).join('\n')}`
        : '',
      f
        ? `## ${f.whyHead.replace(/\.$/, '')}\n\n${f.why.map((w) => `- **${w.title}.** ${w.body}`).join('\n')}\n\n${f.whyNote}`
        : '',
      `## ${h.steps}\n\n${g.steps.map((s, i) => `${i + 1}. **${s.title}.** ${s.body}`).join('\n')}`,
      `## ${h.say}\n\n${say}`,
      `## ${h.agents}\n\n${list(AGENTS.map((a) => pageLink(a.name, `/agents/${a.slug}`)))}\n- ${pageLink('Connect', '/connect')}`,
      demos.length
        ? `## ${h.demos}\n\n${list(demos.map((d) => `${pageLink(d.title, `/demos/${d.slug}`)} (${d.agent})`))}`
        : '',
      ...g.faqs.map((q) => `## ${q.q}\n\n${q.a}`),
      g.alternate ? pageLink(lang === 'es' ? 'In English' : 'En español', g.alternate) : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
};
