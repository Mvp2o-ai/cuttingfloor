import { FREE_CREDITS, FREE_FOOTAGE_MINUTES } from '@cuttingfloor/plans';
import { DEMOS, type Demo, finished, length } from '../content/demos.ts';
import { SendToSelf } from './agents/send.tsx';
import { APPS } from './connect-now.tsx';
import { Loop } from './demos/pair.tsx';
import { type AgentSource, NOT_FROM_AGENT, onlyFrom } from './from.tsx';
import { kaziUrl } from './kazi.tsx';

// The card at the top of every page, where the eyes go: the end of a real run looping beside the
// one thing to do. For most visitors that is the live demo in Kazi; the menu link and the strip
// under the nav (shell.tsx) open the same demo. A visitor who came from ChatGPT or Claude sees how
// to add cuttingfloor to that app instead, beside a real edit made in that app, with the live demo
// a line below (from.tsx). ChatGPT and Claude add servers only on a computer, so on a phone that
// visitor gets the phone way in: the edit first, then Kazi on this phone or the setup sent for
// later (globals.css, "Phone or computer").

const ENDING = {
  src: '/demo/live/ending.mp4',
  poster: '/demo/live/ending.jpg',
  label: 'Big Buck Bunny with a happy ending',
  seconds: 13,
  wide: true,
};

const AGENT_NAME: Record<AgentSource, Demo['agent']> = { chatgpt: 'ChatGPT', claude: 'Claude' };

/** The first demo edited in `source`'s app. */
function agentDemo(source: AgentSource): Demo | undefined {
  return DEMOS.find((d) => d.agent === AGENT_NAME[source]);
}

const OTHERS: Record<AgentSource, string> = {
  chatgpt: 'Claude, Codex, Cursor and Kazi',
  claude: 'ChatGPT, Codex, Cursor and Kazi',
};

/**
 * How to add cuttingfloor to `source`'s app, shown only to visitors who came from it. `clip: false`
 * leaves the demo out of the phone version, for a page that already opens on a video.
 */
export function AgentCard({ source, clip = true }: { source: AgentSource; clip?: boolean }) {
  const app = APPS.find((a) => a.slug === source);
  const d = agentDemo(source);
  if (!app || !d) return null;
  const v = finished(d);
  const shape = v.wide ? '' : ' tall';
  return (
    <div className="from-card" {...onlyFrom(source)}>
      <div className="on-computer">
        <a
          className={`live-card${shape}`}
          href={`/connect#${source}`}
          data-track={`From ${app.name}: card`}
        >
          <span className="live-card-shot">
            <Loop v={v} />
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
              {FREE_FOOTAGE_MINUTES} minutes of footage free · about a minute · no card
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
      <div className="on-phone from-phone">
        {clip && (
          <a
            className={`live-card${shape}`}
            href={`/demos/${d.slug}`}
            data-track={`From ${app.name}: phone demo`}
          >
            <span className="live-card-shot">
              <Loop v={v} />
              <span className="live-card-app">{app.mark}</span>
            </span>
            <span className="live-card-copy">
              <b>
                Made in {app.name} <span aria-hidden="true">→</span>
              </b>
              <small>{d.title}.</small>
              <small className="live-card-facts">Before and after · {length(v)} · every step</small>
            </span>
          </a>
        )}
        <SendToSelf app={app.name} />
      </div>
    </div>
  );
}

/** `clip: false` for a page that already opens on a video (see AgentCard). */
export function LiveCard({ clip = true }: { clip?: boolean }) {
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
      <AgentCard source="chatgpt" clip={clip} />
      <AgentCard source="claude" clip={clip} />
    </>
  );
}
