'use client';

import { useEffect, useRef, useState } from 'react';

// One scripted session, rendered with create.motion (source: motion/session.html): wide for
// desktop, tall for phones. Nothing loads until it scrolls near; it plays only while in view.
const CUTS = {
  wide: { src: '/session.mp4', poster: '/session.jpg', width: 1920, height: 1080 },
  tall: { src: '/session-tall.mp4', poster: '/session-tall.jpg', width: 1080, height: 1440 },
} as const;

// What the video shows, as text for screen readers and crawlers.
export const SESSION = [
  [
    'You',
    'Cut my 40-minute interview into a 60-second vertical teaser. Captions on, loud enough for phones.',
  ],
  ['Agent', 'On it. Importing the footage and reading the transcript first.'],
  ['media.import', 'm_7f2c, 40:12, 1080p, ready'],
  ['media.analyze { kind: "transcript" }', '6,412 words, timed'],
  ['Agent', 'I have the transcript. Three passages hold the argument — taking those.'],
  ['timeline.create { 1080x1920, 30fps }', 'tl_01, empty'],
  ['clip.add { words: [812, 861] }', 'V1 00:00–00:14'],
  ['clip.add { words: [2209, 2260] }', 'V1 00:14–00:31'],
  ['clip.add { words: [5120, 5198] }', 'V1 00:31–00:58'],
  ['Agent', 'Checking my own work before I hand it over.'],
  ['caption.add { from_transcript: true }', '84 captions on V2'],
  ['audio.set_loudness { target_lufs: -14 }', 'measured −14.1 LUFS'],
  ['qa.check { timeline_id: "tl_06" }', 'no gaps, no black frames, sync ok'],
  ['export.video { preset: "social_9x16_h264" }', 'teaser.mp4, 00:00:58:12, signed link'],
  [
    'Agent',
    'Done — 58 seconds, captioned, −14 LUFS, and it passes its own checks. Here’s the file.',
  ],
] as const;

/** Anything that links here (#session) plays the session from the top. */
export const SESSION_ID = 'session';

export function Session() {
  const ref = useRef<HTMLVideoElement>(null);
  const [cut, setCut] = useState<keyof typeof CUTS>('wide');
  const [near, setNear] = useState(false);
  const [still, setStill] = useState(false);
  const inView = useRef(false);

  useEffect(() => {
    const tall = window.matchMedia('(max-width: 700px)');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pick = () => {
      setCut(tall.matches ? 'tall' : 'wide');
      setStill(reduce.matches);
    };
    pick();
    tall.addEventListener('change', pick);
    reduce.addEventListener('change', pick);
    return () => {
      tall.removeEventListener('change', pick);
      reduce.removeEventListener('change', pick);
    };
  }, []);

  // Load when it comes within a screen of view; play while at least half of it shows.
  useEffect(() => {
    const video = ref.current;
    if (!video || still) return;
    const load = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), {
      rootMargin: '100% 0px',
    });
    const play = new IntersectionObserver(
      ([e]) => {
        inView.current = e?.isIntersecting ?? false;
        if (inView.current) video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.5 },
    );
    const onHash = () => {
      if (window.location.hash !== `#${SESSION_ID}`) return;
      setNear(true);
      restart(video);
    };
    load.observe(video);
    play.observe(video);
    window.addEventListener('hashchange', onHash);
    return () => {
      load.disconnect();
      play.disconnect();
      window.removeEventListener('hashchange', onHash);
    };
  }, [still]);

  // The source arrives after the first look; start it if it is already on screen.
  useEffect(() => {
    if (near && inView.current) ref.current?.play().catch(() => {});
  }, [near]);

  const c = CUTS[cut];
  return (
    <figure className="session">
      <div className="session-screen" style={{ aspectRatio: `${c.width} / ${c.height}` }}>
        {/* The poster is the finished session: what reduced motion shows, and the first paint. */}
        <video
          ref={ref}
          src={near && !still ? c.src : undefined}
          poster={c.poster}
          width={c.width}
          height={c.height}
          muted
          loop
          playsInline
          preload={near ? 'auto' : 'none'}
        />
        <ol className="sr-only">
          {SESSION.map(([who, what]) => (
            <li key={who + what}>
              {who}: {what}
            </li>
          ))}
        </ol>
      </div>
      <figcaption>
        <p className="session-note">
          Every edit is a tool call. Every call returns a timeline and a picture of it — so the
          agent sees what it made before it ships.
        </p>
        {!still && (
          <button
            type="button"
            className="replay"
            onClick={() => {
              setNear(true);
              if (ref.current) restart(ref.current);
            }}
          >
            ↻ Replay
          </button>
        )}
      </figcaption>
    </figure>
  );
}

function restart(video: HTMLVideoElement) {
  video.currentTime = 0;
  video.play().catch(() => {});
}
