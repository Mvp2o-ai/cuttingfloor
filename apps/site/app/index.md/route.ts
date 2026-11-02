import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// The home page as Markdown, at /index.md and for Accept: text/markdown on /.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/', markdown());
}
