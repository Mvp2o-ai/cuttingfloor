import { demoForSkill } from '../../content/demos.ts';
import { SKILLS, SKILLS_UPDATED, skill } from '../../content/skills.ts';
import { abs, doc, list, pageLink } from '../lib/markdown.ts';

// /skills as Markdown, and each /skills/<slug> as the skill file itself: the exact text a
// connected agent gets from skills.get, so a copy from here works as is.

const steps = (body: string) => body.split('\n').filter((l) => /^\d+\.\s/.test(l)).length;

export function markdown(): string {
  return doc({
    path: '/skills',
    title: 'Skills: steps your agent can follow',
    summary:
      'A skill is one job written down step by step, so your agent does it the same good way every time: which cuttingfloor tools to use, in what order, and what to check before it hands you the video.',
    updated: SKILLS_UPDATED,
    body: [
      'A connected agent finds these itself: `skills.search {query}` in the user’s words, then `skills.get {slug}` for the whole skill. Or paste one into Kazi (save it as a playbook), Claude or ChatGPT (a chat, or a project’s instructions).',
      `## Skills\n\n${list(
        SKILLS.map(
          (s) =>
            `${pageLink(s.title, `/skills/${s.slug}`)}: ${s.description} (${steps(s.body)} steps, version ${s.version})`,
        ),
      )}`,
    ].join('\n\n'),
  });
}

/** The skill file as is (front matter first, so a copy works), then its address and a demo. */
export function skillMarkdown(slug: string): string | undefined {
  const s = skill(slug);
  if (!s) return undefined;
  const shown = demoForSkill(s.slug);
  const after = [
    `Canonical: ${abs(`/skills/${s.slug}`)} · Index: ${abs('/llms.txt')}`,
    shown && `Watch an agent do it: ${pageLink(shown.title, `/demos/${shown.slug}`)}`,
  ].filter(Boolean);
  return `${s.markdown.trimEnd()}\n\n---\n\n${after.join('\n\n')}\n`;
}
