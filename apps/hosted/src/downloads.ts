import type { Workspace } from '@cuttingfloor/core';
import { DOWNLOADS, type DownloadDay } from '@cuttingfloor/server';
import { agentName } from './funnel.ts';

// What leaves the server through a signed link: one record per owner, file and UTC day
// (`owners/{owner}/downloads/{file_id}.{day}.json`), counting saves, plays and watch pages. A
// player asks for a file in many ranges; only a request from the start counts, so a play is one.
// The baseline for the download gate: which exports people take away, and from where.

export type DownloadHow = 'download' | 'play' | 'page';

export interface DownloadSeen {
  /** The owner key from the signed path. */
  owner: string;
  file_id: string;
  name: string;
  how: DownloadHow;
  userAgent: string;
  /** The request's Range header, if any: a later range of a fetch already counted is skipped. */
  range?: string | undefined;
  /** Where the link was used from, when it says (`via=view`: a chat view's Download button). */
  via?: string | undefined;
}

const FIELD = { download: 'downloads', play: 'plays', page: 'page_views' } as const;

/** Whether a request is the start of a fetch, not a later range of one. */
export function startsFetch(range: string | undefined): boolean {
  return !range || /^bytes=0-/.test(range.trim());
}

export async function recordDownload(ws: Workspace, seen: DownloadSeen): Promise<void> {
  if (!startsFetch(seen.range)) return;
  const at = new Date().toISOString();
  const day = at.slice(0, 10);
  const field = FIELD[seen.how];
  const days = ws.records.collection(DOWNLOADS, { owner: seen.owner });
  const id = `${seen.file_id}.${day}`;
  const first: DownloadDay = {
    file_id: seen.file_id,
    name: seen.name,
    day,
    first_at: at,
    last_at: at,
    downloads: 0,
    plays: 0,
    page_views: 0,
    agent: agentName(seen.userAgent),
  };
  first[field] = 1;
  const viewSave = seen.how === 'download' && seen.via === 'view';
  if (viewSave) first.from_view = 1;
  // Whichever request's write lands first makes the record; the others add to it (one that went
  // between the two, by expiring, is written again).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await days.insertOnce(id, first)) return;
    const now = await days.update(id, {
      set: { last_at: at },
      inc: { [field]: 1, ...(viewSave ? { from_view: 1 } : {}) },
    });
    if (!now) continue;
    // Writes land in any order, so the earliest request names the day's first client, not the
    // first write: a later request whose write won the race gives way.
    let known = now;
    while (at < known.first_at) {
      if (
        await days.compareAndSet(
          id,
          { first_at: known.first_at },
          { first_at: at, agent: first.agent },
        )
      )
        break;
      const again = await days.get(id);
      if (!again) break;
      known = again;
    }
    return;
  }
}

/** An owner's download days, newest first. */
export async function readDownloads(ws: Workspace, owner: string): Promise<DownloadDay[]> {
  const found = await ws.records.collection(DOWNLOADS, { owner }).find();
  return found
    .map((e) => e.value)
    .sort((a, b) => b.day.localeCompare(a.day) || b.last_at.localeCompare(a.last_at));
}
