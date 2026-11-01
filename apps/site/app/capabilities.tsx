'use client';

import { useEffect, useRef, useState } from 'react';
import { CAPS } from '../content/capabilities.ts';

export function Capabilities() {
  const [active, setActive] = useState(0);
  const items = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i));
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const el of items.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, []);

  const cap = CAPS[active] ?? CAPS[0];

  return (
    <div className="caps">
      <ol className="caps-list">
        {CAPS.map((c, i) => (
          <li
            key={c.title}
            data-i={i}
            ref={(el) => {
              items.current[i] = el;
            }}
            className={[i === active ? 'on' : '', 'feature' in c ? 'feature' : '']
              .filter(Boolean)
              .join(' ')}
          >
            {'feature' in c && <span className="label cap-tag">The review loop</span>}
            <h3 className={'feature' in c ? 'cap-feature-title' : undefined}>{c.title}</h3>
            <p className={'feature' in c ? 'cap-feature-body' : undefined}>{c.body}</p>
          </li>
        ))}
      </ol>
      <div className="caps-pane">
        <div className="win">
          <div className="win-bar">
            <span>tools/call</span>
            <span className="grip" />
            <span>
              {String(active + 1).padStart(2, '0')}/{String(CAPS.length).padStart(2, '0')}
            </span>
          </div>
          <pre>
            {cap.code.map(([fn, args]) => (
              <span key={fn + args}>
                <span className="k">{fn}</span> {args}
                {'\n\n'}
              </span>
            ))}
            <span className="c">{`// ${cap.note}`}</span>
          </pre>
        </div>
      </div>
    </div>
  );
}
