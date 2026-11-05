'use client';

// Not seo.ts: it pulls the pricing and tool tables into the browser bundle.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cuttingfloor.ai';

// Connecting an agent is done on a computer, and many visitors arrive on a phone (from the ChatGPT
// app). This lets them send the setup page to themselves for later: the phone's share sheet where
// there is one, else an email to themselves. Shown on touch screens only (globals.css).

const TEXT = {
  en: {
    lead: 'On your phone? Setup takes a minute on a computer. Send yourself the link:',
    button: 'Send me the setup',
    subject: 'Set up cuttingfloor',
    body: 'Connect cuttingfloor to Kazi, Claude or ChatGPT:',
  },
  es: {
    lead: '¿Estás en el teléfono? Se configura en un minuto desde la computadora. Mándate el enlace:',
    button: 'Mandarme las instrucciones',
    subject: 'Configurar cuttingfloor',
    body: 'Conecta cuttingfloor a Kazi, Claude o ChatGPT:',
  },
};

export function SendToSelf({ lang = 'en' }: { lang?: 'en' | 'es' }) {
  const t = TEXT[lang];
  const url = `${SITE_URL}/connect`;
  const mail = `mailto:?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(`${t.body} ${url}`)}`;
  return (
    <p className="wt-links send-later">
      {t.lead}{' '}
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
  );
}
