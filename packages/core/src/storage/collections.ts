import type { ScoreDoc, TimelineDoc } from '@cuttingfloor/schema';
import { defineCollection } from './records.ts';

// The collections core itself keeps. Each package defines its own beside the code that owns them.

/** Immutable timelines by id; a read counts as a use. */
export const TIMELINES = defineCollection<
  TimelineDoc | (Omit<TimelineDoc, 'version'> & { version: 1 })
>({
  name: 'timelines',
  scope: 'owner',
  fs: { dir: 'timelines' },
});

/** How long a tombstone says what became of a timeline or media that went. */
export const GONE_TTL_MS = 30 * 86_400_000;

/** That a timeline expired, and when, so a later lookup can say so. */
export const TIMELINES_GONE = defineCollection<{ at: string }>({
  name: 'gone',
  kind: 'timeline',
  scope: 'owner',
  fs: { dir: 'timelines-gone' },
  db: { ttlMs: GONE_TTL_MS },
});

/** Immutable scores by id; a read counts as a use. */
export const SCORES = defineCollection<ScoreDoc>({
  name: 'scores',
  scope: 'owner',
  fs: { dir: 'scores' },
});

/** That a score expired, and when, so a later lookup can say so. */
export const SCORES_GONE = defineCollection<{ at: string }>({
  name: 'gone',
  kind: 'score',
  scope: 'owner',
  fs: { dir: 'scores-gone' },
  db: { ttlMs: GONE_TTL_MS },
});

/** What an output is: the one file a job made, or a set of frames kept for download. */
export interface OutputRecord {
  /** The job (`j_…`) or frame set (`f_…`) it belongs to. */
  id: string;
  kind: 'export' | 'timeline' | 'frames' | 'transcript';
  /** The name of the output's file, as its download link names it. */
  file: string;
  created_at: string;
}

/**
 * Which file each output is, so nothing has to list an output's files to find it. Outputs made
 * before these records have none; their file is the only one they hold.
 */
export const OUTPUTS = defineCollection<OutputRecord>({
  name: 'outputs',
  scope: 'owner',
  fs: { dir: 'outputs-index' },
  db: { indexes: [['kind']] },
});

/** The account's floor cursor: one record, id `floor`. */
export const FLOOR = defineCollection<{ cursor?: string }>({
  name: 'floor',
  scope: 'owner',
  fs: { dir: '' },
});
