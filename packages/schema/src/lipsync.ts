import * as z from 'zod/v4';
import { MediaId } from './ids.ts';

// create.lipsync: a talking video re-synced to new speech by a lip-sync provider, with the
// user's own key (bring your own key). The provider's limits come back as facts in errors.

/** What protects this server: the longest span a call sends (cutting, uploading, waiting). */
export const LIPSYNC_LIMITS = { maxSeconds: 600 } as const;

export const LIPSYNC_PROVIDERS = ['sync'] as const;
export const LIPSYNC_MODELS = ['lipsync-2', 'lipsync-2-pro', 'sync-3'] as const;
export const SYNC_MODES = ['remap', 'cut_off', 'silence', 'loop', 'bounce'] as const;

const SecondsRange = z
  .object({
    start_seconds: z.number().min(0),
    end_seconds: z.number().positive(),
  })
  .refine((r) => r.end_seconds > r.start_seconds, {
    message: 'end_seconds must be after start_seconds',
  })
  .refine((r) => r.end_seconds - r.start_seconds <= LIPSYNC_LIMITS.maxSeconds, {
    message: `A range is up to ${LIPSYNC_LIMITS.maxSeconds} s`,
  });

export const CreateLipsyncInput = z.object({
  video: MediaId.describe('The video of the person speaking, whose mouth is redrawn'),
  audio: MediaId.describe(
    'The speech they should say: audio media, or a video whose sound is used (e.g. create.voiceover, a re-recorded line)',
  ),
  range: SecondsRange.optional().describe(
    "Only this span of the video, in the video's seconds (e.g. the sentence or word being replaced). The result is that span alone, re-synced; place it over the same span on the timeline. Default: the whole video",
  ),
  audio_range: SecondsRange.optional().describe(
    "Only this span of the audio, in the audio's seconds. Default: all of it",
  ),
  sync_mode: z
    .enum(SYNC_MODES)
    .default('remap')
    .describe(
      'When the picture and the speech differ in length. remap: the picture is sped up or slowed to the speech (result as long as the speech); cut_off: the longer one is cut (as long as the shorter); silence: the speech is padded with silence (as long as the longer); loop / bounce: the picture repeats, or plays back and forth, to cover longer speech (as long as the speech)',
    ),
  model: z
    .enum(LIPSYNC_MODELS)
    .default('lipsync-2')
    .describe(
      "The provider's model: lipsync-2 (the cheapest, about $0.05 a second), lipsync-2-pro (finer teeth, beards and detail), sync-3 (close-ups, profiles, hands or mics in front of the mouth; about $0.13 a second). Billed to the user's own key",
    ),
  provider: z
    .enum(LIPSYNC_PROVIDERS)
    .default('sync')
    .describe("sync: sync. labs (sync.so), with the user's SYNC_API_KEY"),
  name: z.string().min(1).max(200).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type CreateLipsyncInput = z.infer<typeof CreateLipsyncInput>;
