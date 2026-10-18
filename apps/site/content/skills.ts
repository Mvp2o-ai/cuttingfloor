import { join } from 'node:path';
import { loadLibrary, type Skill } from '@cuttingfloor/skills/library';

// Every skill, read from skills/*.md at the repo root when the site builds, and checked the way
// the server checks them. /skills and /skills/[slug] render from this list alone, so a new file
// in skills/ adds a page, a card, a sitemap entry and a line in llms.txt.

export type { Skill };

/** The last time any skill changed; the sitemap's date for the skill pages. */
export const SKILLS_UPDATED = '2026-10-18';

// next build runs in apps/site.
export const SKILLS: Skill[] = loadLibrary(join(process.cwd(), '..', '..', 'skills')).skills.filter(
  (s) => !s.hidden,
);

export const skill = (slug: string): Skill | undefined => SKILLS.find((s) => s.slug === slug);
