import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /walkthroughs page as Markdown, at /walkthroughs.md and for Accept: text/markdown on /walkthroughs.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/walkthroughs', markdown());
}
