import { markdownResponse } from '../lib/markdown.ts';
import { markdown } from './markdown.ts';

// /self-host as Markdown, at /self-host.md and for Accept: text/markdown on /self-host.
export const dynamic = 'force-static';

export function GET() {
  return markdownResponse('/self-host', markdown());
}
