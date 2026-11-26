import { type BlobKey, defineCollection, floorChanged, OUTPUTS } from '@cuttingfloor/core';
import { burnMark, type MediaRecord } from '@cuttingfloor/engine';

export { REVIEW_CARDS } from '@cuttingfloor/engine';

import { cleanCopyCredits, cleanCopyMinutes, GATE_FROM } from '@cuttingfloor/plans';
import { CfError } from '@cuttingfloor/schema';
import type { Runtime } from './runtime.ts';

// The download gate (hosted): every picture that leaves through a signed link (an export's file,
// a created or exported media's file, full-size frames) has a cuttingfloor watermark until its
// owner removes it, once, for cleanCopyCredits of its finished length. The mark is
// burned in at the door, never in the timeline: the server keeps working from the clean file,
// and the watermarked copy is made the first time it is asked for, then kept beside it. Audio, text
// and project files, uploads and URL imports, files made before GATE_FROM and accounts on a
// given plan never carry it. A watermarked video also opens on a card saying it is a review copy
// and ends on one saying how to get the clean copy (REVIEW_CARDS). Locally there is no gate.

/** A release: one per export (or created media, or frame set), id the thing released. */
export interface Release {
  id: string;
  released_at: string;
  credits: number;
  /** Finished minutes it was priced at (cleanCopyMinutes). */
  minutes: number;
  via: ReleaseVia;
}

export type ReleaseVia = 'tool' | 'rest' | 'page';

export const RELEASES = defineCollection<Release>({
  name: 'export_releases',
  scope: 'owner',
  fs: { dir: 'releases' },
});

/** What the hosting app answers for the gate: plans and credits live there. */
export interface GateHooks {
  /** True for an account on a given plan (staff, lifetime, enterprise): never marked. */
  exempt(owner: string): Promise<boolean>;
  /** Credits left, or null for no cap. */
  balance(owner: string): Promise<number | null>;
  /** Spends credits once under `ref` however often it is sent; the balance after. */
  spend(
    owner: string,
    ref: string,
    credits: number,
    tool: string,
  ): Promise<{ balance: number | null }>;
  /** Burns the mark into a local file; the engine's burnMark unless a test stands in. */
  mark?: (input: string, output: string, seed: string, qr?: string) => Promise<void>;
  /**
   * The page where the owner signs in and releases a file, by its id: what the QR code on a
   * review copy's cards opens. Without it the cards carry no code.
   */
  releasePage?: (id: string) => string;
}

/** Whether a file has the watermark now, and what removing the watermark costs. */
export interface MarkState {
  watermarked: boolean;
  release_credits?: number;
}

/** A gated file: what releases it and what it costs. */
interface Gated {
  /** The id a release is kept under: an export's or create.* job's id, else the file's own. */
  releaseId: string;
  credits: number;
  minutes: number;
  createdAt: string;
}

const PICTURE = /^(?:video|image)\//;
const MARKED_PREFIX = 'cf-marked--';
/** Marked copies made with the opening and end cards; older ones (without) are made again. */
const CARDS_VERSION = 'cards4--';

export class DownloadGate {
  readonly #rt: Runtime;
  readonly #hooks: GateHooks;
  /** Marked copies being made on this server, by blob key: concurrent downloads share one. */
  readonly #making = new Map<string, Promise<BlobKey>>();

  /** Files made before this are never watermarked. */
  readonly #from: number;

  constructor(rt: Runtime, hooks: GateHooks, options: { from?: string } = {}) {
    this.#rt = rt;
    this.#hooks = hooks;
    this.#from = Date.parse(options.from ?? GATE_FROM);
  }

