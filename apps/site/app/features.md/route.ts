import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// /features as Markdown, at /features.md and for Accept: text/markdown on /features.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/features', markdown());
}
