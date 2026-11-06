'use client';

// Not content/clients.ts: it pulls the client tables into the browser bundle.
const MCP_URL = 'https://api.cuttingfloor.ai/mcp';
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cuttingfloor.ai';

const CONNECT = {
  en: `Connect the cuttingfloor MCP server at ${MCP_URL}`,
  es: `Conecta el servidor MCP de cuttingfloor en ${MCP_URL}`,
};

/** The first message for Kazi: connect cuttingfloor, then (on a demo) the same edit on its clip. */
export function kaziMessage(lang: 'en' | 'es' = 'en', clip?: string, edit?: string) {
  const connect = CONNECT[lang];
  if (!clip || !edit) return connect;
  return `${connect}, then import ${SITE_URL}${clip}. ${edit}`;
}

/**
 * Kazi with cuttingfloor's mark on the link: `ref=cuttingfloor` tells Kazi the visitor came from
 * here (cuttingfloor is free there, by Kazi's OAuth client id), `place` says which page, and
 * `prompt` carries the first message. Until Kazi reads `prompt`, opening the link also copies it.
 */
export function kaziUrl(place: string, message: string) {
  const q = new URLSearchParams({
    ref: 'cuttingfloor',
    utm_source: 'cuttingfloor.ai',
    utm_medium: 'referral',
    utm_campaign: place,
    prompt: message,
  });
  return `https://app.apifunnel.ai/?${q}`;
}

const TEXT = {
  en: {
    link: 'Try it live in Kazi, free',
    how: 'Kazi is our own AI agent, on your phone or computer, and cuttingfloor is free in it. Opening it copies this, so you just paste:',
  },
  es: {
    link: 'Pruébalo en vivo en Kazi, gratis',
    how: 'Kazi es nuestro propio agente de IA, en el teléfono o la computadora, y ahí cuttingfloor es gratis. Al abrirlo se copia esto, así que solo pegas:',
  },
};

/** A link to try cuttingfloor in Kazi now, from `place` (a short page name for the link). */
export function TryKazi({
  place,
  lang = 'en',
  clip,
  edit,
  label,
}: {
  place: string;
  lang?: 'en' | 'es';
  /** On a demo: the clip to import and the edit to ask for, so Kazi does the same job. */
  clip?: string;
  edit?: string;
  label?: string;
}) {
  const t = TEXT[lang];
  const message = kaziMessage(lang, clip, edit);
  return (
    <div className="try-kazi">
      <a
        className="link-big"
        href={kaziUrl(place, message)}
        rel="noopener"
        data-track={`Try in Kazi: ${place}`}
        onClick={() => {
          navigator.clipboard?.writeText(message).catch(() => {});
        }}
      >
        {label ?? t.link}
      </a>
      <p className="try-kazi-how">
        {t.how} <code>{message}</code>
      </p>
    </div>
  );
}
