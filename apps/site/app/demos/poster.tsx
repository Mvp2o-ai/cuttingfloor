import { type DemoVideo, length } from '../../content/demos.ts';

/** A demo's poster frame with its tag and length, as the demo cards show it. */
export function Poster({ v, tag }: { v: DemoVideo; tag: string }) {
  return (
    <span className="dm-poster">
      {v.poster && (
        // biome-ignore lint/performance/noImgElement: a fixed-size poster, no layout shift
        <img
          src={v.poster}
          alt=""
          width={v.wide ? 960 : 540}
          height={v.wide ? 540 : 960}
          loading="lazy"
          className={v.wide ? 'wide' : undefined}
        />
      )}
      <span className="label">
        {tag} · {length(v)}
      </span>
    </span>
  );
}
