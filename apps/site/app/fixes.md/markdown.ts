import { FIXES, FIXES_UPDATED } from '../../content/fixes.ts';
import { abs, doc } from '../lib/markdown.ts';

// /fixes as Markdown, from the list the page renders.

export function markdown(): string {
  return doc({
    path: '/fixes',
    title: 'Common video editing problems, and how to fix them with AI',
    summary:
      'Connect cuttingfloor to the AI you already use (ChatGPT, Claude or Kazi), give it the video and say what is wrong. The problems people search for most, what the agent does about each, and what to type.',
    updated: FIXES_UPDATED,
    body: FIXES.map(
      (f) =>
        `## ${f.problem}\n\n${f.answer}\n\nSay: “${f.prompt}”${f.see ? `\n\nSee it: [${f.see.label}](${abs(f.see.href)})` : ''}`,
    ).join('\n\n'),
  });
}
