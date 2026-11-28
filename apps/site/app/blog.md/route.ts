import { markdown } from '../blog/markdown.ts';
import { markdownResponse } from '../lib/markdown.ts';

// The /blog page as Markdown, at /blog.md and for Accept: text/markdown on /blog.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/blog', markdown());
}
