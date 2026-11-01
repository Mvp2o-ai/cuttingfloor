import { legalMarkdown } from '../lib/legal-markdown.ts';
import Refunds, { metadata } from '../refunds/page.tsx';

// /refunds as Markdown, read from the page's own elements.
export const markdown = () => legalMarkdown(Refunds, metadata);
