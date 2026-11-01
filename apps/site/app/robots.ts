import type { MetadataRoute } from 'next';
import { SITE_URL } from './seo.ts';

// Everyone may crawl the public pages and their Markdown twins. Search and answer engines' crawlers
// and the agents that fetch for a user are named so the intent is plain, and training crawlers are
// welcome too: the code is open source. The signed-in routes are nobody's business, and /md/ is
// the internal address of twins that are public at <page>.md.
const DISALLOW = ['/api/', '/callback', '/account', '/welcome', '/start', '/md/'];

const AGENTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'GPTBot',
  'Claude-SearchBot',
  'Claude-User',
  'ClaudeBot',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Googlebot',
  'Bingbot',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: AGENTS, allow: '/', disallow: DISALLOW },
      { userAgent: '*', allow: '/', disallow: DISALLOW },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