  /**
   * What gates a signed file (`j_…`, `f_…` or `m_…`): undefined for one that never carries the
   * mark (audio, text, an upload or URL import, made before the gate).
   */
  async #gated(owner: string, id: string): Promise<Gated | undefined> {
    const rt = this.#rt;
    if (id.startsWith('m_')) {
      const record = await rt.media.find(owner, id);
      return record ? this.#gatedMedia(record) : undefined;
    }
    const output = await rt.ws.records.collection(OUTPUTS, { owner }).get(id);
    if (id.startsWith('f_')) {
      if (output?.kind !== 'frames' || !this.#after(output.created_at)) return undefined;
      return {
        releaseId: id,
        credits: cleanCopyCredits(null),
        minutes: 0,
        createdAt: output.created_at,
      };
    }
    if (!id.startsWith('j_')) return undefined;
    const job = await rt.jobs.store.get(id, owner);
    const result = job?.result?.structuredContent as
      | { mime_type?: string; duration_seconds?: number; media_id?: string }
      | undefined;
    if (output?.kind === 'export') {
      if (!job || !PICTURE.test(result?.mime_type ?? '') || !this.#after(output.created_at))
        return undefined;
      return priced(id, result?.mime_type ?? '', result?.duration_seconds, output.created_at);
    }
    // A create.* job: its file is the media it made.
    if (result?.media_id) {
      const record = await rt.media.find(owner, result.media_id);
      return record ? this.#gatedMedia(record) : undefined;
    }
    return undefined;
  }

  /** Whether the owner's plan is given; when that can't be told just now, it is not. */
  async #exempt(owner: string): Promise<boolean> {
    return this.#hooks.exempt(owner).catch(() => false);
  }

