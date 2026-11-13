import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /sign-in-warning page as Markdown, at /sign-in-warning.md and for Accept: text/markdown.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/sign-in-warning', markdown());
}
