'use client';

import { useEffect, useState } from 'react';

type Progress = { first_call_at: string | null; first_export_at: string | null };

/** The first prompt, with a copy button. */
export function Prompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-line prompt-line">
      <code>{text}</code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Waits for the server to see this account's first tool call, then its first export. */
export function FirstCall({ initial }: { initial: Progress }) {
  const [progress, setProgress] = useState(initial);
  const done = Boolean(progress.first_call_at && progress.first_export_at);

  useEffect(() => {
    if (done) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/first-call', { cache: 'no-store' });
        if (res.ok && !stop) setProgress((await res.json()) as Progress);
      } catch {
        // Offline for a moment; the next tick tries again.
      }
    };
    const timer = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [done]);

  return (
    <ol className="first-run" aria-live="polite">
      <li className={progress.first_call_at ? 'done' : 'waiting'}>
        {progress.first_call_at
          ? 'Your agent is connected.'
          : 'Waiting for your agent’s first call…'}
      </li>
      <li className={progress.first_export_at ? 'done' : progress.first_call_at ? 'waiting' : ''}>
        {progress.first_export_at
          ? 'First video exported. You’re set: bring your own footage next.'
          : 'Waiting for the first export.'}
      </li>
    </ol>
  );
}
