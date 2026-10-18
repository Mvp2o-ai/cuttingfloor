import type { MetadataRoute } from 'next';
import { DEMOS, finished } from '../content/demos.ts';
import { ROUTES } from './routes.ts';
import { SITE_URL } from './seo.ts';

// Each demo's watch page carries its finished video, so Google finds the video with the page.
function videos(path: string) {
  const d = DEMOS.find((x) => `/demos/${x.slug}` === path);
  if (!d) return undefined;
  const v = finished(d);
  return [
    {
      title: d.title,
      description: d.description,
      thumbnail_loc: new URL(v.poster ?? d.raw.poster ?? '', SITE_URL).toString(),
      content_loc: new URL(v.src, SITE_URL).toString(),
      duration: Math.round(v.seconds),
      publication_date: `${d.uploaded}T12:00:00+00:00`,
    },
  ];
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...ROUTES.map((r) => ({
      url: new URL(r.path, SITE_URL).toString(),
      lastModified: r.updated,
      changeFrequency: 'weekly' as const,
      priority: r.path === '/' ? 1 : 0.8,
      videos: videos(r.path),
    })),
    { url: `${SITE_URL}/llms.txt`, changeFrequency: 'weekly', priority: 0.5 },
  ];
}