  async #released(owner: string, releaseId: string): Promise<Release | undefined> {
    return this.#rt.ws.records.collection(RELEASES, { owner }).get(releaseId);
  }

  /** Whether the file behind a signed link has the watermark now, and what removing it costs. */
  async state(owner: string, id: string): Promise<MarkState> {
    const gated = await this.#gated(owner, id);
    if (!gated || (await this.#exempt(owner))) return { watermarked: false };
    if (await this.#released(owner, gated.releaseId)) return { watermarked: false };
    return { watermarked: true, release_credits: gated.credits };
  }

  /** Credits the owner has now (null: no cap), or undefined when that can't be told just now. */
  async credits(owner: string): Promise<number | null | undefined> {
    return this.#hooks.balance(owner).catch(() => undefined);
  }

  /**
   * A file's state for the one result that answers for it (an export, media.get): while it is
   * watermarked, also the owner's credits and the same in words, so the agent can offer the
   * removal. `readCredits` is read once per result and shared by every file in it.
   */
  async described(
    owner: string,
    id: string,
    readCredits?: () => Promise<number | null | undefined>,
    url?: string,
  ): Promise<
    MarkState & { final_url?: string; credits_left?: number | null; watermark_note?: string }
  > {
    const state = await this.state(owner, id);
    if (!state.watermarked || state.release_credits === undefined) return state;
    const left = await (readCredits ?? (() => this.credits(owner)))();
    const final = url ? finalLink(url) : undefined;
    return {
      ...state,
      ...(final ? { final_url: final } : {}),
      ...(left !== undefined ? { credits_left: left } : {}),
      watermark_note: watermarkNote(state.release_credits, left, Boolean(final)),
    };
  }

  /**
   * The blob a signed link serves: the file itself, or its watermarked copy (made now if this is its
   * first download). `marked` says which, so a redirect to the watermarked copy isn't cached past a
   * release.
   */
  async serve(
    owner: string,
    id: string,
    name: string,
    source: { blob?: BlobKey; file?: string },
  ): Promise<{ blob?: BlobKey; file?: string; marked: boolean }> {
    const state = await this.state(owner, id);
    if (!state.watermarked) return { ...source, marked: false };
    const key = this.#rt.outputs.key(owner, id, `${MARKED_PREFIX}${CARDS_VERSION}${name}`);
    if (await this.#rt.ws.blobs.head(key)) return { blob: key, marked: true };
    let making = this.#making.get(key);
    if (!making) {
      making = this.#markCopy(key, source, `${owner}/${id}`, id).finally(() =>
        this.#making.delete(key),
      );
      this.#making.set(key, making);
    }
    return { blob: await making, marked: true };
  }

  async #markCopy(
    key: BlobKey,
    source: { blob?: BlobKey; file?: string },
    seed: string,
    id: string,
  ): Promise<BlobKey> {
    const { scratch } = this.#rt.ws;
    const qr = refOf(id) ? this.#hooks.releasePage?.(id) : undefined;
    return scratch.hold(async () => {
      const input = source.file ?? (source.blob ? await scratch.materialize(source.blob) : '');
      if (!input) throw new CfError('not_found', 'The file has gone');
      const out = await scratch.reserve(key);
      await (
        this.#hooks.mark ??
        ((i, o, s, q) => burnMark(i, o, { seed: s, cards: true, ...(q ? { qr: q } : {}) }))
      )(input, out, seed, qr);
      return scratch.publish(out, key);
    });
  }

  /**
   * Removes the watermark from an export (by its job id) or of a media made by an export or a
   * create.* job: spends its price once, then every link to it serves the clean file. A file that
   * never had the watermark, or one already released, costs nothing.
   */
  async release(
    owner: string,
    ref: { job_id?: string | undefined; media_id?: string | undefined },
    via: ReleaseVia,
  ): Promise<{
    /** The export or create.* job released; null for a media no job made (a still). */
    job_id: string | null;
    credits: number;
    price: number;
    balance: number | null;
    released_at: string;
    /** The signed file to hand back links for. */
    file: { id: string; name: string };
  }> {
    const rt = this.#rt;
    const file = await this.#file(owner, ref);
    const gated = await this.#gated(owner, file.id);
    const price = gated?.credits ?? 0;
    const jobId = gated?.releaseId.startsWith('j_') ? gated.releaseId : (ref.job_id ?? null);
    const now = new Date().toISOString();
    const free = async () => ({
      job_id: jobId,
      credits: 0,
      price,
      balance: await this.#hooks.balance(owner),
      released_at: now,
      file,
    });
    if (!gated || (await this.#hooks.exempt(owner))) return free();
    const known = await this.#released(owner, gated.releaseId);
    if (known) return { ...(await free()), released_at: known.released_at };
    const left = await this.#hooks.balance(owner);
    if (left !== null && left < price) {
      throw new CfError(
        'quota_exceeded',
        `Removing the watermark from this file uses ${credits(price)}; this account has ${credits(left)}`,
        {
          hint: 'The file still downloads with the cuttingfloor watermark, and editing and exports keep working. Tell the user the watermark can be removed once their account has the credits',
          detail: { price, credits_left: left },
        },
      );
    }
    const spent = await this.#hooks.spend(
      owner,
      `${gated.releaseId}-release`,
      price,
      'export.release',
    );
    const record: Release = {
      id: gated.releaseId,
      released_at: now,
      credits: price,
      minutes: gated.minutes,
      via,
    };
    const releases = rt.ws.records.collection(RELEASES, { owner });
    // Of releases at the same moment one record stands; the ledger spent once under its ref.
    if (!(await releases.insertOnce(gated.releaseId, record))) {
      const first = await releases.get(gated.releaseId);
      if (first) record.released_at = first.released_at;
    }
    await floorChanged(rt.ws, owner);
    return {
      job_id: jobId,
      credits: price,
      price,
      balance: spent.balance,
      released_at: record.released_at,
      file,
    };
  }

  /**
   * The owner's file a link id names (an export job `j_…` or a media `m_…`), with its name, or
   * undefined when the id is not the owner's or the file has gone.
   */
  async lookup(owner: string, id: string): Promise<{ id: string; name: string } | undefined> {
    const ref = refOf(id);
    if (!ref) return undefined;
    try {
      return await this.#file(owner, ref);
    } catch (error) {
      if (error instanceof CfError && error.code === 'not_found') return undefined;
      throw error;
    }
  }

  /** The signed file a release names: an export's output, or a media's own file. */
  async #file(
    owner: string,
    ref: { job_id?: string | undefined; media_id?: string | undefined },
  ): Promise<{ id: string; name: string }> {
    const rt = this.#rt;
    const gone = (what: string) =>
      new CfError('not_found', `${what} is not here any more, or was never made`, {
        hint: 'Exports are kept 7 days. Export the timeline again (or make it again) for a new file, then release that',
      });
    if (ref.media_id) {
      const record = await rt.media.find(owner, ref.media_id);
      if (!record?.file || record.status !== 'ready') throw gone(`Media ${ref.media_id}`);
      return { id: record.media_id, name: record.name };
    }
    const id = ref.job_id ?? '';
    const job = await rt.jobs.store.get(id, owner);
    if (!job) throw gone(`Job ${id}`);
    const made = (job.result?.structuredContent as { media_id?: string } | undefined)?.media_id;
    if (made && !(await rt.outputs.file(owner, id))) return this.#file(owner, { media_id: made });
    const name = await rt.outputs.file(owner, id, (n) => !n.startsWith(MARKED_PREFIX));
    if (!name) throw gone(`The file of job ${id}`);
    return { id, name };
  }

  #after(createdAt: string | undefined): boolean {
    return Boolean(createdAt) && Date.parse(createdAt ?? '') >= this.#from;
  }

  /** A media has the watermark when an export, a create.* job or a still made its picture. */
  #gatedMedia(record: MediaRecord): Gated | undefined {
    const source = record.source;
    if (!this.#after(record.created_at) || !record.file || !record.probe) return undefined;
    if (record.probe.kind !== 'video' && record.probe.kind !== 'image') return undefined;
    let releaseId: string;
    if ('job' in source) releaseId = source.job;
    else if ('created' in source) releaseId = source.job_id ?? record.media_id;
    else if ('still' in source) releaseId = record.media_id;
    else return undefined;
    const mime = record.probe.mime ?? (record.probe.kind === 'image' ? 'image/png' : 'video/mp4');
    return priced(releaseId, mime, record.probe.duration, record.created_at);
  }
}

