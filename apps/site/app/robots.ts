import type { MetadataRoute } from 'next';
import { SITE_URL } from './seo.ts';

// Everyone may crawl the public page, AI crawlers included; the signed-in routes are nobody's business.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/callback'] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
