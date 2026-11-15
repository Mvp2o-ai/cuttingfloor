import type { Job } from '@cuttingfloor/jobs';
import { KEEP_MS, span } from '@cuttingfloor/schema';

// The email that tells an account its files go soon. Once a day (lifecycle.ts), an account whose
// media or exports go in about three days, or within a day, gets one email naming them, with a
// fresh download link for each export. Each file falls in each window once, so it is named at
// most twice. An account turns these off on its account page (`expiry_emails: off` in its WorkOS
// metadata); every email says so and links there.

const DAY = 86_400_000;

/** A file going soon: its name, when it goes, and a download link for an export. */
export interface Going {
  name: string;
  at: number;
  /** An export's job, whose output gets a fresh download link. */
  jobId?: string;
  url?: string;
}

/** What one day's email names: files going within a day, and in about three days. */
export interface Due {
  soon: Going[];
  later: Going[];
}

/** The files in each window at `now`, or undefined when none are. */
export function dueFiles(files: Going[], now: number): Due | undefined {
  const left = (f: Going) => f.at - now;
  const soon = files.filter((f) => left(f) > 0 && left(f) <= DAY);
  const later = files.filter((f) => left(f) > 2 * DAY && left(f) <= 3 * DAY);
  return soon.length || later.length ? { soon, later } : undefined;
}

/** A finished export's file name and when it goes; undefined for any other job. */
export function exportOf(job: Job): Going | undefined {
  if (!job.tool.startsWith('export.') || job.status !== 'completed' || job.result?.isError)
    return undefined;
  const url = job.result?.structuredContent?.url;
  if (typeof url !== 'string') return undefined;
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  return name ? { name, at: Date.parse(job.lastUpdatedAt) + job.ttlMs, jobId: job.id } : undefined;
}

/** The email for one account's due files. */
export function expiryMessage(due: Due, accountUrl: string) {
  const list = (files: Going[]) =>
    files.map((f) => `• ${f.name}${f.url ? `: ${f.url}` : ''}`).join('\n');
  const count = due.soon.length + due.later.length;
  return {
    subject: due.soon.length
      ? `${count === 1 ? 'A file' : `${count} files`} on cuttingfloor ${count === 1 ? 'goes' : 'go'} soon`
      : `${count === 1 ? 'A file' : `${count} files`} on cuttingfloor ${count === 1 ? 'goes' : 'go'} in 3 days`,
    lines: [
      `cuttingfloor is a place to work, not storage: files go ${span(KEEP_MS.media)} after they were last used, and exports ${span(KEEP_MS.job)} after they finished.`,
      ...(due.soon.length ? [`Going within a day:\n${list(due.soon)}`] : []),
      ...(due.later.length ? [`Going in about 3 days:\n${list(due.later)}`] : []),
      `Download what you want to keep. Using a file in an edit keeps it another ${span(KEEP_MS.media)}.`,
      `You get these emails because file reminders are on. Turn them off on your account page: ${accountUrl}#notifications`,
    ],
  };
}
