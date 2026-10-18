import type { ReactNode } from 'react';

// The Markdown a skill is written in, and only that: ## sections, numbered steps with bullets
// under them, bullet lists, tables, paragraphs, `code`, **bold** and [links](…). The library
// checks every skill's shape, so a small renderer covers all of them, with no HTML from strings.

type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: { text: string; sub: string[] }[] }
  | { kind: 'table'; head: string[]; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

function blocks(body: string): Block[] {
  const out: Block[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const last = out.at(-1);
    if (!line.trim() || /^#(?!#)\s/.test(line)) continue;
    const h2 = /^##\s+(.+)$/.exec(line);
    const step = /^\d+\.\s+(.+)$/.exec(line);
    const sub = /^\s+[-*]\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (h2) out.push({ kind: 'h2', text: h2[1] as string });
    else if (step) {
      const item = { text: step[1] as string, sub: [] as string[] };
      if (last?.kind === 'ol') last.items.push(item);
      else out.push({ kind: 'ol', items: [item] });
    } else if (sub && last?.kind === 'ol') last.items.at(-1)?.sub.push(sub[1] as string);
    else if (bullet || sub) {
      const text = ((bullet ?? sub) as RegExpExecArray)[1] as string;
      if (last?.kind === 'ul') last.items.push(text);
      else out.push({ kind: 'ul', items: [text] });
    } else if (line.trim().startsWith('|')) {
      const row = cells(line);
      if (row.every((c) => /^:?-+:?$/.test(c))) continue;
      if (last?.kind === 'table') last.rows.push(row);
      else out.push({ kind: 'table', head: row, rows: [] });
    } else if (last?.kind === 'p' && lines[i - 1]?.trim()) last.text += ` ${line.trim()}`;
    else out.push({ kind: 'p', text: line.trim() });
  }
  return out;
}

/** `code`, **bold** and [links](url) inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/).map((part, i) => {
    const key = `${i}${part}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={key} href={link[2]}>
          {link[1]}
        </a>
      );
    }
    return part;
  });
}

/** A skill's body, without its title (the page's H1). */
export function Markdown({ body }: { body: string }) {
  return (
    <div className="sk-body">
      {blocks(body).map((b, i) => {
        const key = `${i}${b.kind}`;
        switch (b.kind) {
          case 'h2':
            return <h2 key={key}>{inline(b.text)}</h2>;
          case 'p':
            return <p key={key}>{inline(b.text)}</p>;
          case 'ul':
            return (
              <ul key={key}>
                {b.items.map((t) => (
                  <li key={t}>{inline(t)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key}>
                {b.items.map((it) => (
                  <li key={it.text}>
                    {inline(it.text)}
                    {it.sub.length > 0 && (
                      <ul>
                        {it.sub.map((t) => (
                          <li key={t}>{inline(t)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            );
          case 'table':
            return (
              <div key={key} className="sk-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c) => (
                        <th key={c}>{inline(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r) => (
                      <tr key={r.join('|')}>
                        {b.head.map((h, j) => (
                          <td key={h}>{inline(r[j] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
