import { type Demo, finished, lengths } from '../../content/demos.ts';
import { Poster } from './poster.tsx';

/** Demo cards, before and after, each linking to its watch page. */
export function DemoCards({ demos }: { demos: Demo[] }) {
  return (
    <ol className="wt-hub dm-hub">
      {demos.map((d) => (
        <li key={d.slug}>
          <a href={`/demos/${d.slug}`} data-track={`Demo: ${d.title}`}>
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

/** A row of small thumbnails, the finished video's poster and title, each linking to its watch page. */
export function DemoThumbs({ demos }: { demos: Demo[] }) {
  return (
    <ol className="dm-thumbs">
      {demos.map((d) => {
        const v = finished(d);
        return (
          <li key={d.slug}>
            <a href={`/demos/${d.slug}`} data-track={`Demo: ${d.title}`}>
              {v.poster && (
                // biome-ignore lint/performance/noImgElement: a fixed-size poster, no layout shift
                <img src={v.poster} alt="" width={160} height={160} loading="lazy" />
              )}
              <span>{d.title}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
