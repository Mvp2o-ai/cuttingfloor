import { legalMarkdown } from '../lib/legal-markdown.ts';
import SignInWarning, { metadata } from '../sign-in-warning/page.tsx';

// /sign-in-warning as Markdown, read from the page's own elements.
export const markdown = () => legalMarkdown(SignInWarning, metadata);
