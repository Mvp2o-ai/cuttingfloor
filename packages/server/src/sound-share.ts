import { stat } from 'node:fs/promises';
import { type PublicFiles, randomId } from '@cuttingfloor/core';
import { fingerprint, probe, soundLevels } from '@cuttingfloor/engine';
import {
  CfError,
  COMMUNITY_PACK,
  type LibrarySound,
  SHARED_SOUND_BYTES,
  SHARED_SOUND_SECONDS,
  type SoundShareInput,
} from '@cuttingfloor/schema';
import type { Collection, Db } from 'mongodb';
import {
  librarySound,
  SOUND_PACKS,
  SOUND_USES,
  SOUNDS,
  type SoundDoc,
  type SoundPackDoc,
  type SoundUseDoc,
} from './sound-library.ts';

// The community pack: sounds people share from their own uploads (their own recordings, beats,
// voice lines, their own effects) into the sound library, where sounds.list and the community
// sounds page find them like any other. Each is the file as it was sent, in the public sounds
// bucket, with its length, channels, levels and CLAP embedding, and the account that shared it
// (never shown). Sharing is a person's choice, made in the upload box or on the site, never an
// agent's.
//
// Its uploader vouches for it, not cuttingfloor: its owner can take it down at any time, and a
// sound reported by REPORTS_TO_HOLD people is held out of the library until it is looked at.
//
// Uses: an import of a library sound's url counts once per account per day, and `popular`
// orders the library by the accounts that used each sound over the last POPULAR_DAYS days.

export const SOUND_REPORTS = 'sound_reports';
/** Sounds held out of the library after reports, as they were. */
export const SOUNDS_HELD = 'sounds_held';

/** The licence a shared sound carries. */
export const SHARED_LICENCE = 'Shared by its uploader';

/** The community sounds page: where people find, play and share them. */
export const COMMUNITY_SOUNDS_PAGE = 'https://cuttingfloor.ai/community-sounds';

/** People who report a sound before it is held out of the library. */
export const REPORTS_TO_HOLD = 3;

/** Sounds one account shares in a day: the server's protection, not a policy. */
export const SHARES_PER_DAY = 30;

/** How long a use is kept: past the popular window, so a change of window has the data. */
const USES_KEPT_DAYS = 30;

/** Files the community pack takes, by the extension their format has, with their type. */
const TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

export interface SoundReportDoc {
  sound_id: string;
  /** Who reported it: an account, or a hash of where an anonymous report came from. */
  reporter: string;
  reason: string;
  at: Date;
}

export interface SoundSharingOptions {
  db: () => Promise<Db>;
  /** The public sounds bucket. */
  files: PublicFiles;
  /** CLAP audio embedding of a file, in the space the library's sounds are in. */
  embed: (file: string, signal: AbortSignal) => Promise<number[]>;
  /** The model `embed` is. */
  model: string;
}

export class SoundSharing {
  readonly #o: SoundSharingOptions;
  /** The name a sound is credited to when its sharer gives none (hosted: their first name). */
  author: ((owner: string) => Promise<string | null>) | undefined;
  #prepared: Promise<void> | undefined;

  constructor(options: SoundSharingOptions) {
    this.#o = options;
  }

