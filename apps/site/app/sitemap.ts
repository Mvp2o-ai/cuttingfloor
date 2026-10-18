import type { MetadataRoute } from 'next';
import { ROUTES } from './routes.ts';
import { SITE_URL } from './seo.ts';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...ROUTES.map((r) => ({
      url: new URL(r.path, SITE_URL).toString(),
      lastModified: r.updated,
      changeFrequency: 'weekly' as const,
      priority: r.path === '/' ? 1 : 0.8,
    })),
    { url: `${SITE_URL}/llms.txt`, changeFrequency: 'weekly', priority: 0.5 },
  ];
}
