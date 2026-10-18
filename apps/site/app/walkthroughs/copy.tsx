'use client';

import { useState } from 'react';

/** Copies the prompt. Without JavaScript the prompt is still there to select. */
export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          },
          () => {},
        )
      }
    >
      {done ? 'Copied' : 'Copy prompt'}
    </button>
  );
}