function priced(
  releaseId: string,
  mime: string,
  seconds: number | null | undefined,
  createdAt: string,
): Gated {
  const still = mime.startsWith('image/') && mime !== 'image/gif';
  const length = still ? null : seconds;
  return {
    releaseId,
    credits: cleanCopyCredits(length),
    minutes: cleanCopyMinutes(length),
    createdAt,
  };
}

function credits(n: number): string {
  return `${n} credit${n === 1 ? '' : 's'}`;
}

/**
 * The final copy's link beside a signed download (/outputs/… → /final/…, same signature): opening
 * it releases the file (its release_credits, once), then downloads the clean file.
 */
export function finalLink(url: string): string | undefined {
  const u = new URL(url);
  if (!u.pathname.startsWith('/outputs/')) return undefined;
  u.pathname = `/final/${u.pathname.slice('/outputs/'.length)}`;
  return u.href;
}

/**
 * A watermarked file in words, for the agent: url is the free review copy, final_url the clean
 * copy (when there is one), what it costs and what the user has; give the user both.
 */
export function watermarkNote(
  price: number,
  left: number | null | undefined,
  final = false,
): string {
  const short = typeof left === 'number' && left < price;
  const has =
    left === undefined
      ? ''
      : left === null
        ? '; this account has no credit cap'
        : `; this account has ${credits(left)}, ${short ? 'too few' : 'enough'}`;
  if (final)
    return `url is the review copy, with a cuttingfloor watermark, free. final_url is the final copy without it: opening it uses ${credits(price)} once${has}${
      short ? ', and shows how to get more' : ''
    }. Give the user both links, with the price and their credits beside final_url.`;
  return `This copy has a cuttingfloor watermark, for reviewing, which is free. Releasing it removes the watermark for ${credits(price)}${has}. ${
    short
      ? 'The watermarked copy is what downloads until then.'
      : 'Once the user has reviewed it, offer to release it now.'
  }`;
}

/** What a link id names for a release: a media (`m_…`) or an export job (`j_…`). */
export function refOf(id: string): { media_id: string } | { job_id: string } | undefined {
  if (/^m_[A-Za-z0-9_-]+$/.test(id)) return { media_id: id };
  if (/^j_[A-Za-z0-9_-]+$/.test(id)) return { job_id: id };
  return undefined;
}
