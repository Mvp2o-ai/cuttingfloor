import type { TimelineDoc } from '@cuttingfloor/schema';
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

/** That a timeline expired, and when, so a later lookup can say so. */
export const TIMELINES_GONE = defineCollection<{ at: string }>({
  name: 'gone',
  scope: 'owner',
  fs: { dir: 'timelines-gone' },
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
});

/** The account's floor cursor: one record, id `floor`. */
export const FLOOR = defineCollection<{ cursor?: string }>({
  name: 'floor',
  scope: 'owner',
  fs: { dir: '' },
});
