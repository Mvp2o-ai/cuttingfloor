import type { Metadata } from 'next';
import { APP_DESCRIPTION, APP_LEAD, APP_TITLE } from '../../content/app.ts';
import { AppShots, AppSteps } from '../mobile-app.tsx';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';

// The iPhone app: what it does, its screenshots and how to join the TestFlight beta. The words come
// from content/app.ts, which the Markdown twin (/app.md) reads too.

export const metadata: Metadata = {
  title: `${APP_TITLE} | cuttingfloor`,
  description: APP_DESCRIPTION,
  alternates: { canonical: '/app', types: { 'text/markdown': '/app.md' } },
  openGraph: { type: 'article', url: '/app', title: APP_TITLE, description: APP_DESCRIPTION },
};

export default function AppPage() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'iPhone app', href: '/app' }]} />
          <span className="label">iPhone app · beta</span>
          <h1 className="display">{APP_TITLE}.</h1>
          <div className="app-body">
            <div>
              <p className="lede wt-answer">{APP_LEAD}</p>
              <AppSteps />
            </div>
            <AppShots />
          </div>
        </section>
        <Footer />
      </main>
    </>
  );
}
