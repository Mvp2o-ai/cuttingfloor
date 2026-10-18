'use client';

import { useState } from 'react';

/** Copies the text. Without JavaScript the text is still there to select. */
export function Copy({ text, label = 'Copy prompt' }: { text: string; label?: string }) {
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
      {done ? 'Copied' : label}
    </button>
  );
}
