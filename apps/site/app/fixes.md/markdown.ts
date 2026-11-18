import { AGENTS } from '../../content/agents.ts';
import { FIXES, FIXES_UPDATED, fix, fixLead, fixPath } from '../../content/fixes.ts';
import { abs, doc, list, pageLink } from '../lib/markdown.ts';

// /fixes as Markdown, the index: each question linked to its own page and twin, with the answer's
// opening. And each fix's own twin, /fixes/<id>.md, from the same list the pages render.

export function markdown(): string {
  return doc({
    path: '/fixes',
    title: 'Common video editing problems, and how to fix them with AI',
    summary:
      'Connect cuttingfloor to the AI you already use (ChatGPT, Claude or Kazi), give it the video and say what is wrong. The problems people search for most; each has its own page with what the agent does about it and what to type.',
    updated: FIXES_UPDATED,
    body: list(FIXES.map((f) => `${pageLink(f.problem, fixPath(f))}: ${fixLead(f)}`)),
  });
}

export function fixMarkdown(id: string): string | undefined {
  const f = fix(id);
  if (!f) return undefined;
  const related = f.related.flatMap((r) => FIXES.filter((x) => x.id === r));
  return doc({
    path: fixPath(f),
    title: f.problem,
    summary: f.answer,
    updated: FIXES_UPDATED,
    body: [
      `## What to type\n\n\`\`\`\n${f.prompt}\n\`\`\``,
      f.see ? `See it: [${f.see.label}](${abs(f.see.href)})` : '',
      f.watch ? `Watch it done: [${f.watch.label}](${abs(f.watch.href)})` : '',
      `## Do it from your agent\n\n${list(AGENTS.map((a) => pageLink(a.name, `/agents/${a.slug}`)))}\n- ${pageLink('Connect', '/connect')}`,
      `## More fixes\n\n${list(related.map((r) => pageLink(r.problem, fixPath(r))))}\n- ${pageLink('Every fix', '/fixes')}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
}
