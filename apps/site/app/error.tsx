'use client';

import { SUPPORT_EMAIL } from '@cuttingfloor/plans';

// A page that failed to render. The shell is server-side, so this stays plain.
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="frame">
      <section className="cell marks">
        <span className="mark-b" />
        <span className="label">Something went wrong</span>
        <h1 className="display">That didn't load.</h1>
        <p className="lede">
          Try again in a moment. If it keeps happening, write to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and say which page.
        </p>
        <p className="actions">
          <button type="button" className="link-big as-button" onClick={() => reset()}>
            Try again
          </button>{' '}
          <a className="link-big" href="/">
            Go home
          </a>
        </p>
      </section>
    </main>
  );
}
