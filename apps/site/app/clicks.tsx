'use client';

import { track } from '@vercel/analytics';
import { useEffect } from 'react';

/**
 * Sends a "Click: <label>" event for every link, button and question (a `<summary>`) clicked, so
 * Web Analytics shows what people click and where it takes them (the page is recorded with each
 * event). The label (a `data-track` attribute, else the visible text) is in the name because
 * Vercel can only group events by name, not by their data. The Pro plan allows two properties:
 * `label` again and `to` (a link's path, or its full address when it leaves the site).
 *
 * A video the visitor starts sends "Play: <file>", and one they turn the sound on in sends
 * "Sound on: <file>", by its path. Videos that play by themselves send nothing: only a play or
 * sound change within a second of the visitor touching that video counts.
 */
export function Clicks() {
  useEffect(() => {
    let touched: { el: Element; at: number } | undefined;
    const onClick = (event: MouseEvent) => {
      const el = (event.target as Element | null)?.closest?.('a, button, summary, [data-track]');
      if (!el) return;
      const text = el.getAttribute('data-track') ?? el.getAttribute('aria-label') ?? el.textContent;
      const label = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) || el.tagName;
      const href = el instanceof HTMLAnchorElement ? el.href : '';
      let to = '';
      if (href) {
        const url = new URL(href);
        to = (url.origin === location.origin ? url.pathname + url.hash : href).slice(0, 255);
      }
      track(`Click: ${label}`, { label, to });
    };
    const onTouch = (event: Event) => {
      const el = event.target as Element | null;
      if (el instanceof HTMLVideoElement) touched = { el, at: Date.now() };
    };
    const byVisitor = (el: EventTarget | null): el is HTMLVideoElement =>
      el instanceof HTMLVideoElement && touched?.el === el && Date.now() - touched.at < 1000;
    const name = (v: HTMLVideoElement) =>
      (
        v.getAttribute('data-track') ?? new URL(v.currentSrc || v.src, location.href).pathname
      ).slice(0, 100);
    const onPlay = (event: Event) => {
      if (!byVisitor(event.target)) return;
      const label = name(event.target);
      track(`Play: ${label}`, { label, to: '' });
    };
    const sounded = new WeakSet<HTMLVideoElement>();
    const onVolume = (event: Event) => {
      const v = event.target;
      if (!byVisitor(v) || v.muted || v.volume === 0 || sounded.has(v)) return;
      sounded.add(v);
      const label = name(v);
      track(`Sound on: ${label}`, { label, to: '' });
    };
    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('pointerdown', onTouch, { capture: true });
    document.addEventListener('keydown', onTouch, { capture: true });
    document.addEventListener('play', onPlay, { capture: true });
    document.addEventListener('volumechange', onVolume, { capture: true });
    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      document.removeEventListener('pointerdown', onTouch, { capture: true });
      document.removeEventListener('keydown', onTouch, { capture: true });
      document.removeEventListener('play', onPlay, { capture: true });
      document.removeEventListener('volumechange', onVolume, { capture: true });
    };
  }, []);
  return null;
}
