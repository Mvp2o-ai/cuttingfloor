import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// /agents as Markdown, at /agents.md and for Accept: text/markdown on /agents.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/agents', markdown());
}
