import type { Lang } from '../content/guides.ts';
import { TOOL_CALLS_TEXT, type ToolCall } from '../content/tool-calls.ts';

// "MCP tool calls": the cuttingfloor tools an agent calls for the job, in order, each with what it
// does there. For the curious and for agents reading the page; nobody has to know them to ask.

const TEXT = TOOL_CALLS_TEXT;

export function ToolCalls({ tools, lang, n }: { tools: ToolCall[]; lang: Lang; n: string }) {
  const t = TEXT[lang];
  return (
    <section className="cell">
      <div className="head">
        <span className="label">
          {n} / {t.label}
        </span>
        <div>
          <h2 className="lede">{t.heading}</h2>
          <p className="compare-lede">{t.note}</p>
        </div>
      </div>
      <ol className="ledger">
        {tools.map((c, i) => (
          <li key={`${c.tool}: ${c.does}`}>
            <span className="n">{String(i + 1).padStart(2, '0')}</span>
            <h3>
              <code>{c.tool}</code>
            </h3>
            <p>{c.does}</p>
          </li>
        ))}
      </ol>
      <p className="wt-links">
        <a href="/features#tools">{t.all}</a>
      </p>
    </section>
  );
}
