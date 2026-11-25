import {
  APP_ANDROID,
  APP_HEADLINE,
  APP_LEAD,
  APP_NAME,
  APP_POINTS,
  APP_SHOTS,
  APP_SUBTITLE,
  appStoreUrl,
} from '../content/app.ts';

// The iPhone app, Cutting Floor AI: editing video by voice. The page is static, so every variant is
// in the HTML and CSS shows one by device (from.tsx sets html[data-device]; globals.css, "Device"):
//   .only-ios     the app first, for iPhone and iPad visitors: the hero on the home page, the card
//                 that replaces the Kazi phone way in, the strip under the nav (shell.tsx)
//   .not-ios      what iOS visitors do not need, because the app does it
// Everyone else still sees the section lower on the home page and /app: the badge, a QR code on a
// computer, and the Android note. Nothing is removed from the page for search or agents.

const BADGE_ALT = { en: 'Download on the App Store', es: 'Descargar en el App Store' } as const;
// Apple's badge ratio: 119.66 x 40.
const BADGE = { w: 120, h: 40 };

/** Apple's own "Download on the App Store" badge, linking to the app with `place` as its campaign. */
export function StoreBadge({ place, lang = 'en' }: { place: string; lang?: 'en' | 'es' }) {
  return (
    <a
      className="store-badge"
      href={appStoreUrl(place)}
      rel="noopener"
      data-track={`App Store: ${place}`}
    >
      <img
        src={`/app/app-store-${lang}.svg`}
        alt={BADGE_ALT[lang]}
        width={BADGE.w}
        height={BADGE.h}
      />
    </a>
  );
}

/** The app's screenshots, side by side. */
export function AppShots() {
  return (
    <div className="app-shots">
      {APP_SHOTS.map((s) => (
        <img key={s.src} src={s.src} alt={s.alt} width={552} height={1200} loading="lazy" />
      ))}
    </div>
  );
}

/** What it is like to use, as a list. */
export function AppPoints() {
  return (
    <ul className="app-points">
      {APP_POINTS.map((p) => (
        <li key={p.b}>
          <b>{p.b}</b> {p.text}
        </li>
      ))}
    </ul>
  );
}

/** The first screen on an iPhone or iPad: the app, voice first, with the web product one tap below. */
export function AppHero() {
  return (
    <section className="cell app-hero only-ios" aria-label="The iPhone app">
      <span className="label">{APP_SUBTITLE} · iPhone app</span>
      <h2 className="display">{APP_HEADLINE}</h2>
      <p className="lede">{APP_LEAD}</p>
      <div className="actions">
        <StoreBadge place="home-hero" />
      </div>
      <AppShots />
      <p className="app-note">
        Rather use ChatGPT, Claude or Kazi? <a href="#session">See how cuttingfloor works there</a>.
      </p>
    </section>
  );
}

/**
 * The app in one box, for a page whose phone way in was Kazi (connect, welcome, an agent's page).
 * Shown to iOS visitors only; the Kazi way in is hidden from them (.not-ios) and stays for the rest.
 */
export function AppCard({ place, lang = 'en' }: { place: string; lang?: 'en' | 'es' }) {
  return (
    <div className="app-card only-ios">
      <b>{APP_SUBTITLE}.</b>
      <p>
        {lang === 'es'
          ? 'Di la edición y míralo suceder en tu teléfono: corta, subtitula y termina tus videos con la voz.'
          : 'Say the edit and watch it happen on your phone: cut, caption, retime and finish your videos by voice.'}
      </p>
      <StoreBadge place={place} lang={lang} />
    </div>
  );
}

/** The home page's section, for everyone: what the app does, the badge, and where it is not yet. */
export function AppSection({ index }: { index: string }) {
  return (
    <section className="cell app-section" id="app" aria-label="The iPhone app">
      <div className="head">
        <span className="label">{index} / On your phone</span>
        <h2 className="display">{APP_HEADLINE}</h2>
      </div>
      <div className="app-body">
        <div>
          <p className="lede">{APP_LEAD}</p>
          <AppPoints />
          <div className="actions app-get">
            <StoreBadge place="home" />
            <img
              className="app-qr on-computer"
              src="/app/qr.svg"
              alt={`QR code: open ${APP_NAME} on the App Store from your iPhone`}
              width={96}
              height={96}
              loading="lazy"
            />
          </div>
          <p className="app-note">
            For iPhone. <span className="not-ios">{APP_ANDROID}</span>
          </p>
        </div>
        <AppShots />
      </div>
    </section>
  );
}
