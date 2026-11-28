import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { type BlogBlock, blogPath, POSTS, post } from '../../../content/blog.ts';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav } from '../../shell.tsx';
import { Copy } from '../../walkthroughs/copy.tsx';

export const dynamicParams = false;

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const p = post((await params).slug);
  if (!p) return {};
  const path = blogPath(p);
  return {
    title: p.metaTitle,
    description: p.metaDescription,
    alternates: { canonical: path, types: { 'text/markdown': `${path}.md` } },
    openGraph: {
      type: 'article',
      url: path,
      title: p.metaTitle,
      description: p.metaDescription,
    },
  };
}

function Block({ b }: { b: BlogBlock }) {
  if (b.kind === 'p') return <p>{b.text}</p>;
  if (b.kind === 'list')
    return (
      <ul>
        {b.items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    );
  return (
    <figure className="blog-fig">
      {/* biome-ignore lint/performance/noImgElement: static screenshots; next/image adds nothing */}
      <img src={b.src} alt={b.alt} width={b.width} height={b.height} loading="lazy" />
      <figcaption>{b.caption}</figcaption>
    </figure>
  );
}

export default async function BlogPostPage({ params }: Props) {
  const p = post((await params).slug);
  if (!p) notFound();
  const path = blogPath(p);
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: p.title,
          description: p.metaDescription,
          dateModified: p.updated,
          author: { '@type': 'Person', name: 'Ken Wiltshire' },
        }}
      />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs
            trail={[
              { name: 'Blog', href: '/blog' },
              { name: p.title, href: path },
            ]}
          />
          <span className="label">Blog</span>
          <h1 className="display">{p.title}</h1>
          <p className="lede wt-answer">{p.lede}</p>
          <p className="wt-byline">
            Updated <time dateTime={p.updated}>{formatDate(p.updated)}</time> · Ken Wiltshire
          </p>
          <div className="actions">
            <a className="link-big" href={p.tryIt.href} rel="noopener" data-track="Blog: try it">
              {p.tryIt.label}
            </a>
          </div>
        </section>

        {p.sections.map((s) => (
          <section className="cell blog-section" key={s.heading}>
            <div className="head">
              <h2 className="display">{s.heading}</h2>
            </div>
            <div className="blog-body">
              {s.blocks.map((b) => (
                <Block
                  key={b.kind === 'img' ? b.src : b.kind === 'p' ? b.text : b.items[0]}
                  b={b}
                />
              ))}
            </div>
          </section>
        ))}

        <section className="cell">
          <div className="head">
            <span className="label">Try it</span>
            <h2 className="lede">What to type.</h2>
          </div>
          <figure className="wt-prompt">
            <pre>{p.tryIt.prompt}</pre>
            <figcaption>
              <span className="label">Paste it into Kazi or your own AI app with cuttingfloor</span>
              <Copy text={p.tryIt.prompt} label="Copy prompt" />
            </figcaption>
          </figure>
          <p className="wt-links">
            <a href={p.tryIt.href} rel="noopener" data-track="Blog: try it (end)">
              {p.tryIt.label}
            </a>{' '}
            · <a href="/connect">Add it to ChatGPT, Claude or another app</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}
