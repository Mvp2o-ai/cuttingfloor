// Kazi's share links: one per page, so Kazi knows where a visitor came from. Each opens a guest
// chat with a sample clip loaded and cuttingfloor editing it, then offers sign-up. Codes come from
// Kazi and never move; what each opens is Kazi's to change.
export const KAZI_LINKS = {
  home: '2XDlD9QfXx',
  compare: 'Kj1BrrXdfw',
  demos: 'PsFVYwBiOA',
  welcome: 'rAct6z5wAh',
  account: 'u1Mzist24U',
  phone: 'LzUOknGmzC',
  'demo-dance': '3RVMAHa4dE',
  'demo-interview': 'UXB19gQxHp',
  'demo-product': 'eYQt1e3b7T',
  'demo-listing': 't9aZ8kHAym',
  'demo-tips': 'pOzd50YORY',
  'demo-jev': 'CV5zUYdD9T',
  'demo-memory': 'YILSUsgTRG',
} as const satisfies Record<string, string>;

export type KaziPlace = keyof typeof KAZI_LINKS;

export function kaziUrl(place: KaziPlace) {
  return `https://app.apifunnel.ai/s/${KAZI_LINKS[place]}`;
}

/** A demo's place; a demo Kazi has no link for gets the home one. */
export function demoPlace(id: string): KaziPlace {
  const place = `demo-${id}`;
  return place in KAZI_LINKS ? (place as KaziPlace) : 'home';
}

const TEXT = {
  en: {
    link: 'Try it live in Kazi, free',
    how: 'Kazi is our own AI agent, on your phone or computer. It opens with a sample clip and edits it on cuttingfloor while you watch.',
  },
  es: {
    link: 'Pruébalo en vivo en Kazi, gratis',
    how: 'Kazi es nuestro propio agente de IA, en el teléfono o la computadora. Abre con un clip de muestra y lo edita con cuttingfloor mientras miras.',
  },
};

/** A link to try cuttingfloor in Kazi now, from `place`. */
export function TryKazi({
  place,
  lang = 'en',
  label,
}: {
  place: KaziPlace;
  lang?: 'en' | 'es';
  label?: string;
}) {
  const t = TEXT[lang];
  return (
    <div className="try-kazi">
      <a
        className="link-big"
        href={kaziUrl(place)}
        rel="noopener"
        data-track={`Try in Kazi: ${place}`}
      >
        {label ?? t.link}
      </a>
      <p className="try-kazi-how">{t.how}</p>
    </div>
  );
}
