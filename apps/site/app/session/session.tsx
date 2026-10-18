import { Player } from './player.tsx';
import { clips, edits, effect, idleStatus, schedule, timecode, timelineLabel } from './schedule.ts';
import type { SessionData, Track } from './types.ts';

// The session as the server renders it: finished. That is what crawlers, readers without
// JavaScript and reduced motion get, and every word of it is real text. The player loads the
// animation only when the session comes near the screen, and plays it on this same markup.

const TRACKS: Track[] = ['V2', 'V1', 'A1'];

export function Session({
  id,
  data,
  note,
  families = false,
}: {
  id: string;
  data: SessionData;
  note: string;
  /** Colour each call by its tool family (media, clip, audio…) instead of all in gold. */
  families?: boolean;
}) {
  const s = schedule(data);
  const { length, fps, aspect, captions } = data.preview;
  const all = clips(s.steps);
  const last = all.length - 1;
  const loud = effect(s.steps, 'loudness');
  const qa = effect(s.steps, 'qa');
  const out = effect(s.steps, 'export');
  const tracks = data.tracks ?? TRACKS;
  const lanes = tracks.map((track) => ({
    track,
    segs: s.steps.flatMap((step, i) => {
      if (step.kind !== 'call' || !step.effect) return [];
      const e = step.effect;
      const on =
        (e.type === 'clip' && e.tracks.includes(track)) ||
        (e.type === 'captions' && e.track === track);
      if (!on) return [];
      const edges = [e.from, ...(e.type === 'clip' ? (e.cuts ?? []) : []), e.to];
      // A hair of lane between clips, so each cut shows.
      const gap = length / 400;
      return edges.slice(1).map((to, j) => {
        const from = (edges[j] ?? 0) + gap;
        return {
          key: `${i}-${j}`,
          at: step.answered,
          left: from / length,
          width: (to - gap - from) / length,
        };
      });
    }),
  }));

  return (
    <figure className={`session${families ? ' families' : ''}`} data-session={id}>
      <div className="sx">
        <div className={`sx-frame${aspect === '16:9' ? ' wide' : ''}`}>
          <section className="sx-pane" aria-label="The conversation">
            <div className="sx-bar" aria-hidden="true">
              <span className="sx-dot" />
              <b>connected</b>
              <span className="sx-mcp">· cuttingfloor mcp</span>
              <span className="sx-grow" />
              <span>agent: {data.agent}</span>
            </div>
            <div className="sx-view">
              <ol className="sx-log">
                {s.steps.map((step, i) =>
                  step.kind === 'call' ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the script is fixed; order is identity
                    <li key={i} className="sx-msg sx-call">
                      <div>
                        <code className="sx-fn" data-family={step.fn.split('.')[0]}>
                          {step.fn}
                        </code>{' '}
                        <code className="sx-args">{step.args}</code>
                      </div>
                      <div className="sx-ret">
                        <i aria-hidden="true">←</i> <span>{step.ret}</span>
                      </div>
                    </li>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the script is fixed; order is identity
                    <li key={i} className={`sx-msg sx-${step.kind}`}>
                      <div className="sx-who">{step.kind === 'user' ? 'You' : 'Agent'}</div>
                      <p>{step.text}</p>
                    </li>
                  ),
                )}
              </ol>
            </div>
          </section>

          <section className="sx-pane sx-right" aria-hidden="true">
            <div className="sx-bar">
              <b>preview</b>
              <span>{aspect}</span>
              <span className="sx-grow" />
              <span data-x="tl">{timelineLabel(edits(s.steps, Number.POSITIVE_INFINITY))}</span>
            </div>
            <div className="sx-stage">
              <div className="sx-screen">
                <div className="sx-empty" data-x="empty">
                  waiting for
                  <br />a timeline
                </div>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="sx-shot"
                    data-x={`shot${i}`}
                    style={{ opacity: i === last % 3 ? 1 : 0 }}
                  >
                    <Shot id={`${id}-${i}`} i={i} wide={aspect === '16:9'} />
                  </div>
                ))}
                <div className="sx-tc" data-x="tc">
                  {timecode(s.seconds, fps)}
                </div>
                {loud && (
                  <div className="sx-lufs" data-x="lufs">
                    {loud.effect.reading}
                  </div>
                )}
                {captions?.[0] && (
                  <div className="sx-cap" data-x="cap">
                    {captions[0].join(' ')}
                  </div>
                )}
                {qa && (
                  <div className="sx-qa" data-x="qa">
                    {qa.effect.checks.map((c) => (
                      <span key={c}>{c}</span>
                    ))}
                  </div>
                )}
                {out && (
                  <>
                    <div className="sx-export" data-x="export">
                      <i data-x="exportBar" />
                    </div>
                    <div className="sx-done" data-x="done">
                      {out.effect.file} ✓
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="sx-tracks">
              {lanes.map(({ track, segs }) => (
                <div key={track} className={`sx-track ${track}`}>
                  <span>{track}</span>
                  <div className="sx-lane" data-x={track}>
                    {segs.map((g) => (
                      <i
                        key={g.key}
                        data-at={g.at}
                        data-w={g.width * 100}
                        style={{ left: `${g.left * 100}%`, width: `${g.width * 100}%` }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="sx-status">
              <span className="sx-state idle" data-x="state">
                {idleStatus(s)}
              </span>
            </div>
          </section>
        </div>
        <div className="sx-fade" data-x="fade" />
      </div>
      <figcaption>
        <p className="session-note">{note}</p>
        <Player id={id} data={data} />
      </figcaption>
    </figure>
  );
}

/** One of three framings of a speaker: warm key light, the room falling off. */
function Shot({ id, i, wide }: { id: string; i: number; wide: boolean }) {
  const tone = [
    ['#3a2a1d', '#120d09'],
    ['#24302c', '#0b0f0d'],
    ['#3b2f24', '#100c09'],
  ][i] as [string, string];
  const sx = [0, -18, 14][i] ?? 0;
  const zoom = [1, 1.18, 1.08][i] ?? 1;
  return (
    <svg
      viewBox={wide ? '-35 38 160 90' : '0 0 90 160'}
      preserveAspectRatio="xMidYMid slice"
      role="presentation"
    >
      <defs>
        <radialGradient id={`${id}-g`} cx={0.38 + i * 0.1} cy="0.32" r="0.9">
          <stop offset="0" stopColor={tone[0]} />
          <stop offset="1" stopColor={tone[1]} />
        </radialGradient>
        <linearGradient id={`${id}-s`} x1="0" x2="1">
          <stop offset="0" stopColor="#e3b48a" />
          <stop offset="0.12" stopColor="#5a3f2e" />
          <stop offset="0.4" stopColor="#1c1510" />
          <stop offset="1" stopColor="#120d0a" />
        </linearGradient>
      </defs>
      <rect x="-100" y="-100" width="300" height="400" fill={`url(#${id}-g)`} />
      <rect x={62 + sx / 3} y="20" width="14" height="70" fill="#000" opacity="0.25" />
      <g transform={`translate(${45 + sx} 92) scale(${zoom}) translate(-45 -92)`}>
        <path
          d="M8 160 C10 122 26 112 45 110 C64 112 80 122 82 160 Z"
          fill="#14110e"
          stroke="#6b4d36"
          strokeWidth="0.6"
        />
        <path d="M38 104 L52 104 L50 116 L40 116 Z" fill="#1c1510" />
        <ellipse cx="45" cy="80" rx="15.5" ry="19.5" fill={`url(#${id}-s)`} />
        <path
          d="M29 76 C28 58 38 54 46 55 C57 55 63 62 61 78 C58 66 50 62 42 64 C35 65 31 70 29 76 Z"
          fill="#17120e"
        />
      </g>
    </svg>
  );
}
