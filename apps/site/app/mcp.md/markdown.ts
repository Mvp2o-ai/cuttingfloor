import { legalMarkdown } from '../lib/legal-markdown.ts';
import Mcp, { metadata } from '../mcp/page.tsx';

// /mcp as Markdown, read from the page's own elements.
export const markdown = () => legalMarkdown(Mcp, metadata);
