import { type Demo, finished } from '../../content/demos.ts';
import { SITE_URL } from '../seo.ts';

// A demo's finished video as Google reads it: VideoObject on its watch page, with the
// chapters as key moments.

const abs = (path: string) => new URL(path, SITE_URL).toString();

/** 21.96 → "PT22S", 75 → "PT1M15S". */
export function isoDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `PT${m ? `${m}M` : ''}${s % 60}S`;
}

export function videoObject(d: Demo) {
  const v = finished(d);
  const page = abs(`/demos/${d.slug}`);
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: d.title,
    description: d.description,
    thumbnailUrl: v.poster ? [abs(v.poster)] : [],
    uploadDate: `${d.uploaded}T12:00:00+00:00`,
    duration: isoDuration(v.seconds),
    contentUrl: abs(v.src),
    url: page,
    ...(d.moments?.length
      ? {
          hasPart: d.moments.map((m) => ({
            '@type': 'Clip',
            name: m.name,
            startOffset: Math.round(m.start),
            endOffset: Math.round(m.end),
            url: `${page}?t=${Math.round(m.start)}`,
          })),
        }
      : {}),
  };
}
