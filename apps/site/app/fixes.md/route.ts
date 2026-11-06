import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /fixes page as Markdown, at /fixes.md and for Accept: text/markdown on /fixes.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/fixes', markdown());
}
