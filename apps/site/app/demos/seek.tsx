'use client';

import { useEffect } from 'react';

// A key-moment link (?t=12) starts the finished video at that second, as search expects.
export function Seek({ target }: { target: string }) {
  useEffect(() => {
    const t = Number(new URLSearchParams(window.location.search).get('t'));
    const v = document.getElementById(target);
    if (!(v instanceof HTMLVideoElement) || !Number.isFinite(t) || t <= 0) return;
    v.preload = 'auto';
    const go = () => {
      v.currentTime = t;
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
    v.scrollIntoView({ block: 'center' });
  }, [target]);
  return null;
}
