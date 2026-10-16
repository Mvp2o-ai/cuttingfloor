import { lintHyperframeHtml } from '@hyperframes/lint';
import { describe, expect, it } from 'vitest';
import { assertOffline, motionDocument, stillDocument } from '../src/index.ts';

const fragment = `<div id="t" class="clip" data-start="0" data-duration="2" data-track-index="0">Hi</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.from('#t', { opacity: 0, duration: 1 });
  window.__timelines = window.__timelines || {};
  window.__timelines.main = tl;
</script>`;

describe('motion documents', () => {
  it('wraps a fragment as the composition root and serves GSAP locally', async () => {
    const doc = motionDocument(fragment, { width: 1280, height: 720, duration: 2 });
    expect(doc).toMatchObject({ width: 1280, height: 720, duration: 2 });
    expect(doc.html).toContain('data-composition-id="main"');
    expect(doc.html).toContain('data-width="1280"');
    expect(doc.html).toContain('<script src="gsap.min.js"></script>');
    expect(doc.html).not.toContain('cdn.jsdelivr.net');
    const lint = await lintHyperframeHtml(doc.html, { host: 'cli' });
    expect(lint.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('takes a whole HyperFrames document with its own size and length', () => {
    const html = `<!doctype html><html><head></head><body><div id="root" data-composition-id="intro" data-start="0" data-duration="3.5" data-width="1080" data-height="1920"></div></body></html>`;
    const doc = motionDocument(html, { width: 1920, height: 1080, duration: 1 });
    expect(doc).toMatchObject({ width: 1080, height: 1920, duration: 3.5 });
    expect(doc.html).toMatch(/<head><script src="gsap.min.js"><\/script>/);
  });

  it('refuses anything that reaches for the network or the disk', () => {
    for (const html of [
      '<img src="https://example.com/a.png">',
      '<div style="background:url(\'http://x.test/b.png\')"></div>',
      '<style>@import "https://fonts.googleapis.com/css2?family=Inter";</style>',
      '<link href="//cdn.test/x.css" rel="stylesheet">',
      '<iframe src="file:///data/secret.key"></iframe>',
      '<script>fetch("/x")</script>',
      '<script>new WebSocket("ws://cuttingfloor:8787")</script>',
      '<script>navigator.sendBeacon("/x")</script>',
    ]) {
      expect(() => assertOffline(html), html).toThrow(/network/);
    }
    for (const html of [
      '<img src="assets/logo.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<p>Go fetch the ball</p>',
      fragment,
    ]) {
      expect(() => assertOffline(html), html).not.toThrow();
    }
  });

  it('lays a still out at its size on a transparent page', () => {
    const doc = stillDocument('<h1>Title</h1>', 640, 360);
    expect(doc).toContain('width:640px;height:360px');
    expect(doc).toContain('background:transparent');
    expect(
      stillDocument('<html><head><title>x</title></head><body></body></html>', 10, 10),
    ).toMatch(/<head><style>/);
  });
});
