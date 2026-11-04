import { AGENTS } from '../../content/agents.ts';
import { CLIENTS } from '../../content/clients.ts';
import type { Lang } from '../../content/guides.ts';

// "Do it from your agent": Kazi, Claude and ChatGPT side by side, each with its one-line setup and
// its own page. Job pages, walkthroughs and demos all end with it, so every job names every agent.
// The English setup lines are the home page's, from clients.ts; the Spanish ones keep each app's
// own button names in English, as the apps show them.

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
    heading: 'Kazi, Claude or ChatGPT.',
    page: (name: string) => `Edit with ${name}`,
    more: 'Claude Code, Codex, Cursor and any other MCP app:',
    connect: 'every setup',
  },
  es: {
    label: 'Hazlo desde tu agente',
    heading: 'Kazi, Claude o ChatGPT.',
    page: (name: string) => `Editar con ${name} (en inglés)`,
    more: 'Claude Code, Codex, Cursor y cualquier otra app con MCP:',
    connect: 'todas las instrucciones',
  },
};

export function AgentBlock({ lang = 'en', n }: { lang?: Lang; n?: string }) {
  const t = TEXT[lang];
  return (
    <section className="cell" id="agents">
      <div className="head">
        <span className="label">
          {n ? `${n} / ` : ''}
          {t.label}
        </span>
        <h2 className="display">{t.heading}</h2>
      </div>
      <ol className="ledger">
        {AGENTS.map((a, i) => {
          const c = CLIENTS.find((x) => x.slug === a.slug);
          return (
            <li key={a.slug}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <h3>{a.name}</h3>
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
      <p className="wt-links">
        {t.more} <a href="/connect">{t.connect}</a>
      </p>
    </section>
  );
}
