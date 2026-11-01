import type { Metadata } from 'next';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { EFFECTIVE, Items, LegalPage, P, Part } from '../legal.tsx';
import { abs, doc } from './markdown.ts';

// A policy page's Markdown, read from the very elements the page renders: LegalPage's title and
// lede, each Part as a section, each P as a paragraph, each Items as a list, links kept. Nothing is
// written twice, so the HTML and the Markdown cannot disagree.

type Props = { children?: ReactNode; href?: string; title?: string; items?: ReactNode[] };

function inline(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(inline).join('');
  if (!isValidElement(node)) return '';
  const { children, href } = (node as ReactElement<Props>).props;
  const text = inline(children);
  if (node.type === 'a' && href) return `[${text}](${href.startsWith('/') ? abs(href) : href})`;
  if (node.type === 'strong' || node.type === 'b') return `**${text}**`;
  if (node.type === 'code') return `\`${text}\``;
  return text;
}

function blocks(node: ReactNode): string[] {
  return Children.toArray(node).flatMap((child): string[] => {
    if (!isValidElement(child)) return inline(child).trim() ? [inline(child).trim()] : [];
    const props = (child as ReactElement<Props>).props;
    if (child.type === Part) return [`## ${props.title}`, ...blocks(props.children)];
    if (child.type === P) return [inline(props.children).replace(/\s+/g, ' ').trim()];
    if (child.type === Items)
      return [
        (props.items ?? []).map((i) => `- ${inline(i).replace(/\s+/g, ' ').trim()}`).join('\n'),
      ];
    return blocks(props.children);
  });
}

/** The Markdown of a page whose component returns a LegalPage. */
export function legalMarkdown(page: () => ReactElement, metadata: Metadata): string {
  const el = page() as ReactElement<{
    title: string;
    lede: string;
    href: string;
    children: ReactNode;
  }>;
  if (el.type !== LegalPage) throw new Error('legalMarkdown: the page is not a LegalPage');
  const { title, lede, href, children } = el.props;
  return doc({
    path: href,
    title: title.replace(/\.$/, ''),
    summary: String(metadata.description ?? lede),
    body: [lede, `In effect from ${EFFECTIVE}.`, ...blocks(children)].join('\n\n'),
  });
}
