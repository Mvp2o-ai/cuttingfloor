import { legalMarkdown } from '../lib/legal-markdown.ts';
import Terms, { metadata } from '../terms/page.tsx';

// /terms as Markdown, read from the page's own elements.
export const markdown = () => legalMarkdown(Terms, metadata);
