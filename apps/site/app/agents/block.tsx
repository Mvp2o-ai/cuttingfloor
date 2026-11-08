import { AGENTS } from '../../content/agents.ts';
import { CLIENTS } from '../../content/clients.ts';
import type { Lang } from '../../content/guides.ts';
import { APPS } from '../connect-now.tsx';
import { NOT_FROM_AGENT } from '../from.tsx';
import { McpAddress } from '../mcp-address.tsx';
import { SendToSelf } from './send.tsx';

// "Do it from your agent": ChatGPT, Claude and Kazi side by side, each with its one-line setup and
// its own page, under the address they all paste. ChatGPT and Claude take a few clicks on a
// computer; Kazi is last, where asking is the whole setup. Job pages, walkthroughs and the demos
// hub end with it, so every job names every agent. The English setup lines are the home page's,
// from clients.ts; the Spanish ones keep each app's own button names in English, as the apps show
// them. The last line says how the video gets in: ChatGPT takes a file attached in the chat; the
// others give an upload link (media.upload).

const ORDER = ['chatgpt', 'claude', 'kazi'] as const;

const ES_HOW: Record<string, string> = {
  kazi: 'En Kazi (app.apifunnel.ai), abre Servers y agrega tu propio servidor. Pega la dirección, elige Connect e inicia sesión. O pídeselo a Kazi.',
  claude:
    'En Customize → Connectors, haz clic en + y luego en Add custom connector. Pega la dirección e inicia sesión.',
  chatgpt:
    'En chatgpt.com/plugins, haz clic en + y luego en Add custom MCP server. Pega la dirección y elige OAuth.',
};

const TEXT = {
  en: {
    label: 'Do it from your agent',
    heading: 'ChatGPT, Claude or Kazi.',
    page: (name: string) => `Edit with ${name}`,
    video:
      'Then send your video: attach it in the chat in ChatGPT, or your AI gives you a link to send it from your phone or computer.',
    more: 'Claude Code, Codex, Cursor and any other MCP app:',
    connect: 'every setup',
  },
  es: {
    label: 'Hazlo desde tu agente',
    heading: 'ChatGPT, Claude o Kazi.',
    page: (name: string) => `Editar con ${name} (en inglés)`,
    video:
      'Luego manda tu video: adjúntalo en el chat en ChatGPT, o tu IA te da un enlace para mandarlo desde el teléfono o la computadora.',
    more: 'Claude Code, Codex, Cursor y cualquier otra app con MCP:',
    connect: 'todas las instrucciones',
  },
};

export function AgentBlock({ lang = 'en', n }: { lang?: Lang; n?: string }) {
  const t = TEXT[lang];
  const agents = ORDER.flatMap((slug) => AGENTS.filter((a) => a.slug === slug));
  return (
    <section className="cell" id="agents">
      <div className="head">
        <span className="label">
          {n ? `${n} / ` : ''}
          {t.label}
        </span>
        <h2 className="display">{t.heading}</h2>
      </div>
      <McpAddress track="Copy: MCP address (agents)" />
      <ol className="ledger">
        {agents.map((a, i) => {
          const c = CLIENTS.find((x) => x.slug === a.slug);
          return (
            <li key={a.slug}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="agent-app">
                {APPS.find((x) => x.slug === a.slug)?.mark}
                <span className={a.slug === 'kazi' ? 'kazi-word' : undefined}>{a.name}</span>
              </h3>
              <p>
                {lang === 'es' ? ES_HOW[a.slug] : c?.home?.how}{' '}
                <a href={`/agents/${a.slug}`} data-track={`Agent block: ${a.name}`}>
                  {t.page(a.name)}
                </a>
              </p>
            </li>
          );
        })}
      </ol>
      <p className="wt-links">{t.video}</p>
      <p className="wt-links">
        {t.more} <a href="/connect">{t.connect}</a>
      </p>
      {/* A visitor from ChatGPT or Claude already has this at the top (live-card.tsx). */}
      <div {...NOT_FROM_AGENT}>
        <SendToSelf lang={lang} />
      </div>
    </section>
  );
}
