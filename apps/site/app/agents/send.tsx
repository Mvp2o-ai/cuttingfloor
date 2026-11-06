'use client';

import { kaziUrl } from '../kazi.tsx';

// Not seo.ts: it pulls the pricing and tool tables into the browser bundle.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cuttingfloor.ai';
// Not content/clients.ts either, for the same reason.
const MCP_URL = 'https://api.cuttingfloor.ai/mcp';

// Most agents add a server only on a computer, and many visitors arrive on a phone (from the
// ChatGPT app). Two ways forward from there: Kazi, which works on a phone, connects from one
// sentence (opening it copies the sentence) and gets cuttingfloor free (lifetime, by Kazi's OAuth
// client id), or sending the setup page to themselves for later (the phone's share sheet where
// there is one, else an email). Shown on touch screens only (globals.css).

const TEXT = {
  en: {
    lead: (app?: string) =>
      `On your phone? ${app ?? 'Most apps'} ${app ? 'adds' : 'add'} servers on a computer.`,
    kazi: 'Try it now in Kazi, free',
    kaziHow:
      'Kazi works on your phone, and cuttingfloor is free there for good. Opening it copies this, so you just paste:',
    say: `Connect the cuttingfloor MCP server at ${MCP_URL}`,
    later: 'Or set it up later:',
    button: 'Send me the setup',
    subject: 'Set up cuttingfloor',
    body: 'Connect cuttingfloor to Kazi, Claude or ChatGPT:',
  },
  es: {
    lead: (app?: string) =>
      `¿Estás en el teléfono? ${app ?? 'Casi todas las apps'} ${app ? 'agrega' : 'agregan'} servidores desde la computadora.`,
    kazi: 'Pruébalo ya en Kazi, gratis',
    kaziHow:
      'Kazi funciona en el teléfono y ahí cuttingfloor es gratis para siempre. Al abrirlo se copia esto, así que solo pegas:',
    say: `Conecta el servidor MCP de cuttingfloor en ${MCP_URL}`,
    later: 'O configúralo después:',
    button: 'Mandarme las instrucciones',
    subject: 'Configurar cuttingfloor',
    body: 'Conecta cuttingfloor a Kazi, Claude o ChatGPT:',
  },
};

export function SendToSelf({ lang = 'en', app }: { lang?: 'en' | 'es'; app?: string }) {
  const t = TEXT[lang];
  const url = `${SITE_URL}/connect`;
  const mail = `mailto:?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(`${t.body} ${url}`)}`;
  return (
    <div className="send-later">
      <p className="wt-links">
        {t.lead(app)}{' '}
        <a
          className="copy"
          href={kaziUrl(app ? `phone-${app.toLowerCase().replace(/\s+/g, '-')}` : 'phone', t.say)}
          rel="noopener"
          data-track={app ? `Try in Kazi: ${app}` : 'Try in Kazi'}
          onClick={() => {
            navigator.clipboard?.writeText(t.say).catch(() => {});
          }}
        >
          {t.kazi}
        </a>
      </p>
      <p className="wt-links">
        {t.kaziHow} <code>{t.say}</code>
      </p>
      <p className="wt-links">
        {t.later}{' '}
        <a
          className="copy"
          href={mail}
          data-track="Send me the setup"
          onClick={(event) => {
            if (!navigator.share) return;
            event.preventDefault();
            navigator.share({ title: t.subject, text: t.body, url }).catch(() => {});
          }}
        >
          {t.button}
        </a>
      </p>
    </div>
  );
}
