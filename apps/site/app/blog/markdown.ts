import { BLOG_UPDATED, type BlogBlock, blogPath, POSTS, post } from '../../content/blog.ts';
import { abs, doc, list, pageLink } from '../lib/markdown.ts';

// /blog and each /blog/<slug> as Markdown, from the post data.

function block(b: BlogBlock): string {
  if (b.kind === 'p') return b.text;
  if (b.kind === 'list') return list(b.items);
  return `![${b.alt}](${abs(b.src)})\n\n_${b.caption}_`;
}

export function markdown(): string {
  return doc({
    path: '/blog',
    title: 'cuttingfloor blog',
    summary: 'How cuttingfloor’s features work, from the side of the person using them.',
    updated: BLOG_UPDATED,
    body: `## Posts\n\n${list(POSTS.map((p) => `${pageLink(p.title, blogPath(p))}: ${p.metaDescription}`))}`,
  });
}

export function blogMarkdown(slug: string): string | undefined {
  const p = post(slug);
  if (!p) return undefined;
  return doc({
    path: blogPath(p),
    title: p.title,
    summary: p.lede,
    updated: p.updated,
    body: [
      ...p.sections.map((s) => `## ${s.heading}\n\n${s.blocks.map(block).join('\n\n')}`),
      `## Try it\n\n${pageLink(p.tryIt.label, p.tryIt.href)}, and say:\n\n\`\`\`\n${p.tryIt.prompt}\n\`\`\``,
    ].join('\n\n'),
  });
}
