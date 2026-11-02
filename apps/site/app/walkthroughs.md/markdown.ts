import { WALKTHROUGHS, walkthrough } from '../../content/walkthroughs.ts';
import { doc, list, pageLink, table } from '../lib/markdown.ts';
import { ROUTES } from '../routes.ts';

// /walkthroughs and each /walkthroughs/<slug> as Markdown, from the walkthrough data.

export function markdown(): string {
  return doc({
    path: '/walkthroughs',
    title: 'Walkthroughs: one technique, start to finish',
    summary:
      'Each walkthrough is one editing technique done by an agent connected to the cuttingfloor MCP server: the prompt as it was typed, every tool call in order with its arguments, the timeline it left, and the file that came out.',
    updated: ROUTES.find((r) => r.path === '/walkthroughs')?.updated,
    body: `## Walkthroughs\n\n${list(
      WALKTHROUGHS.map(
        (w) =>
          `${pageLink(w.title, `/walkthroughs/${w.slug}`)}: ${w.oneLiner} (${w.session.steps.filter((s) => s.kind === 'call').length} tool calls)`,
      ),
    )}`,
  });
}

export function walkthroughMarkdown(slug: string): string | undefined {
  const w = walkthrough(slug);
  if (!w) return undefined;
  const session = w.session.steps.map((s) =>
    s.kind === 'call'
      ? `- \`${s.fn}\` \`${s.args}\` → ${s.ret}`
      : `- **${s.kind === 'user' ? 'You' : w.session.agent}:** ${s.text}`,
  );
  const calls = w.session.steps.flatMap((s) => (s.kind === 'call' ? [s] : []));
  return doc({
    path: `/walkthroughs/${w.slug}`,
    title: w.title,
    summary: w.answer,
    updated: w.updated,
    body: [
      `## What did they ask for?\n\nTyped into the agent, word for word:\n\n\`\`\`\n${w.prompt}\n\`\`\``,
      `## What did the agent do?\n\n${calls.length} tool calls to the cuttingfloor MCP server, in ${w.session.agent}.\n\n${session.join('\n')}`,
      `## Which tool calls did it make?\n\n${calls
        .map((c, i) => `${i + 1}. \`${c.fn}\` \`${c.full ?? c.args}\` → ${c.ret}`)
        .join('\n')}`,
      `## What does the timeline look like after?\n\n${table(
        ['Measure', 'Value'],
        w.result.stats.map((s) => [s.label, s.value]),
      )}`,
      ...w.sections.map((s) => `## ${s.heading}\n\n${s.body.join('\n\n')}`),
      `## What came out?\n\n${table(
        ['File', 'Format', 'Duration', 'Resolution'],
        [[w.file.name, `${w.file.container}, ${w.file.codec}`, w.file.duration, w.file.resolution]],
      )}`,
      `More: ${pageLink('Walkthroughs', '/walkthroughs')}`,
    ].join('\n\n'),
  });
}
