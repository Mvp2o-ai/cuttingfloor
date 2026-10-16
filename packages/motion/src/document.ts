import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfError } from '@cuttingfloor/schema';

// The HTML an agent sends becomes one self-contained page. Nothing in it may come from the
// network: the bundled libraries are served from the image as lib/<file>, assets are files sent
// with the job, and any other remote reference is refused here (Chromium's own network is off
// as well).

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

const REMOTE =
  /(?:\b(?:src|href|srcset|poster|action|data)\s*=\s*(?:["']\s*)?|url\(\s*["']?|@import\s+["']?|\bimport\s*(?:\(\s*)?["']|\bfrom\s+["'])(?:https?:|ftp:|wss?:|file:|\/\/)/i;
const REMOTE_JS =
  /\b(?:fetch\s*\(|new\s+(?:XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection)\b|importScripts\s*\(|sendBeacon\s*\()/;

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

/** Throws when the HTML reaches for anything outside itself, its assets and lib/. */
export function assertOffline(html: string): void {
  const remote = REMOTE.exec(html);
  if (remote) {
    throw new CfError('bad_request', 'The HTML refers to something on the network', {
      hint: `Pages render with no network: inline styles, SVG and scripts, use data: URIs, pass images and fonts as assets (assets/<name>), and load libraries from lib/ (${Object.keys(LIBRARIES).join(', ')}). CSS animations and the Web Animations API need no library.`,
      detail: { near: html.slice(remote.index, remote.index + 80) },
    });
  }
  const js = REMOTE_JS.exec(html);
  if (js) {
    throw new CfError(
      'bad_request',
      `The HTML uses ${js[0].replace('(', '').trim()}, and there is no network to reach`,
      { hint: 'Build everything in the page itself; pass images and fonts as assets' },
    );
  }
}

/**
 * The page as given, at a fixed size, on a transparent background: a fragment is wrapped in a
 * document, a whole document gets the base style first in its head.
 */
export function pageDocument(html: string, width: number, height: number): string {
  assertOffline(html);
  const base = `<style>html,body{margin:0;padding:0;background:transparent;width:${width}px;height:${height}px;overflow:hidden}</style>`;
  const head = afterOpenTag(html, 'head');
  if (head !== -1) return insertAt(html, head, base);
  const root = afterOpenTag(html, 'html');
  if (root !== -1) return insertAt(html, root, `<head>${base}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${html}</body></html>`;
}
