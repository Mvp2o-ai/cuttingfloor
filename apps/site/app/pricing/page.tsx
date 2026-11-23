import { FREE_CREDITS, SUPPORT_EMAIL } from '@cuttingfloor/plans';
import type { Metadata } from 'next';
import {
  IMAGE,
  KEYS,
  LICENCE,
  LOCAL_ADDRESS,
  REPO_URL,
  SELF_HOST_STEPS,
} from '../../content/facts.ts';
import { LiveCard } from '../live-card.tsx';
import {
  CLEAN_PRICE,
  CREDIT,
  EVERY_PLAN,
  EVERY_PLAN_LEAD,
  FROM_PACK,
  KEEP_FILES,
  KEPT,
  markWord,
  OPTIONS,
  PACK_ROWS,
  PRICING_FAQS,
  ROWS,
  SELF_HOSTED,
} from '../pricing.ts';
import { DOCS_URL, SITE_URL } from '../seo.ts';
import { Breadcrumbs, Footer, JsonLd, Nav, SIGN_UP } from '../shell.tsx';

// /pricing: every fact a person or an agent needs to choose, in the server-rendered HTML. The same
// data builds /pricing.md and /pricing.json.

const FREE = FREE_CREDITS;
const TITLE = 'Pricing: make for free, pay only to remove the watermark, no subscription';
const DESCRIPTION = `cuttingfloor, the video editing MCP server: making is free, every tool, no card, and every export downloads free with a cuttingfloor watermark. Removing the watermark costs ${CLEAN_PRICE}; credit packs from ${FROM_PACK} never expire, with no subscription. Enterprise by agreement; free to self-host, with no watermark (open source, ${LICENCE}).`;

export const metadata: Metadata = {
  title: `${TITLE} | cuttingfloor`,
  description: DESCRIPTION,
  alternates: { canonical: '/pricing', types: { 'text/markdown': '/pricing.md' } },
  openGraph: { type: 'website', url: '/pricing', title: TITLE, description: DESCRIPTION },
};

