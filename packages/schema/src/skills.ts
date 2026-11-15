import * as z from 'zod/v4';

// Skills: step-by-step instructions for a common job, followed with the tools. One Markdown file
// per skill under skills/, in one-mcp's playbook format, so the two can share tooling.

export const SKILL_LIMITS = {
  descriptionChars: 1024,
  bodyLines: 500,
  bytes: 64 * 1024,
  searchResults: 20,
} as const;

/**
 * The score (0–1: 60% meaning, 40% shared words) a skill needs to count as a match. A search
 * with none at or above it is a miss and answers with the list of every skill instead.
 */
export const SKILL_MATCH_MIN = 0.7;

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
    .optional()
    .describe(
      'What the user wants done, in their words, e.g. "remove the ums from my video". Without it, the list of every skill',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SKILL_LIMITS.searchResults)
    .default(5)
    .describe('Most skills in one answer'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Where a page of the list starts: the next_offset of the page before'),
});

export const SkillMatch = z.object({
  slug: SkillSlug,
  name: z.string(),
  description: z.string(),
});

export const SkillsSearchResult = z.object({
  matched: z
    .boolean()
    .describe(
      'true: these skills fit the query, best first; false: none did, and this is a page of every skill',
    ),
  skills: z.array(SkillMatch),
  total: z.number().int().describe('Skills in the whole answer, across its pages'),
  next_offset: z.number().int().nullable().describe('offset for the next page; null on the last'),
});

export const SkillsGetInput = z.object({
  slug: SkillSlug.describe('From skills.search, e.g. "cut-pauses-ums-and-restarts"'),
});

export const SkillsGetResult = z.object({
  slug: SkillSlug,
  name: z.string(),
  description: z.string(),
  version: z.number(),
  author: z.string().describe('Who wrote the skill; credit them when you name it'),
  author_url: z
    .url()
    .nullable()
    .describe('A link to the author or the work the skill came from; null when there is none'),
  related: z.array(SkillRelated),
  markdown: z.string().describe('The whole skill, frontmatter included: follow its Steps'),
});
