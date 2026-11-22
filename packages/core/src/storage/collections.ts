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

/** The account's floor cursor: one record, id `floor`. */
export const FLOOR = defineCollection<{ cursor?: string }>({
  name: 'floor',
  scope: 'owner',
  fs: { dir: '' },
});
