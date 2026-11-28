import { AGENTS } from '../../content/agents.ts';
import { DEMOS } from '../../content/demos.ts';
import { guide, guidePath, type Lang } from '../../content/guides.ts';
import { toolCallsMarkdown } from '../../content/tool-calls.ts';
import { BUILDER_WAYS } from '../../content/ways.ts';
import { doc, list, pageLink } from '../lib/markdown.ts';

// Each guide as Markdown, in its own language: /guides/<slug>.md and /es/<slug>.md.

const HEAD: Record<Lang, { steps: string; say: string; agents: string; demos: string }> = {
  en: { steps: 'How', say: 'What to type', agents: 'Do it from your agent', demos: 'Watch' },
  es: { steps: 'Cómo', say: 'Qué escribir', agents: 'Hazlo desde tu agente', demos: 'Ejemplos' },
};

export const guideMarkdown = (lang: Lang) => (slug: string) => {
  const g = guide(lang, slug);
  if (!g) return undefined;
  const h = HEAD[lang];
  const demos = g.demos.flatMap((s) => DEMOS.filter((d) => d.slug === s));
  return doc({
    path: guidePath(g),
    title: g.title,
    summary: g.answer,
    updated: g.updated,
    body: [
      `## ${h.steps}\n\n${g.steps.map((s, i) => `${i + 1}. **${s.title}.** ${s.body}`).join('\n')}`,
      `## ${h.say}\n\n\`\`\`\n${g.prompt}\n\`\`\``,
      g.tools ? toolCallsMarkdown(g.tools, lang) : '',
      g.audience === 'builder'
        ? `## Call it\n\n${BUILDER_WAYS.map((w) => `### ${w.name}\n\n${w.text}${w.snippet ? `\n\n\`\`\`\n${w.snippet.code}\n\`\`\`` : ''}`).join('\n\n')}\n\n- ${pageLink('How to connect', '/how-to-connect#builders')}`
        : `## ${h.agents}\n\n${list(AGENTS.map((a) => pageLink(a.name, `/agents/${a.slug}`)))}\n- ${pageLink('Connect', '/connect')}`,
      demos.length
        ? `## ${h.demos}\n\n${list(demos.map((d) => `${pageLink(d.title, `/demos/${d.slug}`)} (${d.agent})`))}`
        : '',
      ...g.faqs.map((f) => `## ${f.q}\n\n${f.a}`),
      g.alternate ? pageLink(lang === 'es' ? 'In English' : 'En español', g.alternate) : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
};