  async #db(): Promise<Db> {
    const db = await this.#o.db();
    this.#prepared ??= prepareCommunity(db).catch((error) => {
      this.#prepared = undefined;
      throw error;
    });
    await this.#prepared;
    return db;
  }

  async #sounds(): Promise<Collection<SoundDoc>> {
    return (await this.#db()).collection<SoundDoc>(SOUNDS);
  }

  /**
   * Shares `file` (a local copy of the owner's upload or media) in the community pack and answers
   * it as the library shows it. The same file shared again answers the sound it already is.
   */
  async share(
    owner: string,
    file: string,
    meta: SoundShareInput,
    signal: AbortSignal,
  ): Promise<LibrarySound> {
    const sounds = await this.#sounds();
    const bytes = (await stat(file)).size;
    if (bytes > SHARED_SOUND_BYTES) {
      throw new CfError(
        'bad_request',
        `This file is ${(bytes / 1024 ** 2).toFixed(1)} MB; a shared sound is up to ${SHARED_SOUND_BYTES / 1024 ** 2} MB`,
        { hint: 'Trim it to the part people will use, or send it as MP3' },
      );
    }
    const probed = await probe(file, signal).catch(() => undefined);
    const type = probed?.extension ? TYPES[probed.extension] : undefined;
    if (probed?.kind !== 'audio' || !probed.audio || !type) {
      throw new CfError('bad_request', 'Only audio files can be shared as sounds', {
        hint: 'Share an MP3, WAV, M4A, FLAC or OGG file',
      });
    }
    const seconds = Math.round((probed.duration ?? 0) * 100) / 100;
    if (seconds <= 0) throw new CfError('bad_request', 'This file holds no sound');
    if (seconds > SHARED_SOUND_SECONDS) {
      throw new CfError(
        'bad_request',
        `This sound is ${Math.round(seconds)} s long; a shared sound is up to ${SHARED_SOUND_SECONDS / 60} minutes`,
        { hint: 'Trim it to the part people will use' },
      );
    }
    const print = await fingerprint(file);
    const same = await sounds.findOne({ fingerprint: print }, { projection: SHOWN });
    if (same) return librarySound(same);
    const today = await sounds.countDocuments({
      owner,
      added_at: { $gte: new Date(Date.now() - 86_400_000) },
    });
    if (today >= SHARES_PER_DAY) {
      throw new CfError('limit_exceeded', `${SHARES_PER_DAY} sounds a day can be shared`, {
        hint: 'Share more tomorrow',
      });
    }
    const levels = await soundLevels(file, { seconds: SHARED_SOUND_SECONDS, signal });
    if (levels.peak_dbtp === null) throw new CfError('bad_request', 'This file holds no sound');
    const embedding = await this.#o.embed(file, signal);
    const author =
      meta.author ?? (await this.author?.(owner).catch(() => null)) ?? 'A cuttingfloor creator';
    const id = randomId('').slice(0, 16);
    const key = `${COMMUNITY_PACK}/${id}${probed.extension}`;
    const url = await this.#o.files.put(key, file, type);
    const doc: SoundDoc = {
      _id: `${COMMUNITY_PACK}-${id}`,
      name: meta.name,
      description: meta.description,
      tags: [...new Set(meta.tags.map((t) => t.toLowerCase()))],
      category: meta.category,
      pack: COMMUNITY_PACK,
      seconds,
      channels: probed.audio.channels,
      loudness_lufs: levels.loudness_lufs,
      peak_dbtp: levels.peak_dbtp,
      url,
      licence: SHARED_LICENCE,
      author,
      source_url: null,
      key,
      bytes,
      embedding,
      embedding_model: this.#o.model,
      added_at: new Date(),
      owner,
      fingerprint: print,
    };
    await sounds.insertOne(doc);
    return librarySound(doc);
  }

  /** The sounds the owner shared, newest first. */
  async mine(owner: string): Promise<LibrarySound[]> {
    const sounds = await this.#sounds();
    const docs = await sounds
      .find({ owner }, { projection: SHOWN })
      .sort({ added_at: -1, _id: 1 })
      .limit(500)
      .toArray();
    return docs.map(librarySound);
  }

  /** Takes the owner's sound out of the library and its file out of the bucket. */
  async unshare(owner: string, soundId: string): Promise<boolean> {
    const db = await this.#db();
    const doc =
      (await db.collection<SoundDoc>(SOUNDS).findOneAndDelete({ _id: soundId, owner })) ??
      (await db.collection<SoundDoc>(SOUNDS_HELD).findOneAndDelete({ _id: soundId, owner }));
    if (!doc) return false;
    await this.#o.files.delete(doc.key).catch((error) => {
      process.stderr.write(`sounds: ${soundId}: file not deleted: ${(error as Error).message}\n`);
    });
    await db.collection<SoundUseDoc>(SOUND_USES).deleteMany({ sound_id: soundId });
    return true;
  }

  /**
   * A report that a sound is not the sharer's to share, or is abusive. One per reporter; at
   * REPORTS_TO_HOLD reporters a community sound is held out of the library.
   */
  async report(
    soundId: string,
    reporter: string,
    reason: string,
  ): Promise<{ reported: boolean; held: boolean }> {
    const db = await this.#db();
    const sounds = db.collection<SoundDoc>(SOUNDS);
    const doc = await sounds.findOne({ _id: soundId, pack: COMMUNITY_PACK });
    if (!doc) return { reported: false, held: false };
    const reports = db.collection<SoundReportDoc>(SOUND_REPORTS);
    await reports.updateOne(
      { sound_id: soundId, reporter },
      { $setOnInsert: { reason: reason.slice(0, 1000), at: new Date() } },
      { upsert: true },
    );
    const count = await reports.countDocuments({ sound_id: soundId });
    process.stderr.write(`sounds: ${soundId} reported (${count}): ${reason.slice(0, 200)}\n`);
    if (count < REPORTS_TO_HOLD) return { reported: true, held: false };
    await db.collection<SoundDoc>(SOUNDS_HELD).replaceOne({ _id: soundId }, doc, { upsert: true });
    await sounds.deleteOne({ _id: soundId });
    process.stderr.write(`sounds: ${soundId} held out of the library after ${count} reports\n`);
    return { reported: true, held: true };
  }

  /** Counts an import of `url` as a use of the library sound at it, if one is. */
  async used(owner: string, url: string): Promise<void> {
    const db = await this.#db();
    const doc = await db.collection<SoundDoc>(SOUNDS).findOne({ url }, { projection: { _id: 1 } });
    if (!doc) return;
    const now = new Date();
    await db
      .collection<SoundUseDoc>(SOUND_USES)
      .updateOne(
        { sound_id: doc._id, owner, day: now.toISOString().slice(0, 10) },
        { $setOnInsert: { at: now } },
        { upsert: true },
      );
  }
}

/** Fields a shared sound shows; the embedding and who shared it stay in the database. */
const SHOWN = { embedding: 0, embedding_model: 0, owner: 0, fingerprint: 0 } as const;

/** The indexes the community pack needs, and its pack record. */
export async function prepareCommunity(db: Db): Promise<void> {
  const sounds = db.collection<SoundDoc>(SOUNDS);
  await sounds.createIndex({ url: 1 });
  await sounds.createIndex({ owner: 1, added_at: -1 }, { sparse: true });
  await sounds.createIndex({ fingerprint: 1 }, { sparse: true });
  const uses = db.collection<SoundUseDoc>(SOUND_USES);
  await uses.createIndex({ sound_id: 1, owner: 1, day: 1 }, { unique: true });
  await uses.createIndex({ at: 1 }, { expireAfterSeconds: USES_KEPT_DAYS * 86_400 });
  await db
    .collection<SoundReportDoc>(SOUND_REPORTS)
    .createIndex({ sound_id: 1, reporter: 1 }, { unique: true });
  await db.collection<SoundPackDoc>(SOUND_PACKS).updateOne(
    { _id: COMMUNITY_PACK },
    {
      $set: { licence: SHARED_LICENCE, source_url: COMMUNITY_SOUNDS_PAGE },
      $setOnInsert: { added_at: new Date() },
    },
    { upsert: true },
  );
}
