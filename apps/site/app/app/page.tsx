import type { Metadata } from 'next';
import { APP_DESCRIPTION, APP_HEADLINE, APP_LEAD, APP_TITLE } from '../../content/app.ts';
import { AppPoints, AppShots, StoreBadge } from '../mobile-app.tsx';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';

// The iPhone app: what it does and where to get it. The words come from content/app.ts, which the
// Markdown twin (/app.md) reads too.

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
          <span className="label">iPhone app · on the App Store</span>
          <h1 className="display">{APP_HEADLINE}</h1>
          <div className="app-body">
            <div>
              <p className="lede wt-answer">{APP_LEAD}</p>
              <AppPoints />
              <div className="actions app-get">
                <StoreBadge place="app-page" />
                <img
                  className="app-qr on-computer"
                  src="/app/qr.svg"
                  alt="QR code: open Cutting Floor AI on the App Store from your iPhone"
                  width={96}
                  height={96}
                />
              </div>
              <p className="app-note">
                For iPhone. Android is coming; on Android today,{' '}
                <a href="/connect">connect it to Kazi</a>.
              </p>
            </div>
            <AppShots />
          </div>
        </section>
        <Footer />
      </main>
    </>
  );
}
