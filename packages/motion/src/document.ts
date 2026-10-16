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

const GSAP_SCRIPT = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*gsap[^"']*["'][^>]*>\s*<\/script>/gi;
const REMOTE =
  /(?:\b(?:src|href|srcset|poster|action|data)\s*=\s*["']?\s*|url\(\s*["']?|@import\s+["']?)(?:https?:|ftp:|wss?:|file:|\/\/)/i;
const REMOTE_JS =
  /\b(?:fetch\s*\(|new\s+(?:XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection)\b|importScripts\s*\(|sendBeacon\s*\()/;

/** Throws when the HTML reaches for anything outside itself and its assets. */
export function assertOffline(html: string): void {
  const stripped = html.replace(GSAP_SCRIPT, '');
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
    const doc = html.replace(GSAP_SCRIPT, '');
    return {
      html: /<head[^>]*>/i.test(doc)
        ? doc.replace(/<head[^>]*>/i, (h) => `${h}${gsap}`)
        : `${gsap}${doc}`,
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
${html.replace(GSAP_SCRIPT, '')}
</div>
</body></html>
`,
  };
}

/** A still: the page as given, at a fixed size, on a transparent background. */
export function stillDocument(html: string, width: number, height: number): string {
  assertOffline(html);
  const base = `<style>html,body{margin:0;padding:0;background:transparent;width:${width}px;height:${height}px;overflow:hidden}</style>`;
  if (/<html[\s>]/i.test(html)) {
    return /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (h) => `${h}${base}`)
      : html.replace(/<html[^>]*>/i, (h) => `${h}<head>${base}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${html}</body></html>`;
}
