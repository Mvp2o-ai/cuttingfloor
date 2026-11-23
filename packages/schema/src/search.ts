import * as z from 'zod/v4';
import { MediaId } from './ids.ts';
import { JUDGE_LIMITS, JudgeName } from './judge.ts';
import { SeekCriterion } from './tools.ts';

// media.search: plain-language criteria judged across the media on the floor, as media.seek judges
// one video. Pictures are judged at their keyframes (picked when the media was indexed), speech
// in passages of a transcript the media already has.

/** Limits that protect the server. */
export const SEARCH_LIMITS = {
  /** Criteria in one call, across looks and says: one judgment carries them all. */
  criteria: JUDGE_LIMITS.lookQuestions,
  mediaIds: 200,
  /** Judgments one call may ask, however it is confirmed. */
  judgments: 20_000,
} as const;

/** Why a call over 200 judgments runs anyway. */
export const SearchCostOverride = z.enum(['user_confirmed', 'user_preapproved']);

export const SEARCHABLE_KINDS = ['video', 'image', 'audio', 'font', 'lut'] as const;

export const MediaSearchInput = z
  .object({
    looks: z
      .record(JudgeName, SeekCriterion)
      .optional()
      .describe(
        'Name (yours) to what a matching picture shows, judged on every keyframe of each video and on each image: a statement about the picture, or {instructions, criteria: {true, false}} with a case of each',
      ),
    says: z
      .record(JudgeName, SeekCriterion)
      .optional()
      .describe(
        "Name to what matching speech says, judged on ~30 s passages of each media's existing transcript; media without one are listed as skipped",
      ),
    kind: z.array(z.enum(SEARCHABLE_KINDS)).min(1).optional().describe('Only these kinds. Free'),
    media_ids: z
      .array(MediaId)
      .min(1)
      .max(SEARCH_LIMITS.mediaIds)
      .optional()
      .describe('Only these media. Free'),
    from: z
      .array(z.enum(['upload', 'url', 'path', 'render', 'created']))
      .min(1)
      .optional()
      .describe("Only media that came this way (media.list's from). Free"),
    name_contains: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Only media whose name contains this, ignoring case. Free'),
    min_duration_seconds: z
      .number()
      .min(0)
      .optional()
      .describe('Only media at least this long. Free'),
    max_duration_seconds: z
      .number()
      .min(0)
      .optional()
      .describe('Only media at most this long. Free'),
    from_seconds: z
      .number()
      .min(0)
      .optional()
      .describe('Judge each media from this second on. Free'),
    until_seconds: z
      .number()
      .min(0)
      .optional()
      .describe('Judge each media up to this second. Free'),
    candidates: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_LIMITS.mediaIds)
      .optional()
      .describe(
        'Judge only the media whose pictures look most like the looks criteria, by local similarity (free, no judgments): far cheaper, and can drop media where the thing is small or brief',
      ),
    min_probability: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe('A keyframe or passage matches a criterion when its probability is at least this'),
    cost_override: SearchCostOverride.optional().describe(
      'Run a search estimated over 200 judgments: user_confirmed (the user saw this estimate and agreed) or user_preapproved (the user said to search however large)',
    ),
    idempotency_key: z.string().min(1).max(200).optional(),
  })
  .refine((v) => Object.keys(v.looks ?? {}).length + Object.keys(v.says ?? {}).length > 0, {
    message: 'Give looks, says or both',
  });
export type MediaSearchInput = z.infer<typeof MediaSearchInput>;

const Judgments = z.object({
  media: z.number().int(),
  judgments: z.number().int(),
});

export const SearchEstimate = z.object({
  media: z.number().int().describe('Media that would be judged'),
  judgments: z.number().int().describe('Keyframes and passages judged: one judgment each'),
  credits: z.number().describe('Credits it spends: 0, since searching, like all making, is free'),
  by_kind: z.record(z.string(), Judgments).describe('Per kind: media and judgments'),
  largest: z
    .array(
      z.object({
        media_id: MediaId,
        name: z.string(),
        kind: z.string(),
        duration_seconds: z.number().nullable(),
        judgments: z.number().int(),
      }),
    )
    .describe('The media taking the most judgments, most first (up to 10)'),
});

export const MediaSearchResult = z.object({
  searched: z
    .boolean()
    .describe('false: over 200 judgments without cost_override; nothing was judged'),
  estimate: SearchEstimate,
  warning: z
    .string()
    .optional()
    .describe('When not searched: the cost, what makes it up, and what the free filters would cut'),
  model: z.string().optional().describe('The judgment model that judged'),
  asked: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .describe('Per criterion: the noul question the judgment model is asked, as sent'),
  matches: z
    .record(
      z.string(),
      z.array(
        z.object({
          media_id: MediaId,
          name: z.string(),
          kind: z.string(),
          start: z.number().describe('Seconds where the match starts'),
          end: z.number().describe('Seconds where it ends: the next keyframe or the passage end'),
          peak_seconds: z.number(),
          peak_probability: z.number(),
          uri: z.string().optional().describe('looks: MCP resource, the picture at peak_seconds'),
          text: z.string().optional().describe('says: the passage'),
        }),
      ),
    )
    .describe('Per criterion: every match across the media, most probable first; empty when none'),
  judged: z.array(MediaId).describe('Media judged'),
  skipped: z
    .array(
      z.object({
        media_id: MediaId,
        name: z.string(),
        route: z.enum(['looks', 'says']),
        reason: z.enum([
          'not_ready',
          'indexing',
          'index_failed',
          'no_picture',
          'no_transcript',
          'outside_candidates',
        ]),
      }),
    )
    .describe(
      'Media the filters kept but nothing judged, and why: not found there is not the same as not there',
    ),
  candidates: z
    .array(z.object({ media_id: MediaId, similarity: z.number() }))
    .optional()
    .describe('With candidates: each media by its best keyframe similarity, highest first'),
});
export type MediaSearchResult = z.infer<typeof MediaSearchResult>;
