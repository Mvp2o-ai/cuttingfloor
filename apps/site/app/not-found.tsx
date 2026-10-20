import { SUPPORT_EMAIL } from '@cuttingfloor/plans';
import { Footer, Nav } from './shell.tsx';

export const metadata = { title: 'Page not found — cuttingfloor' };

export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="frame">
        <section className="cell marks">
          <span className="mark-b" />
          <span className="label">404</span>
          <h1 className="display">Nothing here.</h1>
          <p className="lede">
            This page doesn't exist, or it moved. Start from the home page, or write to{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> if a link brought you here.
          </p>
          <p className="actions">
            <a className="link-big" href="/">
              Go home
            </a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
