'use client';

import { useEffect, useRef } from 'react';

// Asks for the Kazi link once per page load (two at once for a new account would race Kazi's
// account creation) and goes there in place of this page, so Back from Kazi doesn't come here to
// ask again. No link, or no answer in time: the welcome page.
export function Opening() {
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    fetch('/api/kazi-link', { method: 'POST', signal: AbortSignal.timeout(20_000) })
      .then((res) => res.json() as Promise<{ url?: string | null }>)
      .then((body) => body.url ?? '/welcome')
      .catch(() => '/welcome')
      .then((to) => location.replace(to));
  }, []);
  return (
    <p className="lede">
      Setting up your account and the live demo. This takes a few seconds.{' '}
      <noscript>
        <a href="/welcome">Continue</a>
      </noscript>
    </p>
  );
}
