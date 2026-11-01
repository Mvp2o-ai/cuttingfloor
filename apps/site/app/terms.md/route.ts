import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /terms page as Markdown, at /terms.md and for Accept: text/markdown on /terms.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/terms', markdown());
}
