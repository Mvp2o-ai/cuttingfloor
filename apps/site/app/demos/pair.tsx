'use client';

import { useEffect, useRef } from 'react';
import { type DemoVideo, length } from '../../content/demos.ts';

// The demo's result before anything else: the finished video, bigger and playing, with the clip
// it came from beside it, so the first thing a visitor sees is what the agent made, not the raw
// footage. Both play muted on a loop; the finished one has controls for sound. Reduced motion
// keeps the posters.

export function BeforeAfter({ before, after }: { before: DemoVideo; after: DemoVideo }) {
  return (
    <div className="dm-pair">
      <figure className="dm-pair-after">
        <Loop v={after} controls />
        <figcaption>
          <span className="label">After</span>Ready to post · {length(after)}
        </figcaption>
      </figure>
      <figure className="dm-pair-before">
        <Loop v={before} />
        <figcaption>
          <span className="label">Before</span>As it came in · {length(before)}
        </figcaption>
      </figure>
    </div>
  );
}

export function Loop({ v, controls }: { v: DemoVideo; controls?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    // A hidden variant (from.tsx) stays a poster.
    if (!el || el.offsetParent === null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.play().catch(() => {});
  }, []);
  return (
    <video
      ref={ref}
      src={v.src}
      poster={v.poster}
      width={v.wide ? 960 : 540}
      height={v.wide ? 540 : 960}
      className={v.wide ? 'wide' : undefined}
      muted
      loop
      playsInline
      preload="metadata"
      controls={controls}
    />
  );
}
