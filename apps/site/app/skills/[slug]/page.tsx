import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { demoForSkill } from '../../../content/demos.ts';
import { SKILLS, SKILLS_UPDATED, type Skill, skill } from '../../../content/skills.ts';
import { SITE_URL } from '../../seo.ts';
import { Breadcrumbs, Footer, JsonLd, Nav } from '../../shell.tsx';
import { Copy } from '../../walkthroughs/copy.tsx';
import { Markdown } from '../markdown.tsx';

// One template for every skill, rendered from its file. Nothing here knows which one it is showing.

export const dynamicParams = false;

export function generateStaticParams() {
  return SKILLS.map((s) => ({ slug: s.slug }));
}

type Props = { params: Promise<{ slug: string }> };

const metaTitle = (s: Skill) => `${s.title}: a skill for your AI agent | cuttingfloor`;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const s = skill((await params).slug);
  if (!s) return {};
  const path = `/skills/${s.slug}`;
  return {
    title: metaTitle(s),
    description: s.description,
    alternates: { canonical: path },
    openGraph: { type: 'article', url: path, title: metaTitle(s), description: s.description },
  };
}

/** Where the copied skill goes, one line per agent. Kazi is ours, so it leads. */
const ADD = [
  {
    agent: 'Kazi',
    how: 'Paste it into a chat and ask Kazi to save it as a playbook. It is already in the format Kazi uses.',
  },
  {
    agent: 'Claude',
    how: 'Paste it into a chat, or into a project’s instructions so every chat in that project follows it.',
  },
  {
    agent: 'ChatGPT',
    how: 'Paste it into a chat, or into a project’s instructions so every chat in that project follows it.',
  },
] as const;

export default async function SkillPage({ params }: Props) {
  const s = skill((await params).slug);
  if (!s) notFound();
  const n = String(SKILLS.indexOf(s) + 1).padStart(2, '0');
  const shown = demoForSkill(s.slug);

  return (
    <>
      <JsonLd data={howTo(s)} />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs
            trail={[
              { name: 'Skills', href: '/skills' },
              { name: s.title, href: `/skills/${s.slug}` },
            ]}
          />
          <span className="label">Skill {n}</span>
          <h1 className="display">{s.title}</h1>
          <p className="lede wt-answer">{s.description}</p>
          <p className="wt-byline">Version {s.version} · Ken Wiltshire</p>
        </section>

        <section className="cell">
          <div className="head">
            <span className="label">01 / Copy it</span>
            <h2 className="lede">How do I give this to my agent?</h2>
          </div>
          <figure className="wt-prompt">
            <ul className="sk-add">
              {ADD.map((a) => (
                <li key={a.agent}>
                  <strong>{a.agent}</strong> {a.how}
                </li>
              ))}
              <li>
                <strong>Connected to cuttingfloor?</strong> Your agent can find this skill itself.
                Just ask for the job in your own words.
              </li>
            </ul>
            <figcaption>
              <span className="label">The whole skill, {s.markdown.split('\n').length} lines</span>
              <Copy text={s.markdown} label="Copy for your agent" />
            </figcaption>
          </figure>
        </section>

        <section className="cell paper">
          <div className="wt-prose">
            <Markdown body={s.body} />
          </div>
        </section>

        <section className="cell wt-end">
          <p className="wt-links">
            {shown && (
              <>
                <a href={`/demos/${shown.slug}`}>Watch an agent do it: {shown.title}</a> ·{' '}
              </>
            )}
            <a href="/skills">More skills</a> · <a href="/walkthroughs">Walkthroughs</a>
          </p>
        </section>
        <Footer />
      </main>
    </>
  );
}

/** The skill's numbered steps, as HowTo for search engines. */
function howTo(s: Skill) {
  const url = `${SITE_URL}/skills/${s.slug}`;
  const steps = s.body
    .split('\n')
    .map((l) => /^\d+\.\s+(.+)$/.exec(l)?.[1])
    .filter((t): t is string => Boolean(t));
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: s.title,
    description: s.description,
    url,
    dateModified: SKILLS_UPDATED,
    step: steps.map((text, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      text: text.replace(/`/g, ''),
    })),
  };
}
