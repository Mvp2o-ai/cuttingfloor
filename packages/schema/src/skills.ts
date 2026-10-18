import * as z from 'zod/v4';

// Skills: step-by-step instructions for a common job, followed with the tools. One Markdown file
// per skill under skills/, in one-mcp's playbook format, so the two can share tooling.

export const SKILL_LIMITS = {
  descriptionChars: 1024,
  bodyLines: 500,
  bytes: 64 * 1024,
  searchResults: 20,
} as const;

/** A skill's slug: its file name and its frontmatter name. */
export const SkillSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and hyphens, e.g. "add-captions"');

export const SkillRelationship = z.enum(['prerequisite', 'alternative', 'extends', 'related']);
export type SkillRelationship = z.infer<typeof SkillRelationship>;

export const SkillRelated = z.object({ slug: SkillSlug, relationship: SkillRelationship });
export type SkillRelated = z.infer<typeof SkillRelated>;

export const SkillsSearchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('What the user wants done, in their words, e.g. "remove the ums from my video"'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SKILL_LIMITS.searchResults)
    .default(5)
    .describe('Most matches to return, best first'),
});

export const SkillMatch = z.object({
  slug: SkillSlug,
  name: z.string(),
  description: z.string(),
  score: z
    .number()
    .describe(
      'Roughly 0 to 1, higher is closer; below 0.1 is unrelated, above it read the description',
    ),
});

export const SkillsSearchResult = z.object({
  skills: z.array(SkillMatch).describe('Best first; empty when nothing fits'),
});

export const SkillsGetInput = z.object({
  slug: SkillSlug.describe('From skills.search, e.g. "cut-pauses-ums-and-restarts"'),
});

export const SkillsGetResult = z.object({
  slug: SkillSlug,
  name: z.string(),
  description: z.string(),
  version: z.number(),
  related: z.array(SkillRelated),
  markdown: z.string().describe('The whole skill, frontmatter included: follow its Steps'),
});
