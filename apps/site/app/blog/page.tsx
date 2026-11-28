import type { Metadata } from 'next';
import { blogPath, POSTS } from '../../content/blog.ts';
import { Breadcrumbs, Footer, Nav } from '../shell.tsx';

export const metadata: Metadata = {
  title: 'Blog | cuttingfloor',
  description: 'How cuttingfloor’s features work, from the side of the person using them.',
  alternates: { canonical: '/blog', types: { 'text/markdown': '/blog.md' } },
};

export default function Blog() {
  return (
    <>
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Blog', href: '/blog' }]} />
          <span className="label">Blog</span>
          <h1 className="display">How it works.</h1>
          <p className="lede wt-answer">
            How cuttingfloor’s features work, from the side of the person using them.
          </p>
        </section>
        <section className="cell">
          <ol className="wt-hub">
            {POSTS.map((p, i) => (
              <li key={p.slug}>
                <a href={blogPath(p)} data-track={`Blog: ${p.title}`}>
                  <span className="label">{String(i + 1).padStart(2, '0')}</span>
                  <h2>{p.title}</h2>
                  <p>{p.metaDescription}</p>
                </a>
              </li>
            ))}
          </ol>
        </section>
        <Footer />
      </main>
    </>
  );
}
