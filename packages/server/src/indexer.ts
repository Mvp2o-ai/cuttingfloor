import {
  buildPictureIndex,
  INDEX_VERSION,
  type MediaLibrary,
  type MediaRecord,
  mayBeTransparent,
  type PictureIndex,
  readPictureIndex,
} from '@cuttingfloor/engine';
import { PICTURE, pictureSize } from './tools/judge.ts';

// media.search's picture index, built after a media is ready: question-agnostic, on the CPU, not
// metered, one media at a time on this server. Nothing about it lives only in memory but the
// queue: a restart drops the queue, and the next search that meets a media with no index queues
// it again.

export type IndexStatus =
  | { state: 'indexed'; index: PictureIndex }
  | { state: 'indexing' }
  | { state: 'failed'; message: string }
  | { state: 'no_picture' };

/** Whether media has a picture media.search indexes: a video's, or an image's. */
export function indexable(record: MediaRecord): boolean {
  const p = record.probe;
  return Boolean(p?.video) && (p?.kind === 'video' || p?.kind === 'image');
}

export class SearchIndexer {
  readonly #media: MediaLibrary;
  readonly #queue: Array<{ owner: string; id: string }> = [];
  readonly #waiting = new Set<string>();
  #running = false;

  constructor(media: MediaLibrary) {
    this.#media = media;
  }

  /** Where the media's index stands; queues it when it has none yet. */
  async status(owner: string, record: MediaRecord): Promise<IndexStatus> {
    if (!indexable(record)) return { state: 'no_picture' };
    const dir = await this.#media.derivedDir(owner, record.media_id, 'search');
    const index = await readPictureIndex(dir);
    if (index) return { state: 'indexed', index };
    const failed = await this.#media
      .readDerived(owner, record.media_id, 'search', 'failed.json')
      .then((t) =>
        t === undefined ? null : (JSON.parse(t) as { version: number; message: string }),
      )
      .catch(() => null);
    if (failed?.version === INDEX_VERSION) return { state: 'failed', message: failed.message };
    this.enqueue(owner, record.media_id);
    return { state: 'indexing' };
  }

  /** Queues a media to index, unless it is queued already; never throws. */
  enqueue(owner: string, id: string): void {
    const key = `${owner}/${id}`;
    if (this.#waiting.has(key)) return;
    this.#waiting.add(key);
    this.#queue.push({ owner, id });
    void this.#drain();
  }

  /** Resolves once nothing is queued or being indexed (tests measure storage after it). */
  async idle(): Promise<void> {
    while (this.#running || this.#queue.length) await new Promise((r) => setTimeout(r, 50));
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let next = this.#queue.shift(); next; next = this.#queue.shift()) {
        const { owner, id } = next;
        // The media's copy on this node stays while it is indexed, however long that takes.
        await this.#media
          .hold(() => this.#build(owner, id))
          .catch((error: Error) => process.stderr.write(`index: ${next?.id}: ${error.message}\n`));
        this.#waiting.delete(`${next.owner}/${next.id}`);
      }
    } finally {
      this.#running = false;
    }
  }

  async #build(owner: string, id: string): Promise<void> {
    const record = await this.#media.find(owner, id);
    if (record?.status !== 'ready' || !indexable(record)) return;
    const dir = await this.#media.derivedDir(owner, id, 'search');
    if (await readPictureIndex(dir)) return;
    const p = record.probe;
    const kind = p?.kind === 'image' ? 'image' : 'video';
    try {
      await buildPictureIndex({
        file:
          kind === 'video'
            ? record.proxy
              ? await this.#media.local(record.proxy)
              : await this.#media.sourceFile(record, 'export')
            : await this.#media.sourceFile(record, 'export'),
        kind,
        size: pictureSize(record),
        duration: p?.duration ?? null,
        picture: PICTURE,
        checker: mayBeTransparent(p),
        out: dir,
        signal: AbortSignal.timeout(60 * 60_000),
      });
      // A media deleted while it was indexed: the index made its folder again, and would hold
      // the account's storage until swept.
      if (!(await this.#media.find(owner, id))) {
        await this.#media.discard(owner, id);
        return;
      }
      // Where files are not on this server, the index is stored for the others to read.
      await this.#media.keepDerived(owner, id, ['search']);
      await this.#media.deleteDerived(owner, id, 'search', 'failed.json');
    } catch (error) {
      // A media deleted while it was indexed has no folder left to say so in.
      if (!(await this.#media.find(owner, id))) return;
      await this.#media.writeDerived(
        owner,
        id,
        JSON.stringify({ version: INDEX_VERSION, message: (error as Error).message }),
        'search',
        'failed.json',
      );
      throw error;
    }
  }
}
