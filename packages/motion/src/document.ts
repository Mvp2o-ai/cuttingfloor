import { CfError } from '@cuttingfloor/schema';

// The HTML an agent sends becomes one self-contained HyperFrames document. Nothing in it may
// come from the network: GSAP is served from the image, assets are files sent with the job, and
// any other remote reference is refused here (Chromium's own network is off as well).

export const COMPOSITION_ID = 'main';

export interface MotionDocument {
  html: string;
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
}

const REMOTE =
  /(?:\b(?:src|href|srcset|poster|action|data)\s*=\s*["']?\s*|url\(\s*["']?|@import\s+["']?)(?:https?:|ftp:|wss?:|file:|\/\/)/i;
const REMOTE_JS =
  /\b(?:fetch\s*\(|new\s+(?:XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection)\b|importScripts\s*\(|sendBeacon\s*\()/;

/**
 * The HTML without its GSAP script tags (any CDN's): the image serves GSAP itself. A linear scan,
 * not a regex, so hostile input can't make it slow. Not a sanitizer: the page runs sandboxed.
 */
function withoutGsap(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let from = 0;
  for (;;) {
    const start = lower.indexOf('<script', from);
    const open = start === -1 ? -1 : lower.indexOf('>', start);
    const close = open === -1 ? -1 : lower.indexOf('</script>', open);
    if (close === -1) break;
    const tag = lower.slice(start, open + 1);
    const empty = lower.slice(open + 1, close).trim() === '';
    out += html.slice(
      from,
      tag.includes('src') && tag.includes('gsap') && empty ? start : close + 9,
    );
    from = close + 9;
  }
  return out + html.slice(from);
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

/** Throws when the HTML reaches for anything outside itself and its assets. */
export function assertOffline(html: string): void {
  const stripped = withoutGsap(html);
  const remote = REMOTE.exec(stripped);
  if (remote) {
    throw new CfError('bad_request', 'The HTML refers to something on the network', {
      hint: 'Motion graphics render with no network: inline styles and SVG, use data: URIs, or pass images and fonts as assets and refer to them as assets/<name>. GSAP is provided.',
      detail: { near: stripped.slice(remote.index, remote.index + 80) },
    });
  }
  const js = REMOTE_JS.exec(stripped);
  if (js) {
    throw new CfError(
      'bad_request',
      `The HTML uses ${js[0].replace(/[\s(]+$/, '')}, and there is no network to reach`,
      {
        hint: 'Build everything in the page itself; pass images and fonts as assets',
      },
    );
  }
}

/** Wraps a fragment as the composition root, or takes a full HyperFrames document as is. */
export function motionDocument(
  html: string,
  options: { width: number; height: number; duration: number },
): MotionDocument {
  assertOffline(html);
  const gsap = '<script src="gsap.min.js"></script>';
  if (/data-composition-id\s*=/.test(html)) {
    const attr = (name: string) => {
      const m = new RegExp(`data-${name}\\s*=\\s*["']?([0-9.]+)`).exec(html);
      return m ? Number(m[1]) : undefined;
    };
    const doc = withoutGsap(html);
    const head = afterOpenTag(doc, 'head');
    return {
      html: head === -1 ? `${gsap}${doc}` : insertAt(doc, head, gsap),
      width: attr('width') ?? options.width,
      height: attr('height') ?? options.height,
      duration: attr('duration') ?? options.duration,
    };
  }
  const { width, height, duration } = options;
  return {
    width,
    height,
    duration,
    html: `<!doctype html>
<html><head><meta charset="utf-8">${gsap}
<style>html,body{margin:0;padding:0;background:transparent}#root{position:relative;overflow:hidden;width:${width}px;height:${height}px}</style>
</head><body>
<div id="root" data-composition-id="${COMPOSITION_ID}" data-start="0" data-duration="${duration}" data-width="${width}" data-height="${height}">
${withoutGsap(html)}
</div>
</body></html>
`,
  };
}

/** A still: the page as given, at a fixed size, on a transparent background. */
export function stillDocument(html: string, width: number, height: number): string {
  assertOffline(html);
  const base = `<style>html,body{margin:0;padding:0;background:transparent;width:${width}px;height:${height}px;overflow:hidden}</style>`;
  const head = afterOpenTag(html, 'head');
  if (head !== -1) return insertAt(html, head, base);
  const root = afterOpenTag(html, 'html');
  if (root !== -1) return insertAt(html, root, `<head>${base}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${html}</body></html>`;
}
