import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PublicFiles } from '@cuttingfloor/core';
import { CfError, COMMUNITY_PACK, SoundsListInput } from '@cuttingfloor/schema';
import { type Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoSoundLibrary, SOUNDS, SoundSharing } from '../src/index.ts';

// Sharing a sound in the community pack: a person's audio file becomes a library sound, listed
// newest and popular (by the accounts that used it this week), never showing who shared it; one
// file is shared once; non-audio is refused; enough reports hold it back; its owner takes it
// down. Real FFmpeg measures the file and real MongoDB keeps it (scripts/test-mongo.sh); CLAP and
// the public bucket are stood in for. Skips without either, unless CUTTINGFLOOR_REQUIRE_ENGINES
// or CUTTINGFLOOR_REQUIRE_MONGO says they must be there.

const exec = promisify(execFile);
const MONGO =
  process.env.CUTTINGFLOOR_TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/?directConnection=true';

const ffmpeg = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
if (!ffmpeg && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) throw new Error('FFmpeg is required');

async function mongo(): Promise<MongoClient | undefined> {
  const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 1500 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.close().catch(() => undefined);
    if (process.env.CUTTINGFLOOR_REQUIRE_MONGO) throw new Error('MongoDB is required');
    return undefined;
  }
}
const client = ffmpeg ? await mongo() : undefined;

/** A bucket that is a folder. */
function folderFiles(dir: string): PublicFiles & { has(key: string): Promise<boolean> } {
  return {
    url: (key) => `https://sounds.example/${key}`,
    put: async (key, file) => {
      await mkdir(join(dir, key, '..'), { recursive: true });
      await copyFile(file, join(dir, key));
      return `https://sounds.example/${key}`;
    },
    delete: (key) => rm(join(dir, key), { force: true }),
    has: (key) =>
      stat(join(dir, key)).then(
        () => true,
        () => false,
      ),
  };
}

const tone = async (file: string, hz: number, seconds = 1) => {
  await exec('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:duration=${seconds}`,
    '-y',
    file,
  ]);
  return file;
};

const details = (name: string) => ({
  name,
  description: `${name}, made for testing`,
  tags: ['Test', 'tone', 'test'],
  category: 'Trending sounds',
});

const signal = new AbortController().signal;

