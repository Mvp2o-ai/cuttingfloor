import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestEnv, testRuntime } from './helpers.ts';

// A media's analyses are files beside it. Two writers of one never leave half a file or undo
// each other: an analysis made now is not replaced by an old one being moved out of a record.

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

afterAll(() => env.runtime.stop());

describe('analyses beside a media', () => {
  it('a fresh analysis that lands while an old inline one is moved out stays', async () => {
    const { media, ws } = env.runtime;
    await writeFile(join(env.mediaDir, 'clip.mp4'), 'not really a video');
    const record = await media.create('racer', { path: join(env.mediaDir, 'clip.mp4') }, 'clip');
    record.status = 'ready';
    await media.save('racer', record);
    // A record from before analyses were files: the transcript is inside it.
    const file = join(media.dir('racer', record.media_id), 'media.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(
      file,
      JSON.stringify({ ...stored, analyses: { transcript: { text: 'old' }, beats: { bpm: 90 } } }),
    );
    // The old transcript is written and about to take its place when a new one is saved.
    const move = ws.blobs.move.bind(ws.blobs);
    let raced = false;
    const spy = vi.spyOn(ws.blobs, 'move').mockImplementation(async (from, to, options) => {
      if (options?.ifAbsent && to.endsWith('/transcript.json') && !raced) {
        raced = true;
        await media.saveAnalysis('racer', record.media_id, 'transcript', {
          text: 'fresh',
        } as never);
      }
      return move(from, to, options);
    });
    try {
      const found = await media.find('racer', record.media_id);
      expect(raced).toBe(true);
      expect(found?.analyses).toMatchObject({ transcript: { text: 'fresh' }, beats: { bpm: 90 } });
    } finally {
      spy.mockRestore();
    }
    const dir = join(media.dir('racer', record.media_id), 'analyses');
    expect(await readFile(join(dir, 'transcript.json'), 'utf8')).toBe('{\n  "text": "fresh"\n}\n');
    // Nothing half-written is left beside them, and the record no longer holds any.
    expect(
      (await ws.blobs.list(ws.blobs.keys.derived('racer', record.media_id, 'analyses'))).length,
    ).toBe(2);
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('analyses');
  });
});
