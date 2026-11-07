import { Loop } from './demos/pair.tsx';
import { kaziUrl } from './kazi.tsx';

// The live demo at the top of every page, where the eyes go: the end of a real run looping beside
// the one thing to do. The menu link and the strip under the nav (shell.tsx) open the same demo.

const ENDING = {
  src: '/demo/live/ending.mp4',
  poster: '/demo/live/ending.jpg',
  label: 'Big Buck Bunny with a happy ending',
  seconds: 13,
  wide: true,
};

export function LiveCard() {
  return (
    <a className="live-card" href={kaziUrl('demos')} rel="noopener" data-track="Live demo: card">
      <span className="live-card-shot">
        <Loop v={ENDING} />
        <span className="live-card-dot">Live</span>
      </span>
      <span className="live-card-copy">
        <b>
          Watch it live now <span aria-hidden="true">→</span>
        </b>
        <small>Kazi gives Big Buck Bunny a happy ending, while you watch.</small>
        <small>Kazi is one way in: ChatGPT, Claude or any MCP app connects the same way.</small>
        <small className="live-card-facts">Free · a few minutes · no sign-up</small>
      </span>
    </a>
  );
}
