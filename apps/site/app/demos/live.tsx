import { kaziUrl } from '../kazi.tsx';
import { SITE_URL } from '../seo.ts';
import { Loop } from './pair.tsx';
import { isoDuration } from './video.ts';

// The top of /demos: the live demo in Kazi. One click opens a guest chat where Kazi gives the
// ending of Big Buck Bunny a happy ending on cuttingfloor and plays it back, then offers sign-up.
// Beside it, the end of a real run looping, with the steps Kazi takes ticking off.

const ENDING = {
  src: '/demo/live/ending.mp4',
  poster: '/demo/live/ending.jpg',
  label: 'Big Buck Bunny with a happy ending',
  seconds: 13,
  wide: true,
};

// The looping ending as Google reads it, so the live demo can show up in video results.
export function liveVideoObject() {
  const abs = (path: string) => new URL(path, SITE_URL).toString();
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: 'Live demo: an AI agent gives Big Buck Bunny a happy ending',
    description:
      'Kazi, an AI agent, edits the end of Big Buck Bunny over the cuttingfloor video editing MCP server: it finds the final scene, builds a happy-ending animation over it and exports the video. Try it live, free, with no sign-up.',
    thumbnailUrl: [abs(ENDING.poster)],
    uploadDate: '2026-11-05T12:00:00+00:00',
    duration: isoDuration(ENDING.seconds),
    contentUrl: abs(ENDING.src),
    url: abs('/demos'),
  };
}

const STEPS = [
  'Opens the last minute of Big Buck Bunny',
  'Finds the final scene',
  'Builds a happy-ending animation over it',
  'Exports the video',
  'Plays it for you in the chat',
];

export function LiveDemo() {
  return (
    <div className="live">
      <div className="live-copy">
        <span className="label">Live demo · Kazi</span>
        <h1 className="display">Watch an agent edit a video, live.</h1>
        <p className="lede">
          One click opens Kazi in your browser. It takes the last minute of Big Buck Bunny, gives it
          a happy ending with an animation over the final scene, and plays you the finished video.
          Each step shows up as it runs.
        </p>
        <ul className="live-facts">
          <li>Free</li>
          <li>A few minutes</li>
          <li>No sign-up, nothing to install</li>
        </ul>
        <a className="live-go" href={kaziUrl('demos')} rel="noopener" data-track="Live demo">
          Start the live demo <span aria-hidden="true">→</span>
        </a>
        <p className="live-after">
          Want to keep going? Kazi then asks for your email: sign up free to keep the chat and edit
          your own footage.
        </p>
        <p className="live-after">
          Kazi is just one way in. cuttingfloor is an MCP server, so ChatGPT, Claude, Codex or any
          MCP app connects to it directly, with the same tools: <a href="/connect">connect yours</a>{' '}
          · <a href="/mcp">what is MCP?</a>
        </p>
      </div>
      <figure className="live-screen">
        <div className="live-bar" aria-hidden="true">
          <span />
          <span />
          <span />
          <b className="kazi-word">Kazi</b>
        </div>
        <Loop v={ENDING} />
        <ol className="live-steps">
          {STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <figcaption>
          The end of a real run. Kazi designs the ending each time, so yours will differ a little.
          Big Buck Bunny © Blender Foundation,{' '}
          <a href="https://creativecommons.org/licenses/by/3.0/" rel="noopener">
            CC BY 3.0
          </a>
          .
        </figcaption>
      </figure>
    </div>
  );
}
