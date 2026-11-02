import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /privacy page as Markdown, at /privacy.md and for Accept: text/markdown on /privacy.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/privacy', markdown());
}
