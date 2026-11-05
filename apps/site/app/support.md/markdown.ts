import { legalMarkdown } from '../lib/legal-markdown.ts';
import Support, { metadata } from '../support/page.tsx';

// /support as Markdown, read from the page's own elements.
export const markdown = () => legalMarkdown(Support, metadata);
