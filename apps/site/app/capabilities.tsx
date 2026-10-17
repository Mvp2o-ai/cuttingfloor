'use client';

import { useEffect, useRef, useState } from 'react';

// What an agent can do, each with the call that does it. The calls are real tool arguments.
const CAPS = [
  {
    title: 'Cut by what was said.',
    body: 'Transcribe once, then cut on words instead of timecodes. The agent reads the transcript and lifts the lines it wants.',
    code: [
      ['media.analyze', '{ media_id: "m_7f2c…", kind: "transcript" }'],
      [
        'clip.add',
        '{ timeline_id: "tl_01…", track_id: "V1",\n  media_id: "m_7f2c…", source: { words: [812, 861] } }',
      ],
    ],
    note: 'whisper.cpp, on our servers',
  },
  {
    title: 'Captions that keep time.',
    body: 'Captions come from the transcript and follow every speed change and cut. Karaoke, word pop, typewriter, boxes, outlines.',
    code: [
      [
        'caption.add',
        '{ timeline_id: "tl_05…", track_id: "V2",\n  from_transcript: { clip_id: "c_1", max_words: 4 } }',
      ],
      [
        'text.set',
        '{ timeline_id: "tl_06…", track_id: "V2",\n  style: { highlight: { mode: "karaoke", color: "#ff4a1c" } } }',
      ],
    ],
    note: 'rendered by libass, frame-exact',
  },
  {
    title: 'Mix like an engineer.',
    body: 'Duck music under speech, ride gain with keyframes, crossfade at the cut, and land the whole thing at −14 LUFS.',
    code: [
      ['audio.duck', '{ timeline_id: "tl_07…", track_id: "A2", amount_db: -14 }'],
      ['audio.set_loudness', '{ timeline_id: "tl_08…", target_lufs: -14 }'],
    ],
    note: 'measured, set, measured again',
  },
  {
    title: 'Make what you don’t have.',
    body: 'Animated titles and graphics from HTML, stills, mattes, a voiceover with timed words, a subject without its background.',
    code: [
      [
        'create.motion',
        '{ html: "<div class=title>Q3</div>…",\n  duration_seconds: 4, width: 1920, height: 1080 }',
      ],
      ['create.voiceover', '{ text: "Here is what changed.", voice: "af_heart" }'],
      ['create.cutout', '{ media_id: "m_9a01…", subject: "any" }'],
    ],
    note: 'sandboxed Chromium, Kokoro, BiRefNet',
  },
  {
    title: 'Code when tools aren’t enough.',
    body: 'For loops and arithmetic over the timeline, the agent writes one script. Inside it, every tool is a function.',
    code: [
      [
        'code.run',
        '{ language: "node", script: `\n  import { cf } from "cuttingfloor";\n  const m = await cf.media.get({ media_id, include: ["beats"] });\n  for (const b of m.beats.beats) …\n` }',
      ],
    ],
    note: 'no network, its own namespaces',
  },
  {
    title: 'Look before it ships.',
    body: 'Stills and filmstrips after every edit, a review render it can watch, and exact checks for gaps, black frames, clipping and sync.',
    code: [
      ['render.frames', '{ timeline_id: "tl_12…", frames: [0, 120, 240] }'],
      ['qa.check', '{ timeline_id: "tl_12…" }'],
      ['export.video', '{ timeline_id: "tl_12…", preset: "web_1080p_h264" }'],
    ],
    note: 'FCPXML, OTIO, EDL out too',
  },
] as const;

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
            className={i === active ? 'on' : ''}
          >
            <h3>{c.title}</h3>
            <p>{c.body}</p>
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
