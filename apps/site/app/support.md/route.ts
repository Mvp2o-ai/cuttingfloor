import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /support page as Markdown, at /support.md and for Accept: text/markdown on /support.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/support', markdown());
}
