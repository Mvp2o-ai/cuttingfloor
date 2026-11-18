import { demo } from '../../content/demos.ts';
import { VERSUS } from '../../content/versus.ts';
import { doc, list, pageLink } from '../lib/markdown.ts';

// Each /compare/<slug> as Markdown, from the versus data.

export function versusMarkdown(slug: string): string | undefined {
  const v = VERSUS.find((x) => x.slug === slug);
  if (!v) return undefined;
  const demos = v.demos.flatMap((s) => {
    const d = demo(s);
    return d ? [d] : [];
  });
  const others = VERSUS.filter((o) => o.slug !== v.slug);
  return doc({
    path: `/compare/${v.slug}`,
    title: v.title,
    summary: v.answer,
    updated: v.updated,
    body: [
      `${pageLink('Start free', '/start')} · ${pageLink('Watch it edit', demos[0] ? `/demos/${demos[0].slug}` : '/demos')}`,
      ...v.sides.map((s) => `## ${s.name}\n\n${s.is}\n\n**Where it wins**\n\n${s.wins}`),
      `## The deciding line\n\n${v.deciding}`,
      `## Pick ${v.sides[0].name} if\n\n${v.pick[0]}`,
      `## Pick ${v.sides[1].name} if\n\n${v.pick[1]}`,
      `## Watch it do this\n\n${list(demos.map((d) => pageLink(d.title, `/demos/${d.slug}`)))}`,
      ...(v.kind === 'neutral'
        ? [`Neither runs inside your agent. ${pageLink('cuttingfloor', '/start')} does.`]
        : []),
      ...v.faqs.map((f) => `## ${f.q}\n\n${f.a}`),
      `## Related comparisons\n\n${list([
        pageLink('Compare', '/compare'),
        ...others.map((o) => pageLink(o.title, `/compare/${o.slug}`)),
      ])}`,
    ].join('\n\n'),
  });
}
