import { APP_DESCRIPTION, APP_LEAD, APP_SHOTS, APP_STEPS, APP_TITLE } from '../../content/app.ts';
import { abs, doc } from '../lib/markdown.ts';

// /app as Markdown, from the same lines the page renders.
export const markdown = () =>
  doc({
    path: '/app',
    title: APP_TITLE,
    summary: APP_DESCRIPTION,
    body: [
      APP_LEAD,
      '## Join the beta',
      APP_STEPS.map(
        (s, i) => `${i + 1}. ${s.text}${'href' in s ? ` [${s.link}](${s.href})` : ''}`,
      ).join('\n'),
      'iPhone only for now.',
      '## Screenshots',
      APP_SHOTS.map((s) => `![${s.alt}](${abs(s.src)})`).join('\n\n'),
    ].join('\n\n'),
  });
