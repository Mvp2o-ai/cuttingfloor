import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lengthFrames, noAudio, renderMix, renderSource } from '@cuttingfloor/engine';
import { CfError } from '@cuttingfloor/schema';
import { assertOnline, sourcesFor } from './render.ts';
import type { Runtime } from './runtime.ts';

// The sound a measure reads: an imported media file over a range, or a timeline's mix over a
// range, rendered to a file first. Times in results are the source's own seconds: media seconds,
// or timeline seconds (`shift` moves file times on the mix back to the timeline's clock).

export interface SoundRef {
  media_id?: string | undefined;
  timeline_id?: string | undefined;
  from_seconds?: number | undefined;
  until_seconds?: number | undefined;
}

export interface Sound {
  file: string;
  /** Range in the file's seconds, for the engine. */
  from?: number;
  until?: number;
  /** Seconds to add to a time in the file to give the source's own time. */
  shift: number;
  label: string;
  /** Duration of the source in its own seconds, when known. */
  duration: number | null;
}

type Plan =
  | { kind: 'media'; label: string; sound: Omit<Sound, 'label'> }
  | {
      kind: 'timeline';
      label: string;
      doc: Awaited<ReturnType<Runtime['timelines']['get']>>;
      start: number;
      end: number;
      shift: number;
      duration: number;
    };

/**
 * Checks a sound reference before any work: the media or timeline exists, has sound, and the
 * range is inside it. Fails with no_audio naming the source. Returns what reading it takes.
 */
export async function checkSound(
  rt: Runtime,
  owner: string,
  ref: SoundRef,
  name?: string,
): Promise<{ plan: Plan; seconds: number }> {
  const named = name ? `${name} (` : '';
  const close = name ? ')' : '';
  const range = {
    ...(ref.from_seconds !== undefined ? { from: ref.from_seconds } : {}),
    ...(ref.until_seconds !== undefined ? { until: ref.until_seconds } : {}),
  };
  if (range.until !== undefined && range.until <= (range.from ?? 0)) {
    throw noAudio(
      {
        ...range,
        label: `${named}${ref.media_id ? `media ${ref.media_id}` : `timeline ${ref.timeline_id}`}${close}`,
      },
      'the range is empty',
    );
  }
  if (ref.media_id) {
    const label = `${named}media ${ref.media_id}${close}`;
    const record = await rt.media.get(owner, ref.media_id);
    if (record.status !== 'ready' && record.status !== 'processing') {
      throw new CfError('media_not_ready', `Media ${ref.media_id} is still importing`, {
        hint: 'Wait for its media.import job to finish',
      });
    }
    const p = record.probe;
    if (!p?.audio) throw noAudio({ ...range, label }, 'it has no audio stream');
    const duration = p.duration ?? null;
    if (duration !== null && (range.from ?? 0) >= duration) {
      throw noAudio({ ...range, label }, `it is ${duration} s long`);
    }
    const seconds =
      Math.min(range.until ?? duration ?? 0, duration ?? Number.POSITIVE_INFINITY) -
      (range.from ?? 0);
    return {
      plan: {
        kind: 'media',
        label,
        sound: { file: renderSource(record, 'export'), ...range, shift: 0, duration },
      },
      seconds,
    };
  }
  const id = ref.timeline_id as string;
  const label = `${named}timeline ${id}${close}`;
  const doc = await rt.timelines.get(owner, id);
  const length = lengthFrames(doc);
  const fps = doc.sequence.fps;
  const toSeconds = (f: number) => (f * fps.den) / fps.num;
  const total = toSeconds(length);
  if (!length) throw noAudio({ ...range, label }, 'the timeline is empty');
  const start = Math.max(0, Math.floor(((range.from ?? 0) * fps.num) / fps.den + 1e-6));
  const end = Math.min(
    length,
    range.until === undefined ? length : Math.ceil((range.until * fps.num) / fps.den - 1e-6),
  );
  if (start >= length) throw noAudio({ ...range, label }, `the timeline is ${total} s long`);
  if (end <= start) throw noAudio({ ...range, label }, 'the range is empty');
  if (!doc.tracks.some((t) => t.clips.some((c) => c.type === 'media' || c.type === 'timeline'))) {
    throw noAudio({ ...range, label }, 'it has no clips with sound');
  }
  return {
    plan: { kind: 'timeline', label, doc, start, end, shift: toSeconds(start), duration: total },
    seconds: toSeconds(end - start),
  };
}

/** The sound of a media item or a timeline (rendered), handed to `work`, then cleaned up. */
export async function withSound<T>(
  rt: Runtime,
  owner: string,
  ref: SoundRef,
  options: { name?: string; signal?: AbortSignal },
  work: (sound: Sound) => Promise<T>,
): Promise<T> {
  const { plan } = await checkSound(rt, owner, ref, options.name);
  if (plan.kind === 'media') return work({ ...plan.sound, label: plan.label });
  const { sources, offline } = await sourcesFor(rt, owner, plan.doc, 'preview');
  assertOnline(offline);
  const dir = await mkdtemp(join(tmpdir(), 'cf-sound-'));
  try {
    const file = await renderMix(
      plan.doc,
      sources,
      dir,
      { start: plan.start, end: plan.end },
      options.signal,
    );
    return await work({ file, shift: plan.shift, label: plan.label, duration: plan.duration });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
