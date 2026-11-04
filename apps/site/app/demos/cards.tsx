import { type Demo, finished, lengths } from '../../content/demos.ts';
import { Poster } from './poster.tsx';

/** Demo cards, before and after, each linking to its watch page. */
export function DemoCards({ demos }: { demos: Demo[] }) {
  return (
    <ol className="wt-hub dm-hub">
      {demos.map((d) => (
        <li key={d.slug}>
          <a href={`/demos/${d.slug}`}>
            <span className="dm-ba">
              <Poster v={d.raw} tag="Before" />
              <span className="dm-arrow" aria-hidden="true">
                →
              </span>
              <Poster v={finished(d)} tag="After" />
            </span>
            <h3>{d.title}</h3>
            <p>{d.description}</p>
            <span className="wt-hub-meta">
              {d.agent} · {lengths(d)}
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
