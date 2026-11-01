import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /demos page as Markdown, at /demos.md and for Accept: text/markdown on /demos.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/demos', markdown());
}
