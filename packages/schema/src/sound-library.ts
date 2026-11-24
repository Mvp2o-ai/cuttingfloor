import * as z from 'zod/v4';

// sounds.list: the sound library (sound effects from CC0 and public-domain packs, kept by
// cuttingfloor, and the community pack: sounds people shared) by page, or ranked by a sound
// described in words. SoundShareInput: what a person gives to share a sound of theirs.

/** Most sounds in one page. */
export const SOUNDS_LIST_LIMIT = 50;

/** How deep a search ranks: offset plus limit never goes past it. */
export const SOUNDS_SEARCH_DEPTH = 500;

/** The pack of sounds people shared. */
export const COMMUNITY_PACK = 'community';

/** How far back `popular` counts uses. */
export const POPULAR_DAYS = 7;

export const SoundsListInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe(
      'A sound in words ("footsteps on gravel", "a giant stomping", "rain on a window", "crowd cheering"): the closest sounds first, matched on their names and tags and on how they sound. Left out: the library in order (order).',
    ),
  sound_ids: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(SOUNDS_LIST_LIMIT)
    .optional()
    .describe(
      'Only these sounds, in this order (sound_id from an earlier result): to show the user particular sounds so they can hear them',
    ),
  category: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Only sounds in this category (categories in the result lists them)'),
  pack: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Only sounds from this pack (packs in the result lists them)'),
  order: z
    .enum(['category', 'popular', 'newest'])
    .default('category')
    .describe(
      `Without query: category (by category, then name), popular (most used in edits over the last ${POPULAR_DAYS} days, then newest) or newest (latest added first)`,
    ),
  max_seconds: z.number().positive().optional().describe('Only sounds this long or shorter'),
  min_seconds: z.number().min(0).optional().describe('Only sounds this long or longer'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SOUNDS_LIST_LIMIT)
    .default(20)
    .describe('Most sounds in one answer'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Where a page starts: the next_offset of the page before'),
});

export const LibrarySound = z.object({
  sound_id: z.string(),
  name: z.string(),
  description: z.string().describe('What it is, as its pack describes it'),
  tags: z.array(z.string()),
  category: z.string(),
  pack: z.string(),
  seconds: z.number().describe('Length'),
  channels: z.number().int(),
  loudness_lufs: z.number().nullable().describe('Integrated loudness of the file, measured'),
  peak_dbtp: z.number().nullable().describe('True peak of the file, measured'),
  url: z
    .string()
    .describe('The file exactly as its pack published it (WAV, OGG, FLAC…), for media.import'),
  licence: z
    .string()
    .describe(
      `CC0 or public domain; in the ${COMMUNITY_PACK} pack, "Shared by its uploader": a person shared it and vouches for it, not cuttingfloor`,
    ),
  author: z.string().nullable().describe('Who made it or, in the community pack, who shared it'),
  source_url: z.string().nullable().describe('Where the pack published it'),
  similarity: z
    .number()
    .optional()
    .describe(
      'Searched: how close the sound is to query by how it sounds, 0–1 (CLAP); higher is closer',
    ),
  keyword_match: z
    .boolean()
    .optional()
    .describe("Searched: whether query's words match its name, tags, category or description"),
  uses: z
    .number()
    .int()
    .optional()
    .describe(`order popular: edits that used it in the last ${POPULAR_DAYS} days`),
  added_at: z.string().optional().describe('When it was added (ISO 8601)'),
});

export const SoundsListResult = z.object({
  searched: z
    .boolean()
    .describe(
      'true: sounds ranked by query, closest first. false: the library in order (no query, or the search could not run; note says why)',
    ),
  note: z.string().optional().describe('Why a query was not searched, or searched only in part'),
  sounds: z.array(LibrarySound),
  next_offset: z.number().int().nullable().describe('offset for the next page; null on the last'),
  total: z
    .number()
    .int()
    .nullable()
    .describe(
      `Sounds that match the filters; null for a search, which ranks the closest ${SOUNDS_SEARCH_DEPTH}`,
    ),
  categories: z
    .array(z.object({ category: z.string(), sounds: z.number().int() }))
    .describe('Every category in the library, with how many sounds it has'),
  packs: z
    .array(
      z.object({
        pack: z.string(),
        sounds: z.number().int(),
        licence: z.string(),
        source_url: z.string().nullable(),
      }),
    )
    .describe('Every pack in the library, its licence and where it comes from'),
});

/** Longest sound the community pack takes. */
export const SHARED_SOUND_SECONDS = 180;

/** Largest file the community pack takes. */
export const SHARED_SOUND_BYTES = 25 * 1024 ** 2;

/** What a person gives to share one of their sounds in the community pack. */
export const SoundShareInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  category: z.string().trim().min(1).max(60),
  /** The name it is credited to; left out, the account's first name. */
  author: z.string().trim().min(1).max(60).optional(),
});

export type SoundsListInput = z.infer<typeof SoundsListInput>;
export type SoundShareInput = z.infer<typeof SoundShareInput>;
export type LibrarySound = z.infer<typeof LibrarySound>;
export type SoundsListResult = z.infer<typeof SoundsListResult>;
