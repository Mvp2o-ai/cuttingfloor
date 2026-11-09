import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// /how-to-connect as Markdown, at /how-to-connect.md and for Accept: text/markdown on it.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/how-to-connect', markdown());
}