function structuredData() {
  const url = new URL('/pricing', SITE_URL).toString();
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'cuttingfloor',
      url: SITE_URL,
      description: DESCRIPTION,
      applicationCategory: 'MultimediaApplication',
      applicationSubCategory: 'Video editing MCP server',
      operatingSystem: 'Any MCP client; self-hosted with Docker',
      license: 'https://www.gnu.org/licenses/agpl-3.0.html',
      softwareHelp: DOCS_URL,
      offers: OPTIONS.filter((o) => o.amount !== undefined).map((o) => ({
        '@type': 'Offer',
        name: o.name,
        price: String(o.amount),
        priceCurrency: 'USD',
        url: o.hosted ? url : new URL(o.href, SITE_URL).toString(),
        description: o.note,
        ...(o.id === 'self-hosted'
          ? {}
          : {
              priceSpecification: {
                '@type': 'UnitPriceSpecification',
                price: String(o.amount),
                priceCurrency: 'USD',
              },
            }),
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: PRICING_FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ];
}

const CAPTION = 'What each option includes. Self-hosted is free; hosted prices in USD.';

/** On a phone the comparison stacks, one option at a time: the hosted ones people start with first. */
const PHONE_ORDER = [...OPTIONS.filter((o) => o.hosted), ...OPTIONS.filter((o) => !o.hosted)];

export default function Pricing() {
  return (
    <>
      <JsonLd data={structuredData()} />
      <Nav />
      <main className="frame wt">
        <section className="cell wt-head marks">
          <span className="mark-b" />
          <Breadcrumbs trail={[{ name: 'Pricing', href: '/pricing' }]} />
          <span className="label">Pricing</span>
          <h1 className="display">Make for free. Pay only to remove the watermark.</h1>
          <p className="lede wt-answer">
            Editing, exports, graphics and voiceovers cost nothing, retries included. Every export
            downloads free with a cuttingfloor watermark; removing the watermark costs {CLEAN_PRICE}
            .{' '}
            <em>
              {FREE} credits when you activate your account, then packs from {FROM_PACK}. They never
              expire and there is no subscription. Or run it yourself, free, with no watermark.
            </em>
          </p>
          <LiveCard />
          <div className="actions">
            <a className="link-big" href={SIGN_UP}>
              Start free
            </a>
            <a className="link-big quiet" href={SELF_HOSTED.href}>
              Run it yourself, free
            </a>
          </div>
        </section>

        <section className="cell" id="packs">
          <div className="head">
            <span className="label">01 / Credits</span>
            <div>
              <h2 className="display">Buy what you take.</h2>
              <p className="compare-lede">
                A credit removes the watermark from one finished minute. Packs, bought on your
                account page. Bigger packs cost less a credit. Turn on automatic top-up and you
                never run out.
              </p>
            </div>
          </div>
          <table className="price-table">
            <thead>
              <tr>
                <th>Pack</th>
                <th>Credits</th>
                <th>A credit</th>
              </tr>
            </thead>
            <tbody>
              {PACK_ROWS.map((p) => (
                <tr key={p.id}>
                  <td className="amount">${p.price}</td>
                  <td className="tier">{p.credits.toLocaleString('en-US')} credits</td>
                  <td className="note">{p.per_credit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="cell" id="plans">
          <div className="head">
            <span className="label">02 / Ways to run it</span>
            <h2 className="display">Pick one.</h2>
          </div>
          <table className="price-table">
            <thead>
              <tr>
                <th>Option</th>
                <th>Price</th>
                <th>For</th>
                <th>Start</th>
              </tr>
            </thead>
            <tbody>
              {OPTIONS.map((o) => (
                <tr key={o.id} className={o.pick ? 'pick' : ''}>
                  <td className="tier">{o.name}</td>
                  <td className="amount">
                    {o.price} {o.per ? <small>{o.per}</small> : null}
                  </td>
                  <td className="note">{o.note}</td>
                  <td>
                    <a href={o.href}>{o.cta}</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="cell" id="every-plan">
          <div className="head">
            <span className="label">03 / Everyone</span>
            <div>
              <h2 className="display">What you get.</h2>
              <p className="compare-lede">{EVERY_PLAN_LEAD}</p>
            </div>
          </div>
          <ul className="pr-list">
            {EVERY_PLAN.map((f) => (
              <li key={f} className="pr-item">
                {f}
              </li>
            ))}
          </ul>
          <p className="price-foot">
            {KEEP_FILES} All of it, tool by tool: <a href="/features">Features</a>
          </p>
        </section>

        <section className="cell" id="compare">
          <div className="head">
            <span className="label">04 / Limits</span>
            <div>
              <h2 className="display">What differs.</h2>
              <p className="compare-lede">
                The watermark, credits, size and storage. Your first pack lifts the free storage
                limit. Prices in US dollars.
              </p>
            </div>
          </div>
          <div className="pr-scroll">
            <table className="pr-grid">
              <caption className="pr-caption">{CAPTION}</caption>
              <thead>
                <tr>
                  <th scope="col">Feature</th>
                  {OPTIONS.map((o) => (
                    <th key={o.id} scope="col" className={o.pick ? 'pick' : undefined}>
                      {o.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    {OPTIONS.map((o) => {
                      const c = r.cells[o.id];
                      return (
                        <td key={o.id} data-mark={c.mark}>
                          {c.mark === 'value' ? null : (
                            <span className="pr-mark">{markWord(c.mark)}</span>
                          )}
                          {c.text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pr-cards">
            {PHONE_ORDER.map((o) => (
              <section key={o.id} className={o.pick ? 'pr-card pick' : 'pr-card'}>
                <h3>{o.name}</h3>
                <dl>
                  {ROWS.map((r) => {
                    const c = r.cells[o.id];
                    return (
                      <div key={r.label} data-mark={c.mark}>
                        <dt>{r.label}</dt>
                        <dd>
                          {c.mark === 'value' ? null : (
                            <span className="pr-mark">{markWord(c.mark)}</span>
                          )}
                          {c.text}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}
            <p className="pr-caption">{CAPTION}</p>
          </div>
          <p className="price-foot">
            {KEPT} Payments by Stripe; nothing renews. <a href="/terms">Terms</a> ·{' '}
            <a href="/refunds">Refunds</a>
          </p>
        </section>

        <section className="cell" id="credits">
          <div className="head">
            <span className="label">05 / Credits</span>
            <h2 className="display">What a credit is.</h2>
          </div>
          <ol className="ledger">
            {CREDIT.map((line, i) => (
              <li key={line}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <p className="pr-ledger-p">{line}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="cell" id="keys">
          <div className="head">
            <span className="label">06 / Keys</span>
            <div>
              <h2 className="display">What needs your own key.</h2>
              <p className="compare-lede">
                Only these. Everything else runs on the server with no key, hosted or self-hosted.
              </p>
            </div>
          </div>
          <table className="compare-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Tools</th>
                <th>Hosted</th>
                <th>Self-hosted</th>
              </tr>
            </thead>
            <tbody>
              {KEYS.map((k) => (
                <tr key={k.feature}>
                  <td>{k.feature}</td>
                  <td>
                    {k.tools.map((t, i) => (
                      <span key={t}>
                        {i > 0 ? ', ' : null}
                        <code>{t}</code>
                      </span>
                    ))}
                  </td>
                  <td>{k.hosted}</td>
                  <td>{k.selfHosted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="cell paper" id="self-host">
          <div className="wt-prose">
            <section>
              <span className="label">07 / Self-hosted</span>
              <h2>Self-hosted · Free</h2>
              <p>
                cuttingfloor is open source under {LICENCE}. It runs in one Docker image ({IMAGE}),
                the same image the hosted service runs. You run it on your own machine, with no
                watermark, no limits and no credits, and bring your own keys for lip-sync and visual
                judgment (the table above).
              </p>
              <pre className="pr-steps">
                <code>{SELF_HOST_STEPS.join('\n')}</code>
              </pre>
              <p>
                Your agent then connects to <code>{LOCAL_ADDRESS}</code>. The whole setup:{' '}
                <a href="/self-host">self-hosting cuttingfloor</a>. Source:{' '}
                <a href={REPO_URL}>GitHub</a>.
              </p>
            </section>
          </div>
        </section>

        <section className="cell" id="faq">
          <div className="head">
            <span className="label">08 / Questions</span>
            <h2 className="display">Asked.</h2>
          </div>
          <div className="faq">
            {PRICING_FAQS.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
          <p className="price-foot">
            Something else? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> · This page as{' '}
            <a href="/pricing.md">Markdown</a> or <a href="/pricing.json">JSON</a>
          </p>
        </section>

        <Footer />
      </main>
    </>
  );
}
