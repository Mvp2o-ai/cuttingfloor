import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono, VT323 } from 'next/font/google';
import './globals.css';

const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-display' });
const pixel = VT323({ subsets: ['latin'], weight: '400', variable: '--font-pixel' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'cuttingfloor — video editing, solved',
  description:
    'Video editing, solved. A headless video editor for AI agents. Connect Kazi, Claude, Cursor or ChatGPT over MCP and cut, caption, mix and export real video.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${pixel.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
