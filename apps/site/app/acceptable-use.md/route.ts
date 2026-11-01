import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /acceptable-use page as Markdown, at /acceptable-use.md and for Accept: text/markdown on /acceptable-use.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/acceptable-use', markdown());
}
