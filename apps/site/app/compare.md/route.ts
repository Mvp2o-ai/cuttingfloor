import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// /compare as Markdown, at /compare.md and for Accept: text/markdown on /compare.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/compare', markdown());
}
