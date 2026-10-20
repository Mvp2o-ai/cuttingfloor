import type { ReactNode } from 'react';
import { Breadcrumbs, Footer, Nav } from './shell.tsx';

// The policy pages share one shape: a head with the effective date, then short sections.

export const EFFECTIVE = 'October 20, 2026';

export function LegalPage({
  label,
  title,
  lede,
  href,
  children,
}: {
  label: string;
  title: string;
  lede: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: label, href }]} />
          <span className="label">{label}</span>
          <h1 className="display">{title}</h1>
          <p className="lede wt-answer">{lede}</p>
          <p className="wt-links">In effect from {EFFECTIVE}.</p>
        </section>
        <section className="cell">
          <div className="wt-prose">{children}</div>
        </section>
        <Footer />
      </main>
    </>
  );
}

/** One titled section; each child paragraph gets a little room. */
export function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p style={{ marginTop: '0.75em' }}>{children}</p>;
}

export function Items({ items }: { items: ReactNode[] }) {
  return (
    <ul
      style={{
        margin: '0.75em 0 0',
        paddingLeft: '1.2em',
        lineHeight: 1.6,
        fontSize: 'clamp(17px, 1.4vw, 19px)',
      }}
    >
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
        <li key={i} style={{ marginTop: '0.3em' }}>
          {item}
        </li>
      ))}
    </ul>
  );
}
