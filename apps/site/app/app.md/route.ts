import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /app page as Markdown, at /app.md and for Accept: text/markdown on /app.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/app', markdown());
}
