'use client';

import { track } from '@vercel/analytics';
import { useEffect } from 'react';

/**
 * Sends a "Click" event for every link and button clicked, so Web Analytics shows what people
 * click and where it takes them (the page is recorded with each event). The Pro plan allows two
 * properties: `label` (a `data-track` attribute, else the visible text) and `to` (a link's path,
 * or its full address when it leaves the site).
 */
export function Clicks() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const el = (event.target as Element | null)?.closest?.('a, button, [data-track]');
      if (!el) return;
      const text = el.getAttribute('data-track') ?? el.getAttribute('aria-label') ?? el.textContent;
      const label = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 100) || el.tagName;
      const href = el instanceof HTMLAnchorElement ? el.href : '';
      let to = '';
      if (href) {
        const url = new URL(href);
        to = (url.origin === location.origin ? url.pathname + url.hash : href).slice(0, 255);
      }
      track('Click', { label, to });
    };
    document.addEventListener('click', onClick, { capture: true });
    return () => document.removeEventListener('click', onClick, { capture: true });
  }, []);
  return null;
}
