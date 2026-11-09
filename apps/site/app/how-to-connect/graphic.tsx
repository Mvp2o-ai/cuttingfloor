// The three ways in, drawn as one picture: an AI app, a REST call and MCP with a key each send
// work along a line into the editor, whose timeline fills while the finished video plays out the
// other side. Wide screens get it left to right; phones get the same picture top to bottom. The
// motion is CSS only and stops for anyone who asks for less motion.

type Box = { x: number; y: number; w: number; h: number };
type Source = Box & { title: string; sub: string; glyph: string[] };
type Layout = {
  view: [number, number];
  sources: Source[];
  core: Box;
  video: Box;
  /** Line from each source into the editor, and from the editor to the video. */
  links: string[];
  out: string;
};

const GLYPHS = {
  chat: ['M4 5h16v11H9l-5 4z', 'M8 9.5h8', 'M8 12.5h5'],
  braces: [
    'M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3',
    'M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3',
  ],
  key: ['M8 15a4 4 0 1 1 3.5-6', 'M11 11h10', 'M18 11v3', 'M15 11v2'],
};

const SOURCES = [
  { title: 'AI apps', sub: 'Kazi · ChatGPT · Claude · Codex', glyph: GLYPHS.chat },
  { title: 'REST API', sub: 'POST /v1/<tool>', glyph: GLYPHS.braces },
  { title: 'MCP + API key', sub: 'Bearer cf_…', glyph: GLYPHS.key },
];

function wide(): Layout {
  const sources = SOURCES.map((s, i) => ({ ...s, x: 20, y: 40 + i * 140, w: 390, h: 100 }));
  const core = { x: 520, y: 120, w: 340, h: 200 };
  const video = { x: 970, y: 40, w: 200, h: 356 };
  const cy = core.y + core.h / 2;
  return {
    view: [1190, 440],
    sources,
    core,
    video,
    links: sources.map(
      (s) =>
        `M${s.x + s.w} ${s.y + s.h / 2} C${s.x + s.w + 70} ${s.y + s.h / 2} ${core.x - 70} ${cy} ${core.x} ${cy}`,
    ),
    out: `M${core.x + core.w} ${cy} L${video.x} ${cy}`,
  };
}

function tall(): Layout {
  const sources = SOURCES.map((s, i) => ({ ...s, x: 8, y: 16 + i * 112, w: 350, h: 88 }));
  const core = { x: 24, y: 400, w: 334, h: 190 };
  const video = { x: 106, y: 670, w: 170, h: 302 };
  const bus = 384;
  return {
    view: [400, 1010],
    sources,
    core,
    video,
    // Each source runs out to one line down the right side, which turns in to the editor.
    links: sources.map(
      (s) => `M${s.x + s.w} ${s.y + s.h / 2} H${bus} V${core.y + core.h / 2} H${core.x + core.w}`,
    ),
    out: `M${core.x + core.w / 2} ${core.y + core.h} V${video.y}`,
  };
}

// The editor's timeline: a few clips per track, as fractions of its width, filled in order.
const CLIPS = [
  [0, 0.28, 0],
  [0.3, 0.62, 0],
  [0.64, 1, 0],
  [0.08, 0.46, 1],
  [0.5, 0.86, 1],
  [0, 0.4, 2],
  [0.42, 1, 2],
] as const;

function Picture({ layout, className }: { layout: Layout; className: string }) {
  const { view, sources, core, video, links, out } = layout;
  const track = (i: number) => core.y + 76 + i * 30;
  const left = core.x + 22;
  const width = core.w - 44;
  return (
    <svg
      className={`hc-graphic ${className}`}
      viewBox={`0 0 ${view[0]} ${view[1]}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`hc-sky-${className}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--key)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--bg-2)" stopOpacity="1" />
        </linearGradient>
      </defs>

      {links.map((d, i) => (
        <g key={d}>
          <path d={d} className="hc-line" />
          <path
            d={d}
            className="hc-flow"
            pathLength={100}
            style={{ animationDelay: `${i * 0.6}s` }}
          />
        </g>
      ))}
      <path d={out} className="hc-line" />
      <path d={out} className="hc-flow hc-flow-out" pathLength={100} />

      {sources.map((s, i) => (
        <g key={s.title} className="hc-source" style={{ animationDelay: `${i * 0.6}s` }}>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} rx="4" className="hc-box" />
          <g
            transform={`translate(${s.x + 22} ${s.y + s.h / 2 - 18}) scale(1.5)`}
            className="hc-glyph"
          >
            {s.glyph.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          <text x={s.x + 80} y={s.y + s.h / 2 - 4} className="hc-title">
            {s.title}
          </text>
          <text x={s.x + 80} y={s.y + s.h / 2 + 24} className="hc-sub">
            {s.sub}
          </text>
        </g>
      ))}

      <g>
        <rect x={core.x} y={core.y} width={core.w} height={core.h} rx="4" className="hc-core" />
        <text x={core.x + 22} y={core.y + 44} className="hc-title hc-core-name">
          cuttingfloor
        </text>
        {[0, 1, 2].map((i) => (
          <rect
            key={i}
            x={left}
            y={track(i)}
            width={width}
            height="20"
            rx="2"
            className="hc-track"
          />
        ))}
        {CLIPS.map(([a, b, t], i) => (
          <rect
            key={`${a}-${t}`}
            x={left + a * width}
            y={track(t) + 2}
            width={(b - a) * width - 3}
            height="16"
            rx="2"
            className={t === 2 ? 'hc-clip hc-clip-sound' : 'hc-clip'}
            style={{ animationDelay: `${0.4 + i * 0.35}s` }}
          />
        ))}
        <line
          x1={left}
          x2={left}
          y1={track(0) - 8}
          y2={track(2) + 28}
          className="hc-playhead"
          style={{ ['--run' as string]: `${width}px` }}
        />
      </g>

      <g>
        <rect
          x={video.x}
          y={video.y}
          width={video.w}
          height={video.h}
          rx="10"
          className="hc-phone"
        />
        <rect
          x={video.x + 8}
          y={video.y + 8}
          width={video.w - 16}
          height={video.h - 16}
          rx="5"
          fill={`url(#hc-sky-${className})`}
          className="hc-screen"
        />
        <circle
          cx={video.x + video.w / 2}
          cy={video.y + video.h * 0.42}
          r="26"
          className="hc-play-ring"
        />
        <path
          d={`M${video.x + video.w / 2 - 8} ${video.y + video.h * 0.42 - 13} l22 13 -22 13z`}
          className="hc-play"
        />
        <rect
          x={video.x + 20}
          y={video.y + video.h - 34}
          width={video.w - 40}
          height="4"
          rx="2"
          className="hc-bar"
        />
        <rect
          x={video.x + 20}
          y={video.y + video.h - 34}
          width={video.w - 40}
          height="4"
          rx="2"
          className="hc-bar-fill"
        />
        <text x={video.x + video.w / 2} y={video.y + video.h + 30} className="hc-sub hc-mid">
          your video
        </text>
      </g>
    </svg>
  );
}

export function WaysGraphic() {
  return (
    <figure className="hc-figure">
      <Picture layout={wide()} className="hc-wide" />
      <Picture layout={tall()} className="hc-tall" />
      <figcaption className="sr-only">
        Three ways in, one editor: an AI app, the REST API or MCP with an API key each send the edit
        to cuttingfloor, which builds the timeline and gives back the finished video.
      </figcaption>
    </figure>
  );
}