describe.skipIf(!client)('community sounds', { timeout: 60_000 }, () => {
  let db: Db;
  let dir: string;
  let files: ReturnType<typeof folderFiles>;
  let sharing: SoundSharing;
  let library: MongoSoundLibrary;
  const list = (args: Record<string, unknown>) =>
    library.list(SoundsListInput.parse({ pack: COMMUNITY_PACK, ...args }), signal);

  beforeAll(async () => {
    db = (client as MongoClient).db(`cf_share_${Date.now().toString(36)}`);
    dir = await mkdtemp(join(tmpdir(), 'cf-share-'));
    files = folderFiles(join(dir, 'bucket'));
    const embed = async () => [1, 0, 0];
    sharing = new SoundSharing({ db: async () => db, files, embed, model: 'stand-in' });
    sharing.author = async (owner) => (owner === 'user_a' ? 'Ada L.' : null);
    library = new MongoSoundLibrary({
      db: async () => db,
      embed: async (t) => t.map(() => [1, 0, 0]),
      model: 'stand-in',
    });
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('shares an audio file as a library sound, credited and measured, never showing its owner', async () => {
    const shared = await sharing.share(
      'user_a',
      await tone(join(dir, 'a.wav'), 440),
      details('Beep'),
      signal,
    );
    expect(shared).toMatchObject({
      pack: COMMUNITY_PACK,
      name: 'Beep',
      category: 'Trending sounds',
      tags: ['test', 'tone'],
      author: 'Ada L.',
      licence: 'Shared by its uploader',
      channels: 1,
    });
    expect(shared.seconds).toBeCloseTo(1, 1);
    expect(shared.peak_dbtp).not.toBeNull();
    expect(shared.url).toMatch(/^https:\/\/sounds\.example\/community\/[a-z2-7]{16}\.wav$/);
    const page = await list({ order: 'newest' });
    expect(page.sounds.map((s) => s.sound_id)).toEqual([shared.sound_id]);
    expect(JSON.stringify(page)).not.toContain('user_a');
    // The same file again is the same sound; another credit is kept as given.
    const again = await sharing.share('user_a', join(dir, 'a.wav'), details('Beep twice'), signal);
    expect(again.sound_id).toBe(shared.sound_id);
    const other = await sharing.share(
      'user_b',
      await tone(join(dir, 'b.mp3'), 880),
      { ...details('Boop'), author: 'DJ B' },
      signal,
    );
    expect(other.author).toBe('DJ B');
    expect(other.url).toMatch(/\.mp3$/);
  });

  it('refuses what is not a sound', async () => {
    const text = join(dir, 'notes.txt');
    await writeFile(text, 'not a sound at all');
    const refused = await sharing.share('user_a', text, details('Notes'), signal).catch((e) => e);
    expect(refused).toBeInstanceOf(CfError);
    expect((refused as CfError).message).toMatch(/Only audio files/);
  });

  it('orders by the accounts that used each sound this week', async () => {
    const [boop] = (await list({ order: 'newest' })).sounds;
    expect(boop?.name).toBe('Boop');
    const beep = (await list({ order: 'newest' })).sounds.find((s) => s.name === 'Beep');
    // Beep used by two accounts (one of them twice in a day: once), Boop by none.
    await sharing.used('user_c', beep?.url ?? '');
    await sharing.used('user_c', beep?.url ?? '');
    await sharing.used('user_d', beep?.url ?? '');
    await sharing.used('user_d', 'https://elsewhere.example/x.wav');
    // A fresh library: the counts are cached for minutes.
    library = new MongoSoundLibrary({
      db: async () => db,
      embed: async (t) => t.map(() => [1, 0, 0]),
      model: 'stand-in',
    });
    const popular = await list({ order: 'popular' });
    expect(popular.sounds.map((s) => [s.name, s.uses])).toEqual([
      ['Beep', 2],
      ['Boop', 0],
    ]);
    expect((await list({ order: 'popular', offset: 1, limit: 1 })).sounds[0]?.name).toBe('Boop');
  });

  it('holds a sound back once three people report it', async () => {
    const boop = (await list({ order: 'newest' })).sounds.find((s) => s.name === 'Boop');
    const id = boop?.sound_id ?? '';
    expect(await sharing.report(id, 'ip_1', 'not theirs')).toEqual({ reported: true, held: false });
    expect(await sharing.report(id, 'ip_1', 'again')).toEqual({ reported: true, held: false });
    expect(await sharing.report(id, 'ip_2', 'not theirs')).toEqual({ reported: true, held: false });
    expect(await sharing.report(id, 'ip_3', 'not theirs')).toEqual({ reported: true, held: true });
    expect((await list({ order: 'newest' })).sounds.map((s) => s.name)).toEqual(['Beep']);
    expect(await sharing.report('cuttingfloor-airhorn', 'ip_1', 'x')).toEqual({
      reported: false,
      held: false,
    });
    // Its owner still takes it down, file and all.
    expect(await sharing.unshare('user_b', id)).toBe(true);
  });

  it('is taken down by its owner only', async () => {
    const [beep] = await sharing.mine('user_a');
    expect(beep?.name).toBe('Beep');
    const key = new URL(beep?.url ?? '').pathname.slice(1);
    expect(await files.has(key)).toBe(true);
    expect(await sharing.unshare('user_b', beep?.sound_id ?? '')).toBe(false);
    expect(await sharing.unshare('user_a', beep?.sound_id ?? '')).toBe(true);
    expect(await files.has(key)).toBe(false);
    expect(await db.collection(SOUNDS).countDocuments()).toBe(0);
    expect(await sharing.mine('user_a')).toEqual([]);
  });
});
