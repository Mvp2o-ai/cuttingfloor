import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /skills page as Markdown, at /skills.md and for Accept: text/markdown on /skills.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/skills', markdown());
}
