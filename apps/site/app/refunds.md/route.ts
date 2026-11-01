import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /refunds page as Markdown, at /refunds.md and for Accept: text/markdown on /refunds.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/refunds', markdown());
}
