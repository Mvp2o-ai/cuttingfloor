import { FREE_CREDITS } from '@cuttingfloor/plans';
import { APPS } from './connect-now.tsx';
import { Loop } from './demos/pair.tsx';
import { type AgentSource, NOT_FROM_AGENT, onlyFrom } from './from.tsx';
import { kaziUrl } from './kazi.tsx';

// The card at the top of every page, where the eyes go: the end of a real run looping beside the
// one thing to do. For most visitors that is the live demo in Kazi; the menu link and the strip
// under the nav (shell.tsx) open the same demo. A visitor who came from ChatGPT or Claude sees how
// to add cuttingfloor to that app instead, with the live demo a line below (from.tsx).

const ENDING = {
  src: '/demo/live/ending.mp4',
  poster: '/demo/live/ending.jpg',
  label: 'Big Buck Bunny with a happy ending',
  seconds: 13,
  wide: true,
};

const OTHERS: Record<AgentSource, string> = {
  chatgpt: 'Claude, Codex, Cursor and Kazi',
  claude: 'ChatGPT, Codex, Cursor and Kazi',
};

/** How to add cuttingfloor to `source`'s app, shown only to visitors who came from it. */
export function AgentCard({ source }: { source: AgentSource }) {
  const app = APPS.find((a) => a.slug === source);
  if (!app) return null;
  return (
    <div className="from-card" {...onlyFrom(source)}>
      <a className="live-card" href={`/connect#${source}`} data-track={`From ${app.name}: card`}>
        <span className="live-card-shot">
          <Loop v={ENDING} />
          <span className="live-card-app">{app.mark}</span>
        </span>
        <span className="live-card-copy">
          <b>
            Edit your video in {app.name} <span aria-hidden="true">→</span>
          </b>
          <small>
            Add cuttingfloor to {app.name}: paste one address as a connector, sign in, then ask it
            to edit.
          </small>
          <small>It works the same in {OTHERS[source]}.</small>
          <small className="live-card-facts">
            {FREE_CREDITS} free credits · about a minute · no card
          </small>
        </span>
      </a>
      <p className="from-alt">
        Rather watch first?{' '}
        <a href={kaziUrl('demos')} rel="noopener" data-track={`From ${app.name}: live demo`}>
          Watch Kazi edit one live, free
        </a>
      </p>
    </div>
  );
}

export function LiveCard() {
  return (
    <>
      <a
        className="live-card"
        href={kaziUrl('demos')}
        rel="noopener"
        data-track="Live demo: card"
        {...NOT_FROM_AGENT}
      >
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
      <AgentCard source="chatgpt" />
      <AgentCard source="claude" />
    </>
  );
}
