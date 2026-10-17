'use client';

import { useEffect, useRef, useState } from 'react';

// One real session, replayed: the calls an agent makes and what each does to the timeline.
const PROMPT =
  'Cut my 40-minute interview into a 60-second vertical teaser. Captions on, loud enough for phones.';

type Step = {
  fn: string;
  args: string;
  ret: string;
  /** Clips that land on the timeline when this call returns. */
  clips?: { track: 'V2' | 'V1' | 'A1'; from: number; to: number; label: string; kind?: string }[];
  /** Fills the render bar. */
  render?: boolean;
};

const STEPS: Step[] = [
  {
    fn: 'media.import',
    args: '{ source: { url: "…/interview.mp4" } }',
    ret: 'm_7f2c… · 40:12 · 1080p · ready',
  },
  { fn: 'media.analyze', args: '{ kind: "transcript" }', ret: '6,412 words, timed' },
  {
    fn: 'timeline.create',
    args: '{ sequence: { width: 1080, height: 1920, fps: 30 } }',
    ret: 'tl_01… · empty',
  },
  {
    fn: 'clip.add',
    args: '{ source: { words: [812, 861] } }',
    ret: 'tl_02… · V1 00:00–00:14',
    clips: [
      { track: 'V1', from: 0, to: 23, label: 'interview' },
      { track: 'A1', from: 0, to: 23, label: '', kind: 'aud' },
    ],
  },
  {
    fn: 'clip.add',
    args: '{ source: { words: [2209, 2260] } }',
    ret: 'tl_03… · V1 00:14–00:31',
    clips: [
      { track: 'V1', from: 23.4, to: 52, label: 'interview' },
      { track: 'A1', from: 23.4, to: 52, label: '', kind: 'aud' },
    ],
  },
  {
    fn: 'clip.add',
    args: '{ source: { words: [5120, 5198] } }',
    ret: 'tl_04… · V1 00:31–00:58',
    clips: [
      { track: 'V1', from: 52.4, to: 97, label: 'interview' },
      { track: 'A1', from: 52.4, to: 97, label: '', kind: 'aud' },
    ],
  },
  {
    fn: 'caption.add',
    args: '{ from_transcript: { clip_id: "c_1" } }',
    ret: 'tl_05… · 84 captions on V2',
    clips: [{ track: 'V2', from: 0, to: 97, label: 'captions · karaoke', kind: 'cap' }],
  },
  { fn: 'audio.set_loudness', args: '{ target_lufs: -14 }', ret: 'tl_06… · measured −14.1 LUFS' },
  { fn: 'qa.check', args: '{ timeline_id: "tl_06…" }', ret: 'no gaps · no black · sync ok' },
  {
    fn: 'export.video',
    args: '{ preset: "social_9x16_h264" }',
    ret: 'teaser.mp4 · 00:00:58:12 · signed link',
    render: true,
  },
];

const TRACKS = ['V2', 'V1', 'A1'] as const;

