import { MCP_URL } from '../../content/clients.ts';
import { SendToSelf } from '../agents/send.tsx';
import { APPS } from '../connect-now.tsx';
import { NOT_FROM_AGENT } from '../from.tsx';
import { McpAddress } from '../mcp-address.tsx';

// Right under a demo's hero: how to do the same edit in the visitor's own app, with the steps on
// the page instead of a link away. ChatGPT and Claude take a few clicks on a computer; Kazi is
// last, where asking is the whole setup. A visitor who came from ChatGPT or Claude sees that app
// first (globals.css, "From"). Each app's last step is how the video gets in: ChatGPT takes a file
// attached in the chat; the others give an upload link (media.upload). Button names are the apps' own, checked against their docs on
// 2026-11-08; the full steps and plan notes stay on /connect.

type Way = {
  slug: (typeof APPS)[number]['slug'];
  steps: string[];
  open: { href: string; label: string };
};

const WAYS: Way[] = [
  {
    slug: 'chatgpt',
    steps: [
      'Open chatgpt.com/plugins, click **+**, then **Add custom MCP server**.',
      'Name it cuttingfloor, paste the address above and set **Authentication** to **OAuth**.',
      'Click **I understand and want to continue**, then **Create as a plugin**. Sign in when asked.',
      'In a chat, type **@cuttingfloor** and ask for the edit.',
      'Attach your video in the chat. ChatGPT hands it to cuttingfloor.',
    ],
    open: { href: 'https://chatgpt.com/plugins', label: 'Open ChatGPT plugins' },
  },
  {
    slug: 'claude',
    steps: [
      'Open **Customize → Connectors**, click **+ Add**, then **Add custom connector**.',
      'Name it cuttingfloor, paste the address above and click **Continue**.',
      'Click **Add**, then sign in on the page that opens.',
      'In a chat, open **+ → Connectors**, turn cuttingfloor on and ask for the edit.',
      'Claude gives you a link to send your video from your phone or computer.',
    ],
    open: { href: 'https://claude.ai', label: 'Open Claude' },
  },
  {
    slug: 'kazi',
    steps: [
      `Ask Kazi: “Connect the cuttingfloor MCP server at ${MCP_URL}”. It works on your phone too.`,
      'Ask for the edit. Kazi gives you a link to send your video from your phone or computer.',
    ],
    open: { href: 'https://app.apifunnel.ai', label: 'Open Kazi' },
  },
];

/** A step with the app's own button names, written **like this**, in bold. */
function labels(step: string) {
  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed string split once
  return step.split('**').map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part));
}

export function AddToYourApp() {
  return (
    <section className="cell dm-add" id="add">
      <div className="head">
        <span className="label">Your turn</span>
        <div>
          <h2 className="display">Do this with your own video</h2>
          <p className="lede">
            Add cuttingfloor to the app you already use, then ask for the edit in your own words.
          </p>
        </div>
      </div>
      <McpAddress track="Copy: MCP address (demo)" />
      <ol className="dm-add-apps">
        {WAYS.map((w) => {
          const app = APPS.find((a) => a.slug === w.slug);
          if (!app) return null;
          return (
            <li key={w.slug} data-app={w.slug}>
              <h3>
                {app.mark}
                <span className={w.slug === 'kazi' ? 'kazi-word' : undefined}>{app.name}</span>
              </h3>
              {w.steps.length === 1 ? (
                <p className="dm-add-one">{labels(w.steps[0])}</p>
              ) : (
                <ol className="dm-steps">
                  {w.steps.map((s) => (
                    <li key={s}>{labels(s)}</li>
                  ))}
                </ol>
              )}
              <a
                className="link-big quiet"
                href={w.open.href}
                rel="noopener"
                target="_blank"
                data-track={`Demo add: ${app.name}`}
              >
                {w.open.label} ↗
              </a>
            </li>
          );
        })}
      </ol>
      <p className="wt-links">
        ChatGPT and Claude add it on a computer. <a href="/connect">Every app, and plan notes</a>
      </p>
      {/* A visitor from ChatGPT or Claude already has this under the hero (live-card.tsx). */}
      <div {...NOT_FROM_AGENT}>
        <SendToSelf />
      </div>
    </section>
  );
}
