import type { Way } from '../../content/ways.ts';
import { Copy } from '../walkthroughs/copy.tsx';
import { WayIconMark } from './icons.tsx';

// One way to connect as a card: its icon, what it is, a snippet to copy and where to go next.
// /how-to-connect and the engineers' guides both show them.

export function WayCard({ way }: { way: Way }) {
  return (
    <li className="hc-card" id={way.id}>
      <div className="hc-card-top">
        <WayIconMark icon={way.icon} />
        <h3>{way.name}</h3>
        {way.tag ? <span className="hc-tag">{way.tag}</span> : null}
      </div>
      <p>{way.text}</p>
      {way.snippet ? (
        <figure className="wt-prompt hc-snippet">
          <pre>
            <code>{way.snippet.code}</code>
          </pre>
          <figcaption>
            <span className="label">{way.snippet.label}</span>
            <Copy text={way.snippet.code} label="Copy" />
          </figcaption>
        </figure>
      ) : null}
      <p className="hc-links">
        {way.links.map((l, i) => (
          <a
            key={l.href}
            href={l.href}
            className={i === 0 ? 'hc-go' : undefined}
            data-track={l.track}
            {...(l.href.startsWith('http') ? { rel: 'noopener' } : {})}
          >
            {l.label}
          </a>
        ))}
      </p>
    </li>
  );
}
