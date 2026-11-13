import { ALLOW_ACCESS, allowAccessNote, type Client } from '../../content/clients.ts';
import { SendToSelf } from '../agents/send.tsx';
import { Copy } from '../walkthroughs/copy.tsx';
import { LogoSlot } from './logo.tsx';

/** One app's setup: its steps, notes and help page, and what to paste. The agent pages use it too. */
export function ClientSection({ client: c, n }: { client: Client; n: number }) {
  return (
    <section className="cell cl-client" id={c.slug} aria-labelledby={`${c.slug}-name`}>
      <div className="head">
        <span className="label">
          {String(n).padStart(2, '0')} / {c.where}
        </span>
        <h2 id={`${c.slug}-name`} className="cl-name">
          <LogoSlot client={c} />
          <span className="sr-only">: how to connect cuttingfloor</span>
        </h2>
      </div>
      <div className="cl-body">
        <div>
          <ol className="cl-steps">
            {c.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {c.install && (
            <p className="actions">
              <a className="link-big" href={c.install.href} data-track={`Install: ${c.name}`}>
                {c.install.label}
              </a>
            </p>
          )}
          {(c.notes || c.localSignIn) && (
            <ul className="cl-notes">
              {c.localSignIn && (
                <li>
                  {allowAccessNote(c.name)} <a href={ALLOW_ACCESS}>What does this mean?</a>
                </li>
              )}
              {c.notes?.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {c.computerOnly && <SendToSelf app={c.name} />}
          {c.docs && (
            <p className="wt-links">
              <a href={c.docs} rel="noopener">
                {c.docsLabel ?? `${c.name}’s own help page`}
              </a>
            </p>
          )}
        </div>
        <div className="cl-snippets">
          {c.snippets.map((s) => (
            <figure key={s.label} className="wt-prompt">
              <pre>
                <code>{s.code}</code>
              </pre>
              <figcaption>
                <span className="label">{s.label}</span>
                <Copy text={s.code} label="Copy" />
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
