import {
  BUILDER_FAQS,
  BUILDER_GUIDES,
  BUILDER_WAYS,
  CREATOR_WAYS,
  WAYS_DESCRIPTION,
  WAYS_TITLE,
  type Way,
} from '../../content/ways.ts';
import { SITE_URL } from '../seo.ts';

// /how-to-connect in plain Markdown, built from the same list as the page.

const link = (href: string) => (href.startsWith('http') ? href : `${SITE_URL}${href}`);

function way(w: Way): string[] {
  return [
    `### ${w.name}`,
    '',
    ...(w.tag ? [`_${w.tag}_`, ''] : []),
    w.text,
    '',
    ...(w.snippet ? [`${w.snippet.label}:`, '', '```', w.snippet.code, '```', ''] : []),
    w.links.map((l) => `[${l.label}](${link(l.href)})`).join(' · '),
    '',
  ];
}

export function markdown(): string {
  return [
    `# ${WAYS_TITLE}`,
    '',
    `> ${WAYS_DESCRIPTION}`,
    '',
    '## I make videos (creators, students, marketers)',
    '',
    'Use the AI app you already have. You sign in once: no keys, no code.',
    '',
    ...CREATOR_WAYS.flatMap(way),
    '## I build with code (recommended for engineers and builders)',
    '',
    'One REST API, two ways to call it: from your app’s backend like any web service, or from code an LLM runs in a sandbox. Either way it takes an API key from your account page, acts as your account and uses its credits.',
    '',
    ...BUILDER_WAYS.flatMap(way),
    `Guides: ${BUILDER_GUIDES.map((l) => `[${l.label}](${link(l.href)})`).join(' · ')}`,
    '',
    '## Questions engineers ask',
    '',
    ...BUILDER_FAQS.flatMap((f) => [`### ${f.q}`, '', f.a, '']),
  ].join('\n');
}
