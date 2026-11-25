import {
  APP_ANDROID,
  APP_DESCRIPTION,
  APP_LEAD,
  APP_NAME,
  APP_POINTS,
  APP_SHOTS,
  APP_TITLE,
  appStoreUrl,
} from '../../content/app.ts';
import { abs, doc } from '../lib/markdown.ts';

// /app as Markdown, from the same lines the page renders.
export const markdown = () =>
  doc({
    path: '/app',
    title: APP_TITLE,
    summary: APP_DESCRIPTION,
    body: [
      APP_LEAD,
      APP_POINTS.map((p) => `- **${p.b}** ${p.text}`).join('\n'),
      `## Get it\n\n[${APP_NAME} on the App Store](${appStoreUrl('app-md')}). For iPhone. ${APP_ANDROID}`,
      '## Screenshots',
      APP_SHOTS.map((s) => `![${s.alt}](${abs(s.src)})`).join('\n\n'),
    ].join('\n\n'),
  });
