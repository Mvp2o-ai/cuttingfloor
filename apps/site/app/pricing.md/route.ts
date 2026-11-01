import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// /pricing as Markdown, at /pricing.md and for Accept: text/markdown on /pricing.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/pricing', markdown());
}
