import { SITE_URL } from '../seo.ts';
import { markdownRoute, twinPath } from './negotiate.ts';

// The Markdown twins share one shape and one response: a title, the canonical page it mirrors and
// the date, then the page's content, served as text/markdown with the HTML page as canonical.

/** An absolute address on the site. */
export const abs = (path: string) => new URL(path, SITE_URL).toString();

export type Doc = {
  /** The page's path, e.g. `/pricing`. */
  path: string;
  title: string;
  /** One or two sentences under the title. */
  summary: string;
  /** YYYY-MM-DD the content last changed, when known. */
  updated?: string;
  /** The body, already Markdown, starting at ## level. */
  body: string;
};

/** A twin's whole text: the head every twin shares, then the body. */
export function doc({ path, title, summary, updated, body }: Doc): string {
  const meta = [
    `Canonical: ${abs(path)}`,
    updated && `Updated: ${updated}`,
    `Index: ${abs('/llms.txt')}`,
  ].filter(Boolean);
  return `# ${title}\n\n> ${summary}\n\n${meta.join(' · ')}\n\n${body.trim()}\n`;
}

/** The HTTP answer for a twin: Markdown, varying on Accept, pointing at its HTML page. */
export function markdownResponse(path: string, text: string): Response {
  return new Response(text, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      vary: 'Accept',
      link: `<${abs(path)}>; rel="canonical"`,
    },
  });
}

/** A cell's text with the characters that would break a table row escaped. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.map(cell).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${head.map((_, i) => cell(r[i] ?? '')).join(' | ')} |`),
  ].join('\n');
}

export const list = (items: readonly string[]) => items.map((i) => `- ${i}`).join('\n');

/** `[title](https://…/path) ([Markdown](https://…/path.md))`, the twin only where one exists. */
export const pageLink = (title: string, path: string) =>
  `[${title}](${abs(path)})${markdownRoute(path) ? ` ([Markdown](${abs(twinPath(path))}))` : ''}`;
