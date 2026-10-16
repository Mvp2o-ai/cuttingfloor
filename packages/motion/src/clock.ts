// Virtual time for frame-exact capture. This script runs in the page before any of its own code
// and replaces every clock a page can animate by (requestAnimationFrame, timers, Date,
// performance.now, Math.random's seed) with one the renderer steps a frame at a time. Each step
// also pauses and seeks the page's CSS animations, transitions and Web Animations, SVG (SMIL)
// animations and <video>/<audio> elements, then calls window.__seek(seconds) if the page defines
// it (canvas, WebGL or anything drawn by hand). So any animated page renders as written, with no
// special contract: if it animates in a browser, it renders.

/** The page-side clock. `seed` makes Math.random repeatable, so the same recipe renders the same. */
export function clockScript(seed: number): string {
  return `(() => {
  if (window.__cf) return;
  let seed = ${seed >>> 0};
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const EPOCH = 1767225600000;
  let now = 0;
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(EPOCH + now);
      else super(...args);
    }
    static now() {
      return EPOCH + now;
    }
  }
  window.Date = VirtualDate;
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true });

  const realSetTimeout = window.setTimeout.bind(window);
  let nextId = 1;
  const timers = new Map();
  const run = (fn, args) => {
    try {
      if (typeof fn === 'function') fn(...args);
      else (0, eval)(String(fn));
    } catch (e) {
      console.error(e);
    }
  };
  const schedule = (fn, delay, args, repeat) => {
    const id = nextId++;
    const ms = Math.max(0, Number(delay) || 0);
    timers.set(id, { fn, args, at: now + ms, every: repeat ? Math.max(1, ms) : 0 });
    return id;
  };
  window.setTimeout = (fn, delay, ...args) => schedule(fn, delay, args, false);
  window.setInterval = (fn, delay, ...args) => schedule(fn, delay, args, true);
  window.clearTimeout = window.clearInterval = (id) => void timers.delete(id);

  let frames = new Map();
  window.requestAnimationFrame = (fn) => {
    const id = nextId++;
    frames.set(id, fn);
    return id;
  };
  window.cancelAnimationFrame = (id) => void frames.delete(id);

  const born = new WeakMap();
  const age = (thing) => {
    if (!born.has(thing)) born.set(thing, now);
    return now - born.get(thing);
  };
  const settle = (media) =>
    new Promise((resolve) => {
      if (!media.seeking) return resolve();
      const done = () => resolve();
      media.addEventListener('seeked', done, { once: true });
      realSetTimeout(done, 5000);
    });

  async function seek(seconds) {
    const target = Math.max(now, seconds * 1000);
    // Timers due before this frame fire in order, each seeing its own due time.
    for (let guard = 0; guard < 100000; guard++) {
      let id;
      let next;
      for (const [k, t] of timers) {
        if (t.at <= target && (!next || t.at < next.at)) {
          id = k;
          next = t;
        }
      }
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.delete(id);
      run(next.fn, next.args);
    }
    now = target;
    const due = frames;
    frames = new Map();
    for (const fn of due.values()) run(fn, [now]);
    for (const a of document.getAnimations()) {
      try {
        const t = age(a);
        if (a.playState !== 'paused') a.pause();
        a.currentTime = t;
      } catch (e) {}
    }
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.ownerSVGElement || typeof svg.setCurrentTime !== 'function') continue;
      svg.pauseAnimations();
      svg.setCurrentTime(age(svg) / 1000);
    }
    const media = [];
    for (const m of document.querySelectorAll('video, audio')) {
      const t = age(m) / 1000;
      m.muted = true;
      if (!m.paused) m.pause();
      const d = m.duration;
      const at = Number.isFinite(d) && d > 0 ? (m.loop ? t % d : Math.min(t, d)) : t;
      if (Math.abs(m.currentTime - at) > 0.0005) m.currentTime = at;
      media.push(settle(m));
    }
    await Promise.all(media);
    if (typeof window.__seek === 'function') await window.__seek(now / 1000);
  }
  window.__cf = { seek, now: () => now };
})();`;
}
