import AcceptableUse, { metadata } from '../acceptable-use/page.tsx';
import { legalMarkdown } from '../lib/legal-markdown.ts';

// /acceptable-use as Markdown, read from the page's own elements.
export const markdown = () => legalMarkdown(AcceptableUse, metadata);
