import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';

// The HTML an agent sends becomes one self-contained page. Nothing in it may come from the
// network: the bundled libraries are served from the image as lib/<file>, assets are files sent
// with the job, and any other reference the browser would load from the network is refused here,
// as an early, clear error. Chromium's own network is off as well, which is what stops a script.

/** Open-source libraries a page can load from lib/<file>: the package and the file in it. */
export const LIBRARIES: Record<string, [string, string]> = {
  'anime.umd.min.js': ['animejs', 'dist/bundles/anime.umd.min.js'],
  'anime.esm.min.js': ['animejs', 'dist/bundles/anime.esm.min.js'],
  'three.module.js': ['three', 'build/three.module.js'],
  'three.core.js': ['three', 'build/three.core.js'],
  'lottie.min.js': ['lottie-web', 'build/player/lottie.min.js'],
  'd3.min.js': ['d3', 'dist/d3.min.js'],
};

/** Where a lib/ file is on disk (package exports don't list these files, so not require). */
export function libraryPath(name: string): string | undefined {
  const lib = LIBRARIES[name];
  if (!lib) return undefined;
  const [pkg, rel] = lib;
  let dir = dirname(fileURLToPath(import.meta.resolve(pkg)));
  while (basename(dir) !== pkg && dirname(dir) !== dir) dir = dirname(dir);
  return join(dir, rel);
}

/** Elements with no end tag. */
const VOID = new Set(
  'area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr'.split(
    ' ',
  ),
);
/** Elements whose end tag HTML lets a page leave out. */
const OPTIONAL_END = new Set(
  'html head body p li dt dd option optgroup tr td th thead tbody tfoot colgroup caption rb rt rtc rp'.split(
    ' ',
  ),
);
/** Elements whose content is text up to their end tag, not markup. */
const RAW = new Set('script style textarea title xmp iframe noembed noframes noscript'.split(' '));
/** Text that shows on the page when CSS or markup ends up outside its tag. */
const MARKUP_IN_TEXT = [
  '/*',
  '*/',
  '@keyframes',
  '@font-face',
  '@media',
  '&lt;style',
  '&lt;script',
];

const isRemote = (url: string) => /^\s*(?:https?:|ftp:|wss?:|file:|[\\/]{2})/i.test(url);
const isSpace = (c: string | undefined) =>
  c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

class Remote extends Error {
  url: string;
  where: string;
  constructor(url: string, where: string) {
    super(url);
    this.url = url.trim().slice(0, 200);
    this.where = where;
  }
}