export function Bay() {
  const [shown, setShown] = useState(0);
  const [render, setRender] = useState(0);
  const [frame, setFrame] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  // Steps play one after another, then the session starts over.
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setShown(STEPS.length);
      setRender(100);
      return;
    }
    let step = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      step += 1;
      if (step > STEPS.length) {
        timer = setTimeout(() => {
          step = 0;
          setShown(0);
          setRender(0);
          timer = setTimeout(next, 900);
        }, 3200);
        return;
      }
      setShown(step);
      timer = setTimeout(next, STEPS[step - 1]?.render ? 2600 : 1100);
    };
    timer = setTimeout(next, 1200);
    return () => clearTimeout(timer);
  }, []);

  // The export fills its bar once its call shows.
  useEffect(() => {
    if (!STEPS.slice(0, shown).some((s) => s.render)) return;
    const id = setInterval(() => setRender((r) => Math.min(100, r + 6)), 90);
    return () => clearInterval(id);
  }, [shown]);

  // A running timecode for the program monitor.
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % (60 * 30)), 1000 / 30);
    return () => clearInterval(id);
  }, []);

  // Keep the newest call in view once the log outgrows its window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when a call appears
  useEffect(() => {
    const log = logRef.current;
    if (log && log.scrollHeight > log.clientHeight)
      log.scrollTo({ top: log.scrollHeight - log.clientHeight, behavior: 'smooth' });
    else log?.scrollTo({ top: 0 });
  }, [shown]);

  const clips = STEPS.slice(0, shown).flatMap((s) => s.clips ?? []);
  const end = clips.reduce((m, c) => Math.max(m, c.to), 0);
  const tc = `00:00:${String(Math.floor(frame / 30)).padStart(2, '0')}:${String(frame % 30).padStart(2, '0')}`;

  return (
    <div className="bay">
      <section className="win agent" aria-label="An agent's session">
        <div className="win-bar">
          <span>Agent</span>
          <span className="grip" />
          <span>claude</span>
        </div>
        <div className="agent-log" ref={logRef}>
          <div className="prompt">{PROMPT}</div>
          {STEPS.map((s, i) => (
            <p key={s.fn + s.args} className={`call${i < shown ? ' on' : ''}`}>
              <span className="fn">{s.fn}</span> <span className="args">{s.args}</span>
              <span className="ret">{s.ret}</span>
            </p>
          ))}
          {shown < STEPS.length && <span className="caret" />}
        </div>
      </section>

      <section className="win" aria-label="Program monitor">
        <div className="win-bar">
          <span>Program</span>
          <span className="grip" />
          <span className="rec">● rec</span>
        </div>
        <Monitor />
        <div className="program-hud">
          <span className="tc">{tc}</span>
          <span className={render === 100 ? 'on' : ''}>
            {render === 100 ? '✓ solved' : `${STEPS[Math.max(0, shown - 1)]?.fn ?? 'idle'}`}
          </span>
        </div>
      </section>

      <section className="win" aria-label="Timeline">
        <div className="win-bar">
          <span>Timeline</span>
          <span className="grip" />
          <span>tl_{String(Math.max(1, shown - 1)).padStart(2, '0')}</span>
        </div>
        <div className="timeline">
          <div className="ruler">
            {['00', '15', '30', '45', '60'].map((s, i) => (
              <span key={s} style={{ left: `${i * 24}%` }}>
                :{s}
              </span>
            ))}
          </div>
          {TRACKS.map((t) => (
            <div className="track" key={t}>
              <span className="track-name">{t}</span>
              <div className="lane">
                {clips
                  .filter((c) => c.track === t)
                  .map((c) => (
                    <ClipBox key={`${c.track}-${c.from}`} {...c} />
                  ))}
                {t === 'V2' && (
                  <span className="playhead" style={{ left: `${Math.min(97, end)}%` }} />
                )}
              </div>
            </div>
          ))}
          <div
            className="render-bar"
            role="progressbar"
            aria-label="Export progress"
            aria-valuenow={render}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${render}%` }} />
          </div>
        </div>
      </section>
    </div>
  );
}

function ClipBox(c: { from: number; to: number; label: string; kind?: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <span
      className={`clip${c.kind ? ` ${c.kind}` : ''}${on ? ' on' : ''}`}
      style={{ left: `${c.from}%`, width: `${c.to - c.from}%` }}
    >
      {c.label}
    </span>
  );
}

// 4×4 Bayer matrix for an ordered dither.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** The reel, played through a two-ink ordered dither: bone on warm black. */
function Monitor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!video || !canvas || !ctx) return;
    const w = 256;
    const h = 144;
    canvas.width = w;
    canvas.height = h;
    let raf = 0;
    const draw = () => {
      if (video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum =
              (0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0)) / 255;
            const on = Math.min(1, lum * 1.9 + 0.04) > (BAYER[(y % 4) * 4 + (x % 4)] ?? 0.5);
            d[i] = on ? 238 : 14;
            d[i + 1] = on ? 232 : 13;
            d[i + 2] = on ? 220 : 11;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    video.play().catch(() => {});
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="program-screen" aria-hidden="true">
      <video ref={videoRef} src="/reel.mp4" muted loop playsInline autoPlay preload="auto" />
      <canvas ref={canvasRef} />
    </div>
  );
}
