import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '@cuttingfloor/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDownloads, recordDownload } from '../src/downloads.ts';

// A day's record names the client of the day's earliest request, whichever request's write
// lands first: writes are not awaited by the request, so a later one can overtake.

afterEach(() => vi.useRealTimers());

describe('download records', () => {
  it('names the earliest request the first client, even when a later one wrote first', async () => {
    const ws = new Workspace(await mkdtemp(join(tmpdir(), 'cf-downloads-')));
    const seen = { owner: 'o', file_id: 'j_x', name: 'short.mp4', range: undefined };
    vi.useFakeTimers({ toFake: ['Date'] });
    // The later request (ChatGPT, 12:00:05) lands first...
    vi.setSystemTime(new Date('2026-11-23T12:00:05Z'));
    await recordDownload(ws, { ...seen, how: 'download', userAgent: 'openai-mcp/1.0' });
    // ...then the browser's page view from 12:00:01 lands.
    vi.setSystemTime(new Date('2026-11-23T12:00:01Z'));
    await recordDownload(ws, { ...seen, how: 'page', userAgent: 'Mozilla/5.0' });
    expect((await readDownloads(ws, 'o'))[0]).toMatchObject({
      agent: 'Mozilla',
      first_at: '2026-11-23T12:00:01.000Z',
      downloads: 1,
      page_views: 1,
    });
  });
});
