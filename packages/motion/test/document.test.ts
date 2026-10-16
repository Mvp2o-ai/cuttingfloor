import { describe, expect, it } from 'vitest';
import { clockScript } from '../src/clock.ts';
import { assertOffline, LIBRARIES, libraryPath, pageDocument } from '../src/index.ts';

describe('pages', () => {
  it('refuses anything that reaches for the network or the disk', () => {
    for (const html of [
      '<img src="https://example.com/a.png">',
      '<div style="background:url(\'http://x.test/b.png\')"></div>',
      '<style>@import "https://fonts.googleapis.com/css2?family=Inter";</style>',
      '<link href="//cdn.test/x.css" rel="stylesheet">',
      '<iframe src="file:///data/secret.key"></iframe>',
      '<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>',
      '<script type="module">import * as THREE from "https://unpkg.com/three";</script>',
      '<script type="module">const m = await import("https://x.test/m.js");</script>',
      '<script>fetch("/x")</script>',
      '<script>new WebSocket("ws://cuttingfloor:8787")</script>',
      '<script>navigator.sendBeacon("/x")</script>',
    ]) {
      expect(() => assertOffline(html), html).toThrow(/network/);
    }
    for (const html of [
      '<img src="assets/logo.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<script src="lib/anime.umd.min.js"></script>',
      '<script type="module">import * as THREE from "./lib/three.module.js";</script>',
      '<p>Go fetch the ball</p>',
    ]) {
      expect(() => assertOffline(html), html).not.toThrow();
    }
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
    const started = performance.now();
    pageDocument(`${'<head'.repeat(50_000)}${'<script src=x'.repeat(20_000)}`, 10, 10);
    expect(performance.now() - started).toBeLessThan(1000);
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
