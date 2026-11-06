import type { Metadata } from 'next';
import { DEMOS } from '../../content/demos.ts';
import { type Guide, guidePath, type Lang } from '../../content/guides.ts';
import { AgentBlock } from '../agents/block.tsx';
import { DemoCards } from '../demos/cards.tsx';
import { LiveCard } from '../live-card.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
import { Copy } from '../walkthroughs/copy.tsx';

// One template for every guide, English (/guides/<slug>) or Spanish (/es/<slug>). Nothing here
// knows which guide it is showing; the words around the data come in the guide's language.

const TEXT: Record<
  Lang,
  {
    label: string;
    updated: string;
    start: string;
    watch: string;
    steps: string;
    stepsHead: string;
    prompt: string;
    promptHead: string;
    typed: string;
    copy: string;
    demos: string;
    demosHead: string;
    demosNote?: string;
    questions: string;
    asked: string;
    other: string;
  }
> = {
  en: {
    label: 'Guide',
    updated: 'Updated',
    start: 'Start free',
    watch: 'Watch it edit',
    steps: 'How',
    stepsHead: 'Four steps, all in words.',
    prompt: 'Say',
    promptHead: 'What to type.',
    typed: 'Paste it into your agent, or say it your way',
    copy: 'Copy prompt',
    demos: 'Watch',
    demosHead: 'Real edits, real agents.',
    questions: 'Questions',
    asked: 'Asked.',
    other: 'En español',
  },
  es: {
    label: 'Guía',
    updated: 'Actualizado el',
    start: 'Empieza gratis',
    watch: 'Míralo editar',
    steps: 'Cómo',
    stepsHead: 'Cuatro pasos, todo con palabras.',
    prompt: 'Qué decir',
    promptHead: 'Qué escribir.',
    typed: 'Pégalo en tu agente, o dilo a tu manera',
    copy: 'Copiar',
    demos: 'Ejemplos',
    demosHead: 'Ediciones reales, agentes reales.',
    demosNote: 'Los ejemplos están en inglés; con un video en español funciona igual.',
    questions: 'Preguntas',
    asked: 'Preguntas frecuentes.',
    other: 'In English',
  },
};

export function guideMetadata(g: Guide): Metadata {
  const path = guidePath(g);
  const languages: Record<string, string> = { [g.lang]: path };
  if (g.alternate) languages[g.lang === 'es' ? 'en' : 'es'] = g.alternate;
  return {
    title: g.metaTitle,
    description: g.metaDescription,
    alternates: { canonical: path, languages, types: { 'text/markdown': `${path}.md` } },
    openGraph: {
      type: 'article',
      url: path,
      title: g.metaTitle,
      description: g.metaDescription,
      locale: g.lang === 'es' ? 'es_MX' : 'en_US',
    },
  };
}

export function GuideView({ g }: { g: Guide }) {
  const t = TEXT[g.lang];
  const path = guidePath(g);
  const demos = g.demos.flatMap((slug) => DEMOS.filter((d) => d.slug === slug));
  return (
    <>
      <JsonLd data={howTo(g)} />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          inLanguage: g.lang,
          mainEntity: g.faqs.map((f) => ({
            '@type': 'Question',
            name: f.q,
            acceptedAnswer: { '@type': 'Answer', text: f.a },
          })),
        }}
      />
      <Nav />
      <main className="frame wt" lang={g.lang}>
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: g.title, href: path }]} />
          <span className="label">{t.label}</span>
          <h1 className="display">{g.title}</h1>
          <p className="lede wt-answer">{g.answer}</p>
          <LiveCard />
          <p className="wt-byline">
            {t.updated} <time dateTime={g.updated}>{formatDate(g.updated, g.lang)}</time> · Ken
            Wiltshire
            {g.alternate && (
              <>
                {' · '}
                <a href={g.alternate} hrefLang={g.lang === 'es' ? 'en' : 'es'}>
                  {t.other}
                </a>
              </>
            )}
          </p>
          <div className="actions">
            <a className="link-big" href={SIGN_UP}>
              {t.start}
            </a>
            <a className="link-big quiet" href="/demos">
              {t.watch}
            </a>
          </div>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">01 / {t.steps}</span>
            <h2 className="display">{t.stepsHead}</h2>
          </div>
          <ol className="ledger">
            {g.steps.map((s, i) => (
              <li key={s.title}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">02 / {t.prompt}</span>
            <h2 className="lede">{t.promptHead}</h2>
          </div>
          <figure className="wt-prompt">
            <pre>{g.prompt}</pre>
            <figcaption>
              <span className="label">{t.typed}</span>
              <Copy text={g.prompt} label={t.copy} />
            </figcaption>
          </figure>
        </section>

        <AgentBlock lang={g.lang} n="03" />

        {demos.length > 0 && (
          <section className="cell">
            <div className="head">
              <span className="label">04 / {t.demos}</span>
              <div>
                <h2 className="display">{t.demosHead}</h2>
                {t.demosNote && <p className="compare-lede">{t.demosNote}</p>}
              </div>
            </div>
            <DemoCards demos={demos} />
          </section>
        )}

        <section className="cell">
          <div className="head">
            <span className="label">05 / {t.questions}</span>
            <h2 className="display">{t.asked}</h2>
          </div>
          <div className="faq">
            {g.faqs.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>
        <Footer />
      </main>
    </>
  );
}

function howTo(g: Guide) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: g.title,
    description: g.metaDescription,
    inLanguage: g.lang,
    step: g.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.title,
      text: s.body,
    })),
  };
}
