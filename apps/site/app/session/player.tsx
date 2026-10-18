'use client';

import { useEffect, useRef, useState } from 'react';
import type { Driver } from './driver.ts';
import type { SessionData } from './types.ts';

// Plays the session the server rendered. The driver is fetched when the session comes within a
// screen of view and runs only while a third of it shows; under reduced motion it never loads and
// the finished session stays as it is. Linking to #<id> replays it.
export function Player({ id, data }: { id: string; data: SessionData }) {
  const ref = useRef<HTMLSpanElement>(null);
  const driver = useRef<Driver | null>(null);
  const loader = useRef<(() => Promise<Driver>) | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const root = ref.current?.closest<HTMLElement>('figure');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!root || reduce.matches) return;
    setLive(true);
    let visible = false;
    let gone = false;
    let pending: Promise<Driver> | null = null;
    const load = () => {
      pending ??= import('./driver.ts').then(({ drive }) => {
        const d = drive(root, data);
        if (gone) d.stop();
        driver.current = d;
        return d;
      });
      return pending;
    };
    loader.current = load;
    const near = new IntersectionObserver(([e]) => e?.isIntersecting && load(), {
      rootMargin: '100% 0px',
    });
    const half = new IntersectionObserver(
      ([e]) => {
        visible = e?.isIntersecting ?? false;
        if (visible) load().then((d) => visible && d.play());
        else driver.current?.pause();
      },
      { threshold: 0.35 },
    );
    const onHash = () => {
      if (window.location.hash === `#${id}`) load().then((d) => d.replay());
    };
    near.observe(root);
    half.observe(root);
    window.addEventListener('hashchange', onHash);
    onHash();
    const onReduce = () => {
      if (reduce.matches) {
        driver.current?.stop();
        setLive(false);
      }
    };
    reduce.addEventListener('change', onReduce);
    return () => {
      gone = true;
      near.disconnect();
      half.disconnect();
      window.removeEventListener('hashchange', onHash);
      reduce.removeEventListener('change', onReduce);
      driver.current?.stop();
      driver.current = null;
    };
  }, [id, data]);

  return (
    <span ref={ref}>
      {live && (
        <button
          type="button"
          className="replay"
          onClick={() => loader.current?.().then((d) => d.replay())}
        >
          ↻ Replay
        </button>
      )}
    </span>
  );
}
