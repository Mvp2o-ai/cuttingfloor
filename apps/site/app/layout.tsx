import { Analytics } from '@vercel/analytics/next';
import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono, Ubuntu, VT323 } from 'next/font/google';
import { APP_ID } from '../content/app.ts';
import { Clicks } from './clicks.tsx';
import { FromScript } from './from.tsx';
import { DESCRIPTION, SITE_URL, TITLE } from './seo.ts';
import { SourceScript } from './source.tsx';
import './globals.css';

const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-display' });
const pixel = VT323({ subsets: ['latin'], weight: '400', variable: '--font-pixel' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });
// Kazi's wordmark is set in Ubuntu, as on Kazi's own site.
const kazi = Ubuntu({ subsets: ['latin'], weight: '700', variable: '--font-kazi' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // Safari's Smart App Banner on iPhone (the strip under the nav covers in-app browsers, which skip it).
  itunes: { appId: APP_ID },
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'cuttingfloor',
    title: 'cuttingfloor: the video editing MCP server. Watch a free live demo',
    description: DESCRIPTION,
    images: [{ url: '/floor.jpg' }],
  },
  twitter: { card: 'summary_large_image', images: ['/floor.jpg'] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${pixel.variable} ${mono.variable} ${kazi.variable}`}
      // FromScript sets data-from before React hydrates.
      suppressHydrationWarning
    >
      <head>
        <FromScript />
        <SourceScript />
      </head>
      <body>
        {children}
        {/* Page views and clicks: no ad trackers (privacy page). */}
        <Analytics />
        <Clicks />
      </body>
    </html>
  );
}
