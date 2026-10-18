import {
  clips,
  edits,
  effect,
  idleStatus,
  type Schedule,
  schedule,
  timecode,
  timelineLabel,
} from './schedule.ts';
import type { SessionData } from './types.ts';

// The animation, loaded only when the session nears the screen. Every frame is a pure function
// of the time, drawn onto the markup the server rendered; stop() puts that markup back.

export type Driver = { play(): void; pause(): void; replay(): void; stop(): void };

const cl = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const eo = (v: number) => 1 - (1 - cl(v)) ** 3;
const TYPING = { user: 48, agent: 70 } as const;

export function drive(root: HTMLElement, data: SessionData): Driver {
  const s: Schedule = schedule(data);
  const x = (k: string) => root.querySelector<HTMLElement>(`[data-x="${k}"]`);
  const box = root.querySelector<HTMLElement>('.sx');
  const view = root.querySelector<HTMLElement>('.sx-view');
  const log = root.querySelector<HTMLElement>('.sx-log');
  const items = [...root.querySelectorAll<HTMLElement>('.sx-msg')];
  if (!box || !view || !log || items.length !== s.steps.length) return inert();

  // What the server rendered, kept so stop() can restore it exactly.
  const saved = new Map<HTMLElement, string>();
  const keep = (el: HTMLElement | null) => {
    if (el && !saved.has(el)) saved.set(el, el.innerHTML);
    return el;
  };
  const styled = new Map<HTMLElement, string | null>();
  const css = (el: HTMLElement | null, prop: 'opacity' | 'transform' | 'width', v: string) => {
    if (!el) return;
    if (!styled.has(el)) styled.set(el, el.getAttribute('style'));
    el.style[prop] = v;
  };

  const msgs = items.map((el, i) => {
    const step = s.steps[i];
    const text = el.querySelector<HTMLElement>('p');
    const ret = el.querySelector<HTMLElement>('.sx-ret');
    keep(text);
    keep(ret);
    return { el, step, text, ret, full: text?.textContent ?? '', scroll: 0 };
  });
  const segs = [...root.querySelectorAll<HTMLElement>('.sx-lane i')].map((el) => ({
    el,
    at: Number(el.dataset.at),
    w: Number(el.dataset.w),
  }));
  const el = {
    tl: keep(x('tl')),
    empty: x('empty'),
    shots: [0, 1, 2].map((i) => x(`shot${i}`)),
    tc: keep(x('tc')),
    lufs: x('lufs'),
    cap: keep(x('cap')),
    qa: x('qa'),
    exp: x('export'),
    bar: x('exportBar'),
    done: x('done'),
    a1: x('A1'),
    state: keep(x('state')),
    fade: x('fade'),
  };
  const created = effect(s.steps, 'timeline')?.answered ?? 0;
  const all = clips(s.steps);
  const loud = effect(s.steps, 'loudness');
  const qa = effect(s.steps, 'qa');
  const out = effect(s.steps, 'export');
  const caps = effect(s.steps, 'captions');
  const lines = data.preview.captions ?? [];
  const fps = data.preview.fps;
  const idle = idleStatus(s);
  const lastAt = s.steps.at(-1)?.answered ?? 0;

  box.classList.add('live');
  // Laid out once, full, so every message keeps its height while it types in.
  const measure = () => {
    const height = view.clientHeight;
    const gap = Number.parseFloat(getComputedStyle(log).rowGap) || 0;
    for (const m of msgs)
      m.scroll = Math.max(0, m.el.offsetTop + m.el.offsetHeight + gap * 2 - height);
  };
  measure();
  const resized = new ResizeObserver(measure);
  resized.observe(view);

  function draw(t: number) {
    let scroll = 0;
    let current = -1;
    for (const [i, m] of msgs.entries()) {
      const since = t - m.step.at;
      const on = since >= 0;
      css(m.el, 'opacity', on ? String(eo(since / 0.3)) : '0');
      css(m.el, 'transform', on ? `translateY(${(1 - eo(since / 0.3)) * 14}px)` : 'none');
      if (!on) continue;
      current = i;
      const prev = msgs[i - 1]?.scroll ?? 0;
      scroll = prev + (m.scroll - prev) * eo(since / 0.45);
      if (m.step.kind === 'call') {
        if (m.ret)
          m.ret.innerHTML =
            t >= m.step.answered
              ? (saved.get(m.ret) ?? '')
              : `<span class="sx-wait">${'·'.repeat(1 + (Math.floor(since * 6) % 3))}</span>`;
      } else if (m.text) {
        const n = Math.floor(cl(since * TYPING[m.step.kind], 0, m.full.length));
        m.text.textContent = m.full.slice(0, n);
        if (n < m.full.length) {
          const caret = document.createElement('span');
          caret.className = 'sx-caret';
          // The rest is laid out but unseen, so the bubble never grows as it types.
          const rest = document.createElement('span');
          rest.style.visibility = 'hidden';
          rest.textContent = m.full.slice(n);
          m.text.append(caret, rest);
        }
      }
    }
    css(log, 'transform', `translateY(${-scroll}px)`);

    // The preview
    const landed = all.filter((c) => t >= c.answered);
    css(el.empty, 'opacity', t >= created ? '0' : '1');
    if (el.tl) el.tl.textContent = timelineLabel(edits(s.steps, t));
    const last = landed.length - 1;
    const settled = landed.length === all.length && t > (all.at(-1)?.answered ?? 0) + 1.2;
    for (const [i, shot] of el.shots.entries()) {
      // The newest clip is on screen; once the last lands the preview cycles through them.
      let on = last >= 0 && i === last % 3;
      if (settled)
        on =
          i === Math.floor((t - (all.at(-1)?.answered ?? 0) - 1.2) / 2.2) % Math.min(3, all.length);
      const since = t - (all[i]?.answered ?? Number.POSITIVE_INFINITY);
      css(shot, 'opacity', on ? String(eo(since / 0.35)) : '0');
    }
    let secs = 0;
    const c = landed.at(-1);
    if (c) secs = c.effect.from + (c.effect.to - c.effect.from) * eo((t - c.answered) / 0.6);
    if (el.tc) el.tc.textContent = t >= created && c ? timecode(secs, fps) : '';

    if (el.cap && caps && t >= caps.answered && lines.length) {
      const k = Math.floor((t - caps.answered) / 0.32);
      const line = lines[Math.floor(k / 4) % lines.length] ?? [];
      const w = k % line.length;
      el.cap.innerHTML = '';
      for (const [j, word] of line.entries()) {
        const span = document.createElement('span');
        if (j === w) span.className = 'on';
        span.textContent = word;
        el.cap.append(span, ' ');
      }
      css(el.cap, 'opacity', String(eo((t - caps.answered) / 0.3)));
    } else css(el.cap, 'opacity', '0');

    if (loud)
      css(el.lufs, 'opacity', t >= loud.answered ? String(eo((t - loud.answered) / 0.3)) : '0');
    if (qa)
      css(
        el.qa,
        'opacity',
        String(
          t >= qa.answered
            ? eo((t - qa.answered) / 0.25) * (1 - eo((t - qa.answered - 1.1) / 0.3))
            : 0,
        ),
      );
    if (out) {
      const since = t - out.at;
      const wait = out.answered - out.at;
      css(el.exp, 'opacity', since >= 0 ? String(1 - eo((since - wait - 0.4) / 0.3)) : '0');
      css(el.bar, 'width', `${cl(since / wait) * 100}%`);
      css(el.done, 'opacity', t >= out.answered ? String(eo((t - out.answered) / 0.3)) : '0');
    }

    for (const g of segs) css(g.el, 'width', `${g.w * eo((t - g.at) / 0.5)}%`);
    // A1 lands dim with each clip and comes up to full once its loudness is set.
    if (loud)
      css(
        el.a1,
        'opacity',
        String(t >= loud.answered ? 0.45 + 0.55 * eo((t - loud.answered) / 0.4) : 0.45),
      );

    if (el.state) {
      const done = t >= lastAt + 1.2;
      el.state.classList.toggle('idle', done);
      el.state.textContent = done ? idle : current < 0 ? 'waiting for a prompt' : 'agent working';
    }
    css(el.fade, 'opacity', String(cl((t - s.fade[0]) / (s.fade[1] - s.fade[0]))));
  }

  let t = 0;
  let frame = 0;
  let then = 0;
  const tick = (now: number) => {
    t = (t + Math.min(0.1, (now - then) / 1000)) % s.length;
    then = now;
    draw(t);
    frame = requestAnimationFrame(tick);
  };
  const play = () => {
    if (frame) return;
    then = performance.now();
    draw(t);
    frame = requestAnimationFrame(tick);
  };
  const pause = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  draw(0);

  return {
    play,
    pause,
    replay() {
      t = 0;
      play();
    },
    stop() {
      pause();
      resized.disconnect();
      box.classList.remove('live');
      for (const [node, html] of saved) node.innerHTML = html;
      for (const [node, style] of styled)
        if (style === null) node.removeAttribute('style');
        else node.setAttribute('style', style);
    },
  };
}

function inert(): Driver {
  const no = () => {};
  return { play: no, pause: no, replay: no, stop: no };
}
