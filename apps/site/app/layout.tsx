import { Analytics } from '@vercel/analytics/next';
import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono, VT323 } from 'next/font/google';
import { Clicks } from './clicks.tsx';
import { DESCRIPTION, SITE_URL, TITLE } from './seo.ts';
import './globals.css';

const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-display' });
const pixel = VT323({ subsets: ['latin'], weight: '400', variable: '--font-pixel' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'cuttingfloor',
    title: 'cuttingfloor — video editing, solved',
    description: DESCRIPTION,
    images: [{ url: '/floor.jpg' }],
  },
  twitter: { card: 'summary_large_image', images: ['/floor.jpg'] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${pixel.variable} ${mono.variable}`}>
      <body>
        {children}
        {/* Page views and clicks: no cookies, no ad trackers (privacy page). */}
        <Analytics />
        <Clicks />
      </body>
    </html>
  );
}
