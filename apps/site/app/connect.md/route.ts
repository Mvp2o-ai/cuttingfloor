import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// /connect as Markdown, at /connect.md and for Accept: text/markdown on /connect.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/connect', markdown());
}
