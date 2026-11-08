import type { Metadata } from 'next';
import { DEMOS, finished } from '../../content/demos.ts';
import { type Guide, guidePath, type Lang } from '../../content/guides.ts';
import { AgentBlock } from '../agents/block.tsx';
import { AddToYourApp } from '../demos/add.tsx';
import { DemoCards } from '../demos/cards.tsx';
import { BeforeAfter } from '../demos/pair.tsx';
import { LiveCard } from '../live-card.tsx';
import { Breadcrumbs, Footer, formatDate, JsonLd, Nav, SIGN_UP } from '../shell.tsx';
import { Copy } from '../walkthroughs/copy.tsx';

// One template for every guide, English (/guides/<slug>) or Spanish (/es/<slug>). Nothing here
// knows which guide it is showing; the words around the data come in the guide's language. A
// feature guide (guide.feature) opens on its demo's before and after, says what the feature does
// and why an agent can't do it alone, gives a prompt per job and the setup on the page.

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
    does: string;
    doesHead: string;
    why: string;
    proof: string;
    feature: string;
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
    does: 'What it does',
    doesHead: 'Three things, one ask.',
    why: 'Why',
    proof: 'See how it was made, step by step',
    feature: 'Feature',
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
    does: 'Qué hace',
    doesHead: 'Tres cosas, un pedido.',
    why: 'Por qué',
    proof: 'Mira cómo se hizo, paso a paso',
    feature: 'Función',
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
  const f = g.feature;
  const proof = f ? DEMOS.find((d) => d.id === f.proof) : undefined;
  // Sections are numbered in the order they show.
  let count = 0;
  const n = () => String(++count).padStart(2, '0');
  const byline = (
    <p className="wt-byline">
      {t.updated} <time dateTime={g.updated}>{formatDate(g.updated, g.lang)}</time> · Ken Wiltshire
      {g.alternate && (
        <>
          {' · '}
          <a href={g.alternate} hrefLang={g.lang === 'es' ? 'en' : 'es'}>
            {t.other}
          </a>
        </>
      )}
    </p>
  );
  const actions = (
    <div className="actions">
      <a className="link-big" href={SIGN_UP}>
        {t.start}
      </a>
      <a className="link-big quiet" href="/demos">
        {t.watch}
      </a>
    </div>
  );
  const prompts = f?.prompts ?? [{ label: t.typed, text: g.prompt }];
  return (
    <>
      <JsonLd data={howTo(g)} />
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          inLanguage: g.lang,
          mainEntity: g.faqs.map((q) => ({
            '@type': 'Question',
            name: q.q,
            acceptedAnswer: { '@type': 'Answer', text: q.a },
          })),
        }}
      />
      <Nav />
      <main className="frame wt" lang={g.lang}>
        {f && proof ? (
          <section className="cell wt-head dm-hero gd-hero marks">
            <span className="mark-b" />
            <div className="dm-hero-head">
              <Breadcrumbs trail={[{ name: f.name, href: path }]} />
              <span className="label">{t.feature}</span>
              <h1 className="display">{g.title}</h1>
            </div>
            <BeforeAfter before={proof.raw} after={finished(proof)} />
            <div className="dm-hero-lede">
              <p className="lede wt-answer">{g.answer}</p>
              <p className="gd-proof">
                <a href={`/demos/${proof.slug}`} data-track={`Feature proof: ${f.name}`}>
                  {t.proof} <span aria-hidden="true">→</span>
                </a>
              </p>
              <LiveCard clip={false} />
              {byline}
              {actions}
            </div>
          </section>
        ) : (
          <section className="cell wt-head marks">
            <span className="mark-b" />
            <Breadcrumbs trail={[{ name: g.title, href: path }]} />
            <span className="label">{t.label}</span>
            <h1 className="display">{g.title}</h1>
            <p className="lede wt-answer">{g.answer}</p>
            <LiveCard />
            {byline}
            {actions}
          </section>
        )}

        {f && (
          <section className="cell">
            <div className="head">
              <span className="label">
                {n()} / {t.does}
              </span>
              <h2 className="display">{t.doesHead}</h2>
            </div>
            <ol className="ledger">
              {f.does.map((d, i) => (
                <li key={d.title}>
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <h3>{d.title}</h3>
                  <p>{d.body}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        {f && (
          <section className="cell">
            <div className="head">
              <span className="label">
                {n()} / {t.why}
              </span>
              <div>
                <h2 className="display">{f.whyHead}</h2>
                <p className="compare-lede">{f.whyNote}</p>
              </div>
            </div>
            <ol className="ledger">
              {f.why.map((w, i) => (
                <li key={w.title}>
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <h3>{w.title}</h3>
                  <p>{w.body}</p>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="cell">
          <div className="head">
            <span className="label">
              {n()} / {t.steps}
            </span>
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
            <span className="label">
              {n()} / {t.prompt}
            </span>
            <h2 className="lede">{t.promptHead}</h2>
          </div>
          <div className="gd-prompts">
            {prompts.map((p) => (
              <figure key={p.text} className="wt-prompt">
                <pre>{p.text}</pre>
                <figcaption>
                  <span className="label">{p.label}</span>
                  <Copy text={p.text} label={t.copy} />
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {f ? <AddToYourApp /> : <AgentBlock lang={g.lang} n={n()} />}

        {demos.length > 0 && (
          <section className="cell">
            <div className="head">
              <span className="label">
                {n()} / {t.demos}
              </span>
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
            <span className="label">
              {n()} / {t.questions}
            </span>
            <h2 className="display">{t.asked}</h2>
          </div>
          <div className="faq">
            {g.faqs.map((q) => (
              <details key={q.q}>
                <summary>{q.q}</summary>
                <p>{q.a}</p>
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
