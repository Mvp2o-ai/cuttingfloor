import { legalMarkdown } from '../lib/legal-markdown.ts';
import Privacy, { metadata } from '../privacy/page.tsx';

// /privacy as Markdown, read from the page's own elements.
export const markdown = () => legalMarkdown(Privacy, metadata);
