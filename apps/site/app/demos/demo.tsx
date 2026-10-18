'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Demo } from '../../content/demos.ts';

// A creator's own agent with cuttingfloor plugged in, editing a real clip: the editor window
// (transcript and preview) and the agent's chat over its corner. The server renders it finished,
// so every word is in the HTML; in view, it plays from the top and loops. Reduced motion keeps
// the finished state.

const TYPE = 30; // characters a second, typing the prompt
const STREAM = 55; // characters a second, the agent answering
const CALL = 0.65; // seconds between tool calls landing

type Beat = {
  typeAt: number;
  sendAt: number;
  replyAt: number;
  callsAt: number[];
  swapAt: number;
  doneAt: number;
  endAt: number;
};

function plan(demo: Demo): { beats: Beat[]; length: number } {
  let t = 0.6;
  const beats = demo.turns.map((turn) => {
    const typeAt = t;
    const sendAt = typeAt + turn.prompt.length / TYPE + 0.35;
    const replyAt = sendAt + 0.6;
    const callsStart = replyAt + turn.reply.length / STREAM + 0.4;
    const callsAt = turn.calls.map((_, i) => callsStart + i * CALL);
    const swapAt = callsStart + turn.calls.length * CALL + 0.3;
    const doneAt = swapAt + 0.4;
    const endAt = doneAt + turn.done.length / STREAM + 2.6;
    t = endAt;
    return { typeAt, sendAt, replyAt, callsAt, swapAt, doneAt, endAt };
  });
  return { beats, length: t + 2 };
}

/** The agents the demo is shown in, one per loop, starting from the demo's own. */
const AGENTS = ['Claude', 'ChatGPT', 'Kazi'] as const;

const slice = (text: string, since: number, cps: number) =>
  since <= 0 ? '' : text.slice(0, Math.floor(since * cps));

export function AgentDemo({ demo }: { demo: Demo }) {
  const { beats, length } = useMemo(() => plan(demo), [demo]);
  const root = useRef<HTMLDivElement>(null);
  // Infinity is the finished state: what the server renders and reduced motion keeps.
  const [t, setT] = useState(Number.POSITIVE_INFINITY);
  const [loop, setLoop] = useState(0);
  const agent = AGENTS[(AGENTS.indexOf(demo.agent) + loop) % AGENTS.length] ?? demo.agent;

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let start = 0;
    let shown = false;
    const tick = (now: number) => {
      if (!start) start = now;
      const elapsed = (now - start) / 1000;
      setT(elapsed % length);
      setLoop(Math.floor(elapsed / length));
      frame = requestAnimationFrame(tick);
    };
    const seen = new IntersectionObserver(
      ([e]) => {
        const on = e?.isIntersecting ?? false;
        if (on && !shown) {
          shown = true;
          start = 0;
          frame = requestAnimationFrame(tick);
        } else if (!on && shown) {
          shown = false;
          cancelAnimationFrame(frame);
        }
      },
      { threshold: 0.4 },
    );
    seen.observe(el);
    return () => {
      seen.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [length]);

  // Which video is up: the raw clip until the first turn swaps it, and so on.
  let stage = 0;
  for (const [i, b] of beats.entries()) if (t >= b.swapAt) stage = i + 1;
  const videos = [demo.raw, ...demo.turns.map((x) => x.video)];

  // The composer: the prompt being typed, if one is.
  const typing = beats.findIndex((b) => t >= b.typeAt && t < b.sendAt);
  const draft =
    typing >= 0
      ? slice(demo.turns[typing]?.prompt ?? '', t - (beats[typing]?.typeAt ?? 0), TYPE)
      : '';
  const working = beats.findIndex((b) => t >= b.replyAt && t < b.doneAt);
  const sending = beats.some((b) => t >= b.sendAt - 0.15 && t < b.sendAt + 0.15);

  return (
    <div className="demo" ref={root}>
      <div className="demo-editor">
        <div className="demo-chrome" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>{agent} · showing the file cuttingfloor made</span>
        </div>
        <div className="demo-body">
          <p className="demo-transcript">
            {demo.transcript.map((w, i) => {
              const at = w.cut === undefined ? undefined : beats[w.cut]?.callsAt[1];
              const struck = at !== undefined && t >= at + (i % 4) * 0.12;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the transcript is fixed
                <span key={i}>{struck ? <del>{w.text}</del> : w.text} </span>
              );
            })}
          </p>
          <div className="demo-video">
            {videos.map((v, i) => (
              <VideoLayer key={v.src} src={v.src} poster={v.poster} on={i === stage} />
            ))}
            <span className="demo-file">{videos[stage]?.label}</span>
          </div>
        </div>
      </div>

      <section className="demo-chat" aria-label={`${agent}, with cuttingfloor connected`}>
        <header>
          <span className={`demo-agent ${agent.toLowerCase()}`} aria-hidden="true">
            {agent[0]}
          </span>
          <b>{agent}</b>
          <span className="demo-tool">
            <i aria-hidden="true" />
            cuttingfloor
          </span>
        </header>
        <ol className="demo-log">
          {demo.turns.map((turn, i) => {
            const b = beats[i];
            if (!b || t < b.sendAt) return null;
            const reply =
              t === Number.POSITIVE_INFINITY
                ? turn.reply
                : slice(turn.reply, t - b.replyAt, STREAM);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the turns are fixed
              <li key={i}>
                <p className="demo-you">{turn.prompt}</p>
                {reply && <p className="demo-says">{reply}</p>}
                <ul className="demo-calls">
                  {turn.calls.map((c, j) =>
                    t >= (b.callsAt[j] ?? 0) ? (
                      <li key={c.fn + c.note}>
                        Used <b>cuttingfloor</b> › <code>{c.fn}</code> <span>{c.note}</span>
                      </li>
                    ) : null,
                  )}
                </ul>
                {working === i && t >= (b.callsAt[0] ?? 0) && (
                  <p className="demo-status">{turn.status}</p>
                )}
                {t >= b.doneAt && (
                  <p className="demo-says">
                    {t === Number.POSITIVE_INFINITY
                      ? turn.done
                      : slice(turn.done, t - b.doneAt, STREAM)}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
        <div className="demo-composer" aria-hidden="true">
          <span className={draft ? '' : 'empty'}>{draft || `Ask ${agent}…`}</span>
          <span className={`demo-send${sending ? ' hit' : ''}`}>↑</span>
        </div>
      </section>
      <p className="demo-note">
        Shown in your agent: Claude, ChatGPT or Kazi. cuttingfloor does the editing and hands back
        the file; your agent shows it to you.
      </p>
    </div>
  );
}

/** One of the stacked videos: plays while it is the one on screen. */
function VideoLayer({ src, poster, on }: { src: string; poster?: string; on: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (on) {
      v.currentTime = 0;
      v.play().catch(() => {});
    } else v.pause();
  }, [on]);
  return (
    <video
      ref={ref}
      className={on ? 'on' : ''}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
    />
  );
}