/** The first url() or @import in CSS that reaches the network, skipping comments. */
function remoteInCss(css: string): string | undefined {
  const lower = css.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    if (lower.startsWith('/*', i)) {
      const end = lower.indexOf('*/', i + 2);
      if (end === -1) return undefined;
      i = end + 1;
      continue;
    }
    let at = -1;
    if (lower.startsWith('url(', i)) at = i + 4;
    else if (lower.startsWith('@import', i)) at = i + 7;
    else continue;
    while (isSpace(lower[at])) at++;
    if (lower[at] === '"' || lower[at] === "'") at++;
    const value = css.slice(at, at + 200);
    if (isRemote(value)) return value.split(/[\s"')]/)[0];
  }
  return undefined;
}

/** Throws Remote when an attribute makes the browser load something from the network. */
function checkAttribute(tag: string, name: string, value: string): void {
  const where = `<${tag} ${name}>`;
  if (name === 'style') {
    const url = remoteInCss(value);
    if (url) throw new Remote(url, where);
  } else if (name === 'srcset' || name === 'imagesrcset') {
    for (const candidate of value.split(',')) {
      const url = candidate.trim().split(/\s/)[0] ?? '';
      if (isRemote(url)) throw new Remote(url, where);
    }
  } else if (
    // A link's href loads only when someone follows it; nobody clicks in a render.
    ((name === 'href' || name === 'xlink:href') && tag !== 'a' && tag !== 'area') ||
    name === 'src' ||
    name === 'poster' ||
    name === 'background' ||
    name === 'lowsrc' ||
    name === 'manifest' ||
    (name === 'data' && tag === 'object')
  ) {
    if (isRemote(value)) throw new Remote(value, where);
  }
}

/**
 * Reads the HTML once, start to end: throws CfError when the browser would load something from
 * the network (an attribute, CSS in a style tag or attribute, a meta refresh), and returns what
 * looks broken in how it parses. Script text is never read: a URL or fetch() in a script loads
 * nothing until it runs, and then the sandbox blocks it and the render reports it. A linear scan,
 * not regexes, so hostile input can't make it slow. Not a sanitizer: the page runs sandboxed.
 */
export function checkPage(html: string): string[] {
  const lower = html.toLowerCase();
  const warnings: string[] = [];
  const near = (at: number) => JSON.stringify(html.slice(at, at + 60));
  /** Open elements, innermost last, and how many of each name. */
  const open: string[] = [];
  const counts = new Map<string, number>();
  const shown = new Set<string>();
  const text = (from: number, to: number) => {
    const visible = lower.slice(from, to);
    for (const marker of MARKUP_IN_TEXT) {
      if (shown.has(marker) || !visible.includes(marker)) continue;
      const at = from + visible.indexOf(marker);
      shown.add(marker);
      warnings.push(
        `"${marker}" is in the page's visible text, near ${near(at)}: CSS and markup outside their tags show as text`,
      );
    }
  };
  try {
    let i = 0;
    while (i < html.length) {
      const lt = lower.indexOf('<', i);
      if (lt === -1) {
        text(i, html.length);
        break;
      }
      text(i, lt);
      const next = lower[lt + 1] ?? '';
      if (lower.startsWith('<!--', lt)) {
        const end = lower.indexOf('-->', lt + 4);
        if (end === -1) {
          warnings.push(`A comment never ends, so everything after it is hidden: ${near(lt)}`);
          break;
        }
        i = end + 3;
        continue;
      }
      if (next === '!' || next === '?') {
        const end = lower.indexOf('>', lt);
        if (end === -1) break;
        i = end + 1;
        continue;
      }
      const closing = next === '/';
      const nameAt = closing ? lt + 2 : lt + 1;
      if (!/[a-z]/.test(lower[nameAt] ?? '')) {
        i = lt + 1;
        continue;
      }
      // The tag name, then its attributes, to the >.
      let j = nameAt;
      while (j < html.length && !isSpace(lower[j]) && lower[j] !== '/' && lower[j] !== '>') j++;
      const tag = lower.slice(nameAt, j);
      const attrs = new Map<string, string>();
      let selfClosing = false;
      for (;;) {
        while (isSpace(lower[j]) || lower[j] === '/') {
          selfClosing = lower[j] === '/';
          j++;
        }
        if (j >= html.length) {
          warnings.push(`A tag never ends, so the rest of the page is inside it: ${near(lt)}`);
          return warnings;
        }
        if (lower[j] === '>') break;
        selfClosing = false;
        const from = j;
        while (
          j < html.length &&
          !isSpace(lower[j]) &&
          lower[j] !== '=' &&
          lower[j] !== '>' &&
          lower[j] !== '/'
        )
          j++;
        if (j === from) j++;
        const name = lower.slice(from, j);
        while (isSpace(lower[j])) j++;
        let value = '';
        if (lower[j] === '=') {
          j++;
          while (isSpace(lower[j])) j++;
          const quote = lower[j];
          if (quote === '"' || quote === "'") {
            const end = lower.indexOf(quote, j + 1);
            if (end === -1) {
              warnings.push(
                `A quote never closes, so the rest of the page is inside it: ${near(lt)}`,
              );
              return warnings;
            }
            value = html.slice(j + 1, end);
            j = end + 1;
          } else {
            const from = j;
            while (j < html.length && !isSpace(lower[j]) && lower[j] !== '>') j++;
            value = html.slice(from, j);
          }
        }
        if (!closing) {
          checkAttribute(tag, name, value);
          attrs.set(name, value);
        }
      }
      i = j + 1;
      if (closing) {
        if (counts.get(tag)) {
          const at = open.lastIndexOf(tag);
          for (const shut of open.splice(at)) counts.set(shut, (counts.get(shut) ?? 1) - 1);
        } else if (tag === 'style' || tag === 'script') {
          warnings.push(
            `</${tag}> closes a <${tag}> that was never opened, so what comes before it shows as text: ${near(lt)}`,
          );
        }
        continue;
      }
      if (tag === 'meta' && attrs.get('http-equiv')?.toLowerCase() === 'refresh') {
        const content = attrs.get('content') ?? '';
        const url = content.slice(content.toLowerCase().indexOf('url=') + 4).replace(/^['"]/, '');
        if (content.toLowerCase().includes('url=') && isRemote(url))
          throw new Remote(url, '<meta http-equiv=refresh>');
      }
      if (RAW.has(tag)) {
        const end = lower.indexOf(`</${tag}`, i);
        if (end === -1) {
          warnings.push(
            `<${tag}> never closes, so the rest of the page is inside it: add </${tag}> (${near(lt)})`,
          );
          break;
        }
        if (tag === 'style') {
          const url = remoteInCss(html.slice(i, end));
          if (url) throw new Remote(url, '<style>');
        }
        const close = lower.indexOf('>', end);
        i = close === -1 ? html.length : close + 1;
        continue;
      }
      if (!selfClosing && !VOID.has(tag) && !OPTIONAL_END.has(tag)) {
        open.push(tag);
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  } catch (error) {
    if (!(error instanceof Remote)) throw error;
    throw new CfError(
      'bad_request',
      `The HTML loads ${error.url} from the network (${error.where})`,
      {
        hint: `Pages render with no network: inline styles, SVG and scripts, use data: URIs, pass images and fonts as assets (assets/<name>), and load libraries from lib/ (${Object.keys(LIBRARIES).join(', ')}). CSS animations and the Web Animations API need no library.`,
        detail: { url: error.url, where: error.where },
      },
    );
  }
  const unclosed = [...counts].filter(([, n]) => n > 0);
  if (unclosed.length) {
    warnings.push(
      `Tags never closed by the end of the page: ${unclosed
        .slice(0, 10)
        .map(([tag, n]) => `<${tag}>${n > 1 ? ` ×${n}` : ''}`)
        .join(', ')}`,
    );
  }
  return warnings;
}

/** Where the first `<name …>` opening tag ends, or -1. */
function afterOpenTag(html: string, name: string): number {
  const lower = html.toLowerCase();
  for (let i = lower.indexOf(`<${name}`); i !== -1; i = lower.indexOf(`<${name}`, i + 1)) {
    if (/[\s/>]/.test(lower[i + name.length + 1] ?? '')) {
      const end = lower.indexOf('>', i);
      return end === -1 ? -1 : end + 1;
    }
  }
  return -1;
}

const insertAt = (html: string, at: number, text: string) =>
  `${html.slice(0, at)}${text}${html.slice(at)}`;

/** Throws when the HTML would load anything from outside itself, its assets and lib/. */
export function assertOffline(html: string): void {
  checkPage(html);
}

/**
 * The page as given, at a fixed size, on a transparent background: a fragment is wrapped in a
 * document, a whole document gets the base style first in its head. Check it with checkPage first.
 */
export function pageDocument(html: string, width: number, height: number): string {
  const base = `<style>html,body{margin:0;padding:0;background:transparent;width:${width}px;height:${height}px;overflow:hidden}</style>`;
  const head = afterOpenTag(html, 'head');
  if (head !== -1) return insertAt(html, head, base);
  const root = afterOpenTag(html, 'html');
  if (root !== -1) return insertAt(html, root, `<head>${base}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${html}</body></html>`;
}
