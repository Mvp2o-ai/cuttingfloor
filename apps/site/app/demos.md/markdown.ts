import { DEMOS, type DemoVideo, demo, finished, length, lengths } from '../../content/demos.ts';
import { skill } from '../../content/skills.ts';
import { abs, doc, list, pageLink } from '../lib/markdown.ts';
import { ROUTES } from '../routes.ts';

// /demos and each /demos/<slug> as Markdown, from the demo data the pages render.

const updated = (path: string) => ROUTES.find((r) => r.path === path)?.updated;
const video = (v: DemoVideo) =>
  `[${v.label}](${abs(v.src)})${v.captions ? ` · [captions](${abs(v.captions)})` : ''}`;

export function markdown(): string {
  return doc({
    path: '/demos',
    title: 'Demos: watch your agent edit',
    summary:
      'Each demo is a real clip edited by a creator’s own agent with cuttingfloor connected: what they asked for, every step the agent took, and the video before and after.',
    updated: updated('/demos'),
    body: `## Demos\n\n${list(
      DEMOS.map(
        (d) =>
          `${pageLink(d.title, `/demos/${d.slug}`)}: ${d.description} (${d.agent}, ${lengths(d)})`,
      ),
    )}`,
  });
}

export function demoMarkdown(slug: string): string | undefined {
  const d = demo(slug);
  if (!d) return undefined;
  const s = d.skill ? skill(d.skill) : undefined;
  const v = finished(d);
  const cuts = d.transcript.filter((w) => w.cut !== undefined).length;
  const turns = d.turns.map((t, i) =>
    [
      `### Turn ${i + 1}`,
      `**You:** ${t.prompt}`,
      `**${d.agent}:** ${t.reply}`,
      'Tool calls:',
      t.calls.map((c, j) => `${j + 1}. \`${c.fn}\`: ${c.note}`).join('\n'),
      `**${d.agent}:** ${t.done}`,
      `Result: ${video(t.video)}`,
    ].join('\n\n'),
  );
  return doc({
    path: `/demos/${d.slug}`,
    title: d.title,
    summary: d.description,
    updated: d.uploaded,
    body: [
      `Agent: ${d.agent}, with cuttingfloor connected. Length: ${lengths(d)}.`,
      `## Before\n\nThe clip as it came in (${length(d.raw)}): ${video(d.raw)}`,
      `### ${cuts ? 'What needs to go' : 'What it says'}`,
      cuts ? `Struck through: ${cuts} ${cuts === 1 ? 'thing' : 'things'} the agent cuts.` : '',
      list(d.transcript.map((w) => (w.cut === undefined ? w.text : `~~${w.text}~~`))),
      `## The edit, in ${d.agent}`,
      ...turns,
      `## After\n\nReady to post (${lengths(d)}): ${video(v)}`,
      `### What the agent did\n\n${d.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}`,
      d.moments?.length
        ? `### Moments\n\n${list(d.moments.map((m) => `${m.start}s–${m.end}s: ${m.name}`))}`
        : '',
      d.extra?.length
        ? `### Other versions\n\n${list(d.extra.map((x) => `${x.caption}: ${video(x)}`))}`
        : '',
      s ? `The skill it followed: ${pageLink(s.title, `/skills/${s.slug}`)}` : '',
      `## More demos\n\n${list(
        DEMOS.filter((o) => o !== d).map((o) => pageLink(o.title, `/demos/${o.slug}`)),
      )}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  });
}
