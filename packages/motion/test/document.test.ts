import { describe, expect, it } from 'vitest';
import { clockScript } from '../src/clock.ts';
import { assertOffline, checkPage, LIBRARIES, libraryPath, pageDocument } from '../src/index.ts';

describe('pages', () => {
  it('refuses anything the browser would load from the network or the disk', () => {
    for (const html of [
      '<img src="https://example.com/a.png">',
      '<img srcset="assets/a.png 1x, https://x.test/b.png 2x">',
      '<div style="background:url(\'http://x.test/b.png\')"></div>',
      '<style>.a { background: url( https://x.test/b.png ) }</style>',
      '<style>@import "https://fonts.googleapis.com/css2?family=Inter";</style>',
      '<link href="//cdn.test/x.css" rel="stylesheet">',
      '<iframe src="file:///data/secret.key"></iframe>',
      '<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>',
      '<video poster=https://x.test/p.jpg></video>',
      '<svg><image href="https://x.test/i.png"/></svg>',
      '<object data="https://x.test/o.svg"></object>',
      '<base href="https://x.test/">',
      '<meta http-equiv="refresh" content="0; url=https://x.test/">',
    ]) {
      expect(() => assertOffline(html), html).toThrow(/network/);
    }
    for (const html of [
      '<img src="assets/logo.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<script src="lib/anime.umd.min.js"></script>',
      '<script type="module">import * as THREE from "./lib/three.module.js";</script>',
      '<p>Go fetch the ball</p>',
      // Script text loads nothing until it runs, and then the sandbox blocks it.
      '<script>console.warn("See https://example.com/docs"); function f() { return fetch("https://x.test") }</script>',
      '<script>const s = "<img src=\'https://x.test/a.png\'>"; new WebSocket("ws://x.test")</script>',
      '<a href="https://example.com">a link nobody follows</a>',
      '<style>/* from https://x.test/theme */ .a { color: red }</style>',
      '<p>https://example.com and url(https://x.test)</p>',
    ]) {
      expect(() => assertOffline(html), html).not.toThrow();
    }
  });

  it('says how to fix a network reference', () => {
    try {
      checkPage('<p>x</p><style>.a{background:url("https://x.test/b.png")}</style>');
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({
        code: 'bad_request',
        message: 'The HTML loads https://x.test/b.png from the network (<style>)',
        hint: expect.stringMatching(/assets\/<name>.*lib\//),
        detail: { url: 'https://x.test/b.png', where: '<style>' },
      });
    }
  });

  it('reports what looks broken in how a page parses, without refusing it', () => {
    expect(checkPage('<div><p>fine<br><img src="assets/a.png"></div><svg><rect/></svg>')).toEqual(
      [],
    );
    expect(checkPage('<div><span>open')).toEqual([
      'Tags never closed by the end of the page: <div>, <span>',
    ]);
    expect(checkPage('<div>.a { color: red } /* title */</div>')[0]).toMatch(
      /^"\/\*" is in the page's visible text/,
    );
    expect(checkPage('@keyframes x { to { opacity: 0 } }</style><p>hi</p>')).toEqual([
      expect.stringMatching(/"@keyframes" is in the page's visible text/),
      expect.stringMatching(/^<\/style> closes a <style> that was never opened/),
    ]);
    expect(checkPage('<p>a</p><script>let x = 1;')).toEqual([
      expect.stringMatching(/^<script> never closes/),
    ]);
    expect(checkPage('<p>a</p><!-- note <p>b</p>')).toEqual([
      expect.stringMatching(/^A comment never ends/),
    ]);
    expect(checkPage('<p class="a>b</p>')).toEqual([
      expect.stringMatching(/^A quote never closes/),
    ]);
    // CSS and code inside their own tags are not text.
    expect(checkPage('<style>/* a */ @keyframes x {}</style><script>/* b */</script>')).toEqual([]);
  });

  it('lays a page out at its size on a transparent background', () => {
    const doc = pageDocument('<h1>Title</h1>', 640, 360);
    expect(doc).toContain('width:640px;height:360px');
    expect(doc).toContain('background:transparent');
    expect(pageDocument('<html><head><title>x</title></head><body></body></html>', 10, 10)).toMatch(
      /<head><style>/,
    );
    expect(pageDocument('<HTML><BODY></BODY></HTML>', 10, 10)).toMatch(/<HTML><head><style>/);
  });

  it('handles hostile input in linear time', () => {
    for (const html of [
      `${'<head'.repeat(50_000)}${'<script src=x'.repeat(20_000)}`,
      `<span>${'<div>'.repeat(100_000)}</span>${'</b>'.repeat(100_000)}`,
      `<div>${'<p a=b c="d" e>'.repeat(50_000)}${'/'.repeat(100_000)}`,
      `<style>${'url( '.repeat(100_000)}</style>${'x '.repeat(100_000)}`,
    ]) {
      const started = performance.now();
      checkPage(html);
      pageDocument(html, 10, 10);
      expect(performance.now() - started, html.slice(0, 20)).toBeLessThan(1000);
    }
  });

  it('bundles open-source libraries that resolve', async () => {
    const { existsSync } = await import('node:fs');
    for (const name of Object.keys(LIBRARIES))
      expect(existsSync(libraryPath(name) ?? '')).toBe(true);
    expect(libraryPath('gsap.min.js')).toBeUndefined();
  });
});

interface FakeWindow {
  setTimeout(f: () => void, ms: number): number;
  setInterval(f: () => void, ms: number): number;
  requestAnimationFrame(f: (t: number) => void): number;
  Date: DateConstructor;
  __cf: { seek(s: number): Promise<void> };
}

describe('the virtual clock', () => {
  /** Runs the clock in a fake window and returns it. */
  function page() {
    const win: Record<string, unknown> = {
      setTimeout,
      document: { getAnimations: () => [], querySelectorAll: () => [] },
    };
    const perf = { now: () => 0 };
    new Function('window', 'performance', 'document', 'Date', clockScript(7))(
      win,
      perf,
      win.document,
      Date,
    );
    return { win: win as unknown as FakeWindow, perf };
  }

  it('fires timers and frames on the virtual clock, in order', async () => {
    const { win, perf } = page();
    const seen: string[] = [];
    win.setTimeout(() => seen.push(`t500@${perf.now()}`), 500);
    win.setInterval(() => seen.push(`i300@${perf.now()}`), 300);
    win.requestAnimationFrame((t) => seen.push(`raf@${t}`));
    await win.__cf.seek(0);
    expect(seen).toEqual(['raf@0']);
    await win.__cf.seek(0.7);
    expect(seen).toEqual(['raf@0', 'i300@300', 't500@500', 'i300@600']);
    expect(perf.now()).toBe(700);
    expect(win.Date.now()).toBe(1767225600000 + 700);
  });

  it('seeds crypto.getRandomValues and randomUUID like Math.random', () => {
    const draw = (seed: number) => {
      const win: Record<string, unknown> = {
        setTimeout,
        crypto: {
          getRandomValues: (a: Uint8Array) => globalThis.crypto.getRandomValues(a),
          randomUUID: () => globalThis.crypto.randomUUID(),
        },
        document: { getAnimations: () => [], querySelectorAll: () => [] },
      };
      new Function('window', 'performance', 'document', 'Date', clockScript(seed))(
        win,
        { now: () => 0 },
        win.document,
        Date,
      );
      const crypto = win.crypto as typeof globalThis.crypto;
      return {
        bytes: [...crypto.getRandomValues(new Uint8Array(7))],
        words: [...crypto.getRandomValues(new Uint32Array(2))],
        uuid: crypto.randomUUID(),
      };
    };
    const once = draw(7);
    expect(draw(7)).toEqual(once);
    expect(draw(8)).not.toEqual(once);
    expect(once.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // The real checks still apply: 64 KB at most.
    const win = {
      crypto: { getRandomValues: (a: Uint8Array) => globalThis.crypto.getRandomValues(a) },
    };
    new Function('window', 'performance', 'document', 'Date', clockScript(1))(
      { ...win, setTimeout },
      { now: () => 0 },
      {},
      Date,
    );
    expect(() => win.crypto.getRandomValues(new Uint8Array(70_000))).toThrow();
  });

  it('seeks Web Animations to their age on the clock', async () => {
    const anim = {
      playState: 'running',
      currentTime: 123,
      pause() {
        this.playState = 'paused';
      },
    };
    const win: Record<string, unknown> = {
      setTimeout,
      document: { getAnimations: () => [anim], querySelectorAll: () => [] },
    };
    new Function('window', 'performance', 'document', 'Date', clockScript(1))(
      win,
      { now: () => 0 },
      win.document,
      Date,
    );
    const cf = win.__cf as { seek(s: number): Promise<void> };
    await cf.seek(0);
    expect(anim).toMatchObject({ playState: 'paused', currentTime: 0 });
    await cf.seek(1.5);
    expect(anim.currentTime).toBe(1500);
  });
});
