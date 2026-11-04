import { AGENTS, AGENTS_UPDATED, agent, agentClients, agentDemos } from '../../content/agents.ts';
import { doc, list, pageLink } from '../lib/markdown.ts';

// /agents and each /agents/<slug> as Markdown, from the agent data.

export function markdown(): string {
  return doc({
    path: '/agents',
    title: 'Edit videos with your AI agent: Kazi, Claude and ChatGPT',
    summary:
      'Kazi, Claude and ChatGPT can’t cut video on their own. Connected to cuttingfloor, they cut your footage, add captions and music, check a preview and give you the finished video.',
    updated: AGENTS_UPDATED,
    body: `## Agents\n\n${list(AGENTS.map((a) => `${pageLink(a.title, `/agents/${a.slug}`)}: ${a.answer}`))}\n\nEvery other app: ${pageLink('Connect', '/connect')}`,
  });
}

export function agentMarkdown(slug: string): string | undefined {
  const a = agent(slug);
  if (!a) return undefined;
  const connect = agentClients(a).map(
    (c) =>
      `### ${c.name} (${c.where})\n\n${c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}${
        c.snippets[0] ? `\n\n${c.snippets[0].label}:\n\n\`\`\`\n${c.snippets[0].code}\n\`\`\`` : ''
      }${c.notes?.length ? `\n\n${list(c.notes)}` : ''}`,
  );
  const demos = agentDemos(a);
  return doc({
    path: `/agents/${a.slug}`,
    title: a.title,
    summary: a.answer,
    updated: AGENTS_UPDATED,
    body: [
      `## Add cuttingfloor to ${a.name}\n\n${connect.join('\n\n')}`,
      `## Then say what you want\n\n\`\`\`\n${a.prompt}\n\`\`\``,
      demos.length
        ? `## Edited in ${a.name}\n\n${list(demos.map((d) => `${pageLink(d.title, `/demos/${d.slug}`)}: ${d.description}`))}`
        : '',
      ...a.faqs.map((f) => `## ${f.q}\n\n${f.a}`),
      `More: ${AGENTS.filter((o) => o !== a)
        .map((o) => pageLink(`Edit with ${o.name}`, `/agents/${o.slug}`))
        .join(' · ')} · ${pageLink('Every other app', '/connect')}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
}
