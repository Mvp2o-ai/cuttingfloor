import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The /mcp page as Markdown, at /mcp.md and for Accept: text/markdown on /mcp.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/mcp', markdown());
}
