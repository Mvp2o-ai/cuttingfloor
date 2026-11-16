import { APP_LEAD, APP_NAME, APP_SHOTS, APP_STEPS, TESTFLIGHT_URL } from '../content/app.ts';

// The iPhone app, offered to everyone: a section on the home page and /app. Phones also get a strip
// under the nav on every page (shell.tsx), so it is above the fold there.

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

/** How to join the beta, with the invite as the main button. */
export function AppSteps() {
  return (
    <div className="app-join">
      <ol className="cl-steps">
        {APP_STEPS.map((s) => (
          <li key={s.text}>
            {s.text}{' '}
            {'href' in s ? (
              <a href={s.href} rel="noopener" data-track={`App: ${s.link}`}>
                {s.link}
              </a>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="actions">
        <a className="link-big" href={TESTFLIGHT_URL} rel="noopener" data-track="App: join beta">
          Join the iPhone beta
        </a>
      </div>
      <p className="app-note">
        iPhone only for now. Beta builds come through TestFlight, which keeps {APP_NAME} up to date.
      </p>
    </div>
  );
}

/** The home page's section: what the app does, the screenshots and how to get it. */
export function AppSection({ index }: { index: string }) {
  return (
    <section className="cell app-section" id="app" aria-label="The iPhone app">
      <div className="head">
        <span className="label">{index} / On your phone</span>
        <h2 className="display">The iPhone app, in beta.</h2>
      </div>
      <div className="app-body">
        <div>
          <p className="lede">{APP_LEAD}</p>
          <AppSteps />
        </div>
        <AppShots />
      </div>
    </section>
  );
}
