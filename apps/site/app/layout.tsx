import type { Metadata } from 'next';
import { Archivo, JetBrains_Mono, VT323 } from 'next/font/google';
import './globals.css';

const display = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-display' });
const pixel = VT323({ subsets: ['latin'], weight: '400', variable: '--font-pixel' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'cuttingfloor — your agent edits video',
  description:
    'A headless video editor for AI agents. Connect Claude, Cursor or ChatGPT over MCP and cut, caption, mix and export real video.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${pixel.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
