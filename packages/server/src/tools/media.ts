import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  analyseBeats,
  detectFaces,
  detectScenes,
  detectSilences,
  detectSounds,
  fingerprint,
  type MediaRecord,
  mayBeTransparent,
  measureLoudness,
  mediaInfo,
  mediaStills,
  noAudio,
  renderSource,
  SOUND_MODELS,
  SPEECH_MODELS,
  type SpeechProbabilities,
  soundOffset,
  speechProbabilities,
  speechSpans,
  trackRegion,
  transcribe,
} from '@cuttingfloor/engine';
import type { Job, JobContext } from '@cuttingfloor/jobs';
import {
  CfError,
  CORRELATE_LIMITS,
  JUDGE_LIMITS,
  MEDIA_LIMITS,
  MediaAnalyzeInput,
  MediaAnalyzeResult,
  MediaCorrelateInput,
  MediaCorrelateResult,
  MediaDeleteInput,
  MediaDeleteResult,
  MediaImportInput,
  MediaInfo,
  MediaListInput,
  MediaListResult,
  type MediaPage,
  MediaRefInput,
  MediaUploadInput,
  MediaUploadResult,
  TIMELINE_ANALYSES,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { askFrames, checkFrameState, type JudgedFrame, sampleTimes } from '../frames.ts';
import { JEV_MODEL, JEV_URL } from '../jev.ts';
import { admitJob } from '../meter.ts';
import { PLAYER_TOOL_META } from '../player.ts';
import type { SourceSpan } from '../render.ts';
import { guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { checkSound, type Sound, withSound } from '../sound.ts';
import { listHeld, startUpload, storageOf, storageRoom } from '../storage.ts';
import { addUsage, checkQuota } from '../usage.ts';
import {
  checkQuestions,
  checkText,
  JUDGMENTS,
  jevKeyRequired,
  PICTURE,
  pictureSize,
} from './judge.ts';
import { soundLabelIndexes, soundsReport } from './listen.ts';

/** Analysis data longer than this stays with the media instead of filling the result. */
const INLINE_CHARS = 20_000;

/** media.correlate reading this little from each side answers at once. */
const CORRELATE_INLINE_SECONDS = 120;

/** An analysis for the result: whole when short, or a note on how to read it in pieces. */
function inline(mediaId: string, kind: string, data: unknown): Record<string, unknown> {
  const chars = JSON.stringify(data).length;
  if (chars <= INLINE_CHARS) return { [kind]: data };
  return {
    note: `The ${kind} is ${chars} characters, too long to return here. It is stored with the media: read it in pieces with media.get {media_id: '${mediaId}', include: ['${kind}'], from_seconds, to_seconds} for a stretch of the media, or offset and limit for a page; pages says where each piece sits in the whole list and where the next one starts.`,
  };
}

interface Window {
  from?: number;
  to?: number;
  offset: number;
  limit?: number;
}

/**
 * One list cut to the window: items overlapping [from, to) in media time, then `offset` and
 * `limit`. `span` gives an item's time span.
 */
function cut<T>(items: T[], span: (item: T) => [number, number], w: Window) {
  const inRange = (item: T) => {
    const [start, end] = span(item);
    return (w.from === undefined || end > w.from) && (w.to === undefined || start < w.to);
  };
  const start = items.findIndex(inRange);
  const matching = start < 0 ? [] : items.filter(inRange);
  const kept = matching.slice(w.offset, w.limit === undefined ? undefined : w.offset + w.limit);
  const after = w.offset + kept.length;
  return {
    kept,
    page: (list: string): MediaPage => ({
      list,
      first: kept.length ? items.indexOf(kept[0] as T) : Math.max(start, 0) + w.offset,
      returned: kept.length,
      matching: matching.length,
      total: items.length,
      next_offset: after < matching.length ? after : null,
    }),
  };
}

/** The included analyses cut to the window, with where each piece sits in its whole list. */
function paged(info: MediaInfo, w: Window): Partial<MediaInfo> {
  const out: Partial<MediaInfo> = {};
  const pages: NonNullable<MediaInfo['pages']> = {};
  if (info.transcript) {
    const { kept, page } = cut(info.transcript.words, (x) => [x.start, x.end], w);
    out.transcript = { ...info.transcript, text: kept.map((x) => x.text).join(' '), words: kept };
    pages.transcript = page('transcript.words');
  }
  if (info.beats) {
    const { kept, page } = cut(info.beats.beats, (t) => [t, t], w);
    const lo = kept[0] ?? Number.POSITIVE_INFINITY;
    const hi = kept.at(-1) ?? Number.NEGATIVE_INFINITY;
    out.beats = {
      ...info.beats,
      beats: kept,
      downbeats: info.beats.downbeats.filter((t) => t >= lo && t <= hi),
    };
    pages.beats = page('beats.beats');
  }
  if (info.faces) {
    const { kept, page } = cut(info.faces.frames, (f) => [f.time, f.time], w);
    out.faces = { ...info.faces, frames: kept };
    pages.faces = page('faces.frames');
  }
  if (info.speech) {
    const { from, frame_seconds: step } = info.speech;
    const frames = info.speech.probabilities.map((_, i) => i);
    const { kept, page } = cut(frames, (i) => [from + i * step, from + (i + 1) * step], w);
    const first = kept[0] ?? 0;
    out.speech = {
      ...info.speech,
      from: from + first * step,
      probabilities: kept.map((i) => info.speech?.probabilities[i] ?? 0),
    };
    pages.speech = page('speech.probabilities');
  }
  if (info.look) {
    const runs = info.look.runs.map((r) => ({
      run: r,
      ...cut(r.frames, (f) => [f.time, f.time], w),
    }));
    out.look = { runs: runs.map(({ run, kept }) => ({ ...run, frames: kept })) };
    const latest = runs.at(-1);
    if (latest) pages.look = latest.page('look runs[].frames');
  }
  return { ...out, pages };
}

/** A speech result with its probabilities only when they are short enough to return. */
function inlineSpeech(result: Record<string, unknown>, mediaId?: string): Record<string, unknown> {
  const speech = result.speech as { probabilities?: number[] } | undefined;
  if (!speech?.probabilities) return result;
  if (JSON.stringify(speech.probabilities).length <= INLINE_CHARS) return result;
  const { probabilities: _all, ...rest } = speech;
  return {
    ...result,
    speech: rest,
    note: `${_all.length} probabilities are too many to return here; spans has the speech at your min_probability${mediaId ? `, and media.get {include: ['speech']} returns every probability` : '; ask again over a shorter range for every probability'}.`,
  };
}

type LookFrame = JudgedFrame;

type AnalyzeArgs = {
  kind: string;
  min_probability?: number | undefined;
  threshold_db?: number | undefined;
  min_seconds?: number | undefined;
  from_seconds?: number | undefined;
  until_seconds?: number | undefined;
};

/** Checks the settings a sound measure needs, before any job exists. */
function checkSoundArgs(args: AnalyzeArgs): void {
  if (args.kind === 'speech' && args.min_probability === undefined) {
    throw new CfError('bad_request', 'speech needs min_probability (0–1)', {
      hint: 'Say what counts as speech, e.g. {min_probability: 0.5}; every probability is kept, so you can ask again with another',
    });
  }
  if (
    args.kind === 'silence' &&
    (args.threshold_db === undefined || args.min_seconds === undefined)
  ) {
    throw new CfError('bad_request', 'silence needs threshold_db and min_seconds', {
      hint: 'Say what counts as quiet, e.g. {threshold_db: -40, min_seconds: 0.3}',
    });
  }
  if (
    args.from_seconds !== undefined &&
    args.until_seconds !== undefined &&
    args.until_seconds <= args.from_seconds
  ) {
    throw new CfError('bad_request', 'until_seconds must be after from_seconds');
  }
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The part of stored speech probabilities inside a range. */
function sliceSpeech(p: SpeechProbabilities, from?: number, until?: number): SpeechProbabilities {
  const a = Math.max(0, Math.floor(((from ?? p.from) - p.from) / p.frame_seconds));
  const b =
    until === undefined
      ? p.probabilities.length
      : Math.min(p.probabilities.length, Math.ceil((until - p.from) / p.frame_seconds));
  return {
    ...p,
    from: r3(p.from + a * p.frame_seconds),
    probabilities: p.probabilities.slice(a, b),
  };
}

/** speech, loudness or silence on a sound, with times in the source's own seconds. */
async function measureSound(
  sound: Sound,
  args: AnalyzeArgs,
  signal: AbortSignal,
  progress: (f: number, m: string) => void,
  stored?: SpeechProbabilities,
): Promise<{ result: Record<string, unknown>; speech?: SpeechProbabilities }> {
  const range = {
    ...(sound.from !== undefined ? { from: sound.from } : {}),
    ...(sound.until !== undefined ? { until: sound.until } : {}),
    label: sound.label,
  };
  const shift = (t: number) => r3(t + sound.shift);
  if (args.kind === 'speech') {
    progress(0.05, 'speech: listening');
    const fresh = stored
      ? undefined
      : await speechProbabilities(sound.file, {
          ...range,
          signal,
          onProgress: (f) => progress(0.05 + 0.9 * f, 'speech: listening'),
        });
    const probs = stored
      ? sliceSpeech(stored, sound.from, sound.until)
      : (fresh as SpeechProbabilities);
    const onClock = { ...probs, from: shift(probs.from) };
    const min = args.min_probability as number;
    return {
      result: {
        speech: {
          model: probs.model,
          min_probability: min,
          spans: speechSpans(onClock, min),
          frame_seconds: probs.frame_seconds,
          from: onClock.from,
          probabilities: probs.probabilities,
        },
      },
      ...(fresh ? { speech: fresh } : {}),
    };
  }
  if (args.kind === 'loudness') {
    progress(0.1, 'loudness: measuring');
    const facts = await measureLoudness(sound.file, { ...range, signal });
    return {
      result: {
        loudness: {
          ...facts,
          from: args.from_seconds ?? 0,
          until: args.until_seconds ?? null,
        },
      },
    };
  }
  progress(0.1, 'silence: listening');
  const lo = args.from_seconds ?? 0;
  const hi = args.until_seconds ?? Number.POSITIVE_INFINITY;
  const silences = (
    await detectSilences(sound.file, {
      thresholdDb: args.threshold_db as number,
      minSeconds: args.min_seconds as number,
      ...(sound.duration !== null ? { duration: sound.duration - sound.shift } : {}),
      signal,
    })
  )
    .map((x) => ({ start: shift(x.start), end: shift(x.end) }))
    .filter((x) => x.end > lo && x.start < hi)
    .map((x) => ({ start: Math.max(lo, x.start), end: Math.min(hi, x.end) }));
  return { result: { silences } };
}

/** Per question, where its answers sit: yes spans, choice spans, score range. */
function lookDigest(questions: Record<string, { type: string }>, frames: LookFrame[]) {
  const spans = (pick: (f: LookFrame) => string | null) => {
    const out: Array<{ value: string; from: number; to: number }> = [];
    for (const f of frames) {
      const v = pick(f);
      const last = out.at(-1);
      if (v !== null && last?.value === v && last.to === frames[frames.indexOf(f) - 1]?.time)
        last.to = f.time;
      else if (v !== null) out.push({ value: v, from: f.time, to: f.time });
    }
    return out;
  };
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      const a = (f: LookFrame) => f.answers[id] as Record<string, number & string> | undefined;
      if (q.type === 'noul') {
        const yes = spans((f) => ((a(f)?.noul ?? 0) >= 0.5 ? 'yes' : null));
        return [id, { yes_at: yes.map(({ from, to }) => ({ from, to })) }];
      }
      if (q.type === 'choice') {
        return [
          id,
          {
            spans: spans((f) => a(f)?.choice ?? null).map(({ value, from, to }) => ({
              choice: value,
              from,
              to,
            })),
          },
        ];
      }
      if (q.type === 'score') {
        const s = frames.map((f) => ({ time: f.time, score: a(f)?.score ?? 0 }));
        const lo = s.reduce((m, x) => (x.score < m.score ? x : m), s[0] ?? { time: 0, score: 0 });
        const hi = s.reduce((m, x) => (x.score > m.score ? x : m), s[0] ?? { time: 0, score: 0 });
        return [id, { lowest: lo, highest: hi }];
      }
      const sure = frames.filter((f) => (a(f)?.confidence ?? 0) >= 0.6).length;
      return [id, { frames_confident: sure }];
    }),
  );
}

export function registerMediaTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  /** What an export.video job rendered, for the media's origin. */
  const renderedFrom = async (owner: string, jobId: string) => {
    const job = await rt.jobs.store.get(jobId, owner);
    const meta = job?.meta ?? {};
    const preset =
      meta.preset ??
      ((job?.result as { structuredContent?: { preset?: string } } | undefined)?.structuredContent
        ?.preset as string | undefined);
    const start = Number(meta.range_start);
    const end = Number(meta.range_end);
    let sources: unknown;
    try {
      sources = meta.sources ? JSON.parse(meta.sources) : undefined;
    } catch {
      sources = undefined;
    }
    return {
      ...(Array.isArray(sources) ? { sources: sources as SourceSpan[] } : {}),
      ...(meta.timeline_id ? { timeline_id: meta.timeline_id } : {}),
      ...(preset ? { preset } : {}),
      ...(meta.range_start && meta.range_end ? { range: { start, end } } : {}),
    };
  };

  /** The file a completed export.video rendered, for importing it as media. */
  const renderedFile = async (owner: string, jobId: string): Promise<string> => {
    const job = await rt.jobs.store.get(jobId, owner);
    if (!job) {
      throw new CfError('not_found', `No job ${jobId}`, { hint: 'Finished jobs are kept 7 days' });
    }
    if (job.tool !== 'export.video') {
      throw new CfError('bad_request', `Job ${jobId} is a ${job.tool}, not an export.video`, {
        hint: 'Only rendered videos import as media',
      });
    }
    if (job.status === 'working') {
      throw new CfError('media_not_ready', `Export ${jobId} is still rendering`, {
        hint: 'Import it once job.get {job_id} says completed',
      });
    }
    const result = job.result as { isError?: boolean } | undefined;
    if (job.status !== 'completed' || result?.isError) {
      throw new CfError('bad_request', `Export ${jobId} did not finish (${job.status})`);
    }
    const dir = rt.ws.ownerDir(owner, 'outputs', jobId);
    const [name] = (await readdir(dir).catch(() => [] as string[])).filter(
      (n) => !n.startsWith('.'),
    );
    if (!name) {
      throw new CfError('not_found', `Export ${jobId} has no file any more`, {
        hint: 'Outputs expire 7 days after the export; export the timeline again',
      });
    }
    return join(dir, name);
  };

  server.registerTool(
    'media.import',
    {
      title: 'Import media',
      description: [
        "Import the user's own video, audio, image or font to edit with or place as is: probe, fingerprint, conform if needed (VFR, rotation, HDR → BT.709), 540p proxy and integrated loudness. A reference image to recreate needs no import: rebuild it with create.motion or create.still.",
        'Long-running: returns a task, or {job_id, media_id} for job.get. The media_id is usable in edits as soon as the job reports processing, so with many files, start every import first and edit while they finish.',
        `Sources: ${rt.config.mediaRoots.length ? `a path under ${rt.config.mediaRoots.join(', ')}, ` : ''}an http(s) URL (Dropbox and Google Drive share links work as they are), {upload: {name, bytes}} for a file you send yourself (the answer is the new media with upload.url: PUT the file there, curl --fail -T file '<url>', and it imports once the last byte arrives, with no base64 in a message; a broken PUT resumes as media.upload says), the upload_id of a file sent through media.upload, a small file as a data: URI (up to ${MEDIA_LIMITS.inlineBytes / 1024 ** 2} MB, with its sha256 so a garbled copy is refused), or the job_id of a completed export.video (its render becomes media). A URL is fetched once, when the import starts: it only has to work until then (a short-lived signed link from the user's own storage is enough), and the copy stays here 7 days after last use. A file the user attached in the chat comes as file, when the client passes it.`,
        'Importing the same file again returns the same media_id.',
      ].join(' '),
      inputSchema: MediaImportInput,
      outputSchema: withJob(MediaInfo),
      // ChatGPT passes a file the user attached as this argument.
      _meta: { 'openai/fileParams': ['file'] },
      annotations: {
        title: 'Import media',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.import', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      if (Boolean(args.source) === Boolean(args.file)) {
        throw new CfError('bad_request', 'Give either source or file', {
          hint: 'media.import {source: {url: "https://…"}}, or file as the client attached it',
        });
      }
      // An attached file downloads from its URL; a data: URI becomes an upload that is already in.
      const given = args.file
        ? { url: args.file.download_url }
        : (args.source as NonNullable<typeof args.source>);
      if ('upload' in given) {
        // Media now, its file later: the PUT that completes the upload starts the import.
        const limits = await deps.limits?.();
        const room = await storageRoom(rt.ws, owner, limits, given.upload.bytes);
        const admit = await admitJob(deps.limits);
        let record: MediaRecord | undefined;
        const upload = await rt.uploads.createImport(
          owner,
          given.upload.name,
          given.upload.bytes,
          room,
          async (upload_id) => {
            record = await rt.media.create(
              owner,
              { upload: upload_id, file_name: given.upload.name, via: 'media.upload' },
              args.name ?? given.upload.name,
            );
            return {
              owner,
              media_id: record.media_id,
              ...(admit.ownerLimit === undefined ? {} : { owner_limit: admit.ownerLimit }),
            };
          },
        );
        return ok({ ...mediaInfo(record as MediaRecord), upload });
      }
      const source =
        'data' in given
          ? {
              upload_id: await rt.uploads.put(
                owner,
                args.name ?? `inline${extensionFor(dataUriType(given.data))}`,
                decodeDataUri(given.data, given.sha256),
              ),
            }
          : given;
      const named = args.name ?? (args.file?.file_name || undefined);
      // Path, upload and render imports fail fast (outside the roots, missing, unfinished) and
      // dedupe by fingerprint.
      const upload =
        'upload_id' in source ? await rt.uploads.take(owner, source.upload_id) : undefined;
      const local =
        'path' in source
          ? await rt.media.resolvePath(source.path)
          : 'job_id' in source
            ? await renderedFile(owner, source.job_id)
            : upload?.file;
      if (local) {
        const known = await rt.media.findByFingerprint(owner, await fingerprint(local));
        if (known) {
          if ('upload_id' in source) await rt.uploads.remove(owner, source.upload_id);
          const done = await store.create({
            owner,
            tool: 'media.import',
            meta: { media_id: known.media_id },
            ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
          });
          const result = ok(mediaInfo(known));
          return jobReply(
            await store.update(done, {
              status: 'completed',
              progress: 1,
              statusMessage: 'already imported',
              result: result as never,
            }),
            ctx,
          );
        }
      }
      // A download or a copied render adds to what the account holds; an upload is already in.
      const room =
        'url' in source
          ? await storageRoom(rt.ws, owner, await deps.limits?.())
          : local && 'job_id' in source
            ? await storageRoom(rt.ws, owner, await deps.limits?.(), (await stat(local)).size)
            : undefined;
      const admit = await admitJob(deps.limits);
      const record = await rt.media.create(
        owner,
        'job_id' in source
          ? { job: source.job_id, ...(await renderedFrom(owner, source.job_id)) }
          : 'upload_id' in source
            ? {
                upload: source.upload_id,
                ...(upload?.name ? { file_name: upload.name } : {}),
                ...(upload?.via ? { via: upload.via } : {}),
              }
            : 'url' in source && args.file
              ? { url: source.url, attached: true }
              : source,
        named ?? upload?.name ?? (local && 'job_id' in source ? basename(local) : undefined),
      );
      if (local && 'job_id' in source) {
        // The render is copied: outputs and media expire on their own clocks.
        record.file = await rt.media.adopt(owner, record, local);
        await rt.media.save(owner, record);
      } else if (local && 'upload_id' in source) {
        record.file = await rt.media.adopt(owner, record, local, { move: true });
        await rt.media.save(owner, record);
        await rt.uploads.remove(owner, source.upload_id);
      }
      const job = await startIngest(rt, owner, record, admit, {
        ...(room === undefined ? {} : { room }),
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'media.upload',
    {
      title: 'Upload media',
      description: [
        "A signed URL to send one of the user's files to this server, for files on their machine that the server can't read: PUT the file there (curl --fail -T interview.mp4 '<url>'), then media.import {source: {upload_id}}. The URL needs no other credentials and works for a day.",
        'A broken upload resumes: HEAD the url for Upload-Offset (the bytes received), then PUT the rest with Content-Range: bytes <offset>-<last>/<total>. Large files can go in parts the same way.',
        'Without a way to send it yourself, give the user the url: opened in a browser it is a page to drop the file on, which sends it and resumes on its own. media.import says whether the file is all in yet.',
      ].join(' '),
      inputSchema: MediaUploadInput,
      outputSchema: MediaUploadResult,
      annotations: {
        title: 'Upload media',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const upload = await startUpload(
        rt,
        deps.owner(),
        args.name,
        args.bytes,
        await deps.limits?.(),
      );
      return ok({
        ...upload,
        how: `curl --fail -T ${shellQuote(args.name)} '${upload.url}' (or the user opens the url in a browser and drops the file), then media.import {source: {upload_id: "${upload.upload_id}"}}`,
      });
    }),
  );

  server.registerTool(
    'media.list',
    {
      title: 'List media',
      description: [
        "What the user has here: imported and created media, and files they sent that aren't imported yet (through media.upload, or dropped on their account page at cuttingfloor.ai/account), with names, sizes and when each expires, plus the account's storage used and its cap.",
        'When the user mentions a file they sent or dropped ("the interview I uploaded"), find it here by name and media.import {source: {upload_id}} it; complete says it is all in. Listing does not count as a use, so nothing here lasts longer for being listed.',
      ].join(' '),
      inputSchema: MediaListInput,
      outputSchema: MediaListResult,
      annotations: {
        title: 'List media',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async () => ok(await listHeld(rt, deps.owner(), await deps.limits?.()))),
  );

  server.registerTool(
    'media.delete',
    {
      title: 'Delete media',
      description: [
        'Delete a media for good, so an old or wrong version stops turning up: its file here, proxy, mezzanine and media.analyze results go, and its room comes back to the storage cap. A path import leaves the original in its folder; exports made from it stay.',
        'Timelines that use it keep their ids and edits but no longer render (media_offline names it, as for expired media): replace those clips with clip.replace. Importing the same file again makes a new media_id.',
      ].join(' '),
      inputSchema: MediaDeleteInput,
      outputSchema: MediaDeleteResult,
      annotations: {
        title: 'Delete media',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const freed = await rt.media.remove(owner, args.media_id);
      const storage = await storageOf(rt.ws, owner, await deps.limits?.());
      return ok({ media_id: args.media_id, deleted: true as const, freed_bytes: freed, storage });
    }),
  );

  server.registerTool(
    'media.analyze',
    {
      title: 'Analyze media',
      description: [
        "Find what is in imported media, or in the sound of an edit, as data for edits. transcript: every word with its time (whisper.cpp on the CPU; the model downloads once). For English the word edges are then aligned to the sound (wav2vec2 forced alignment): a word starts and ends within about 0.05 s of where its letters sound, and an end on a soft consonant (s, t, k, f) or a breath can ring on up to about 0.1 s more; timing_confidence says how clearly each word was heard. Other languages keep whisper's own times, up to about a second off. Short ums and uhs are often left out of the words; kind speech still hears them. beats: tempo, beat and downbeat times. faces: face boxes over time, e.g. to reframe to 9:16 with clip.set_transform keyframes. track: follow a region you give from a moment on, a box for each sampled time (found false where the subject was lost); to make a title, sticker, arrow or mask follow the subject, turn the boxes into clip.set_transform (or clip.set_mask) keyframes, no tracking of your own needed. look: your own typed questions about what is on screen, answered on every sampled frame (to find where something happens from plain words, media.seek). silence: stretches quieter than threshold_db for at least min_seconds. scenes: times the picture changes by more than threshold (0–100). speech: the probability that someone is speaking, every 32 ms (Silero VAD), and the spans where it is at least your min_probability; it hears speech, not noise or music, so a cough or a door is not speech. loudness: integrated loudness (LUFS), true peak (dBTP), loudness range (LU), RMS level and noise floor (dBFS) over the whole media or from_seconds to until_seconds. To line up two recordings, media.correlate. sounds: what can be heard and when, every 40 ms, for 447 named sounds (video://catalog/sounds: Laughter, Applause, Cough, Sneeze, Music, Speech, Door, Footsteps, Beep…): give labels for the ones you want, or none for every sound that reaches your min_probability; you get each sound's spans and its probability in every frame. To find a sound you describe in your own words, media.listen.",
        `With timeline_id instead of media_id, ${TIMELINE_ANALYSES.join(', ')} measure the edit's mix as it plays, over from_seconds to until_seconds (timeline seconds). A source or range with no sound fails with no_audio, naming it.`,
        'Times are media seconds (timeline seconds for a timeline); boxes are fractions of the picture. Results stay with the media (media.get include) except track, silence, scenes and loudness, which come back in the result; speech over the whole media is kept (media.get include speech), so asking again with another min_probability or range answers from it. A result too long to return (a long transcript) comes back as its summary and a note: read it in pieces with media.get include and a time range or page.',
        'Long-running: returns a task, or a job_id for job.get.',
        '',
        'HOW LOOK WORKS. TypeSafe Jev, a fast judgment model (preview), answers your questions about frames sampled from the media. Each sampled frame is its own request: Jev sees that one picture, named `frame`, and with with_previous also the frame sampled just before it, named `previous`, plus any state you give: text or JSON entries by name, the same on every frame (the script, what a term means). Every question is answered on every frame, independently and in parallel (about 0.15 s a frame), as typed data you then combine in your own code.',
        'Choose the type by the answer you need. noul: yes or no, answered as noul, the probability of yes from 0 to 1. choice: one of options you name, answered as choice plus probabilities and confidence. score: a degree on levels you order, answered as score (0 is the first level; it can land between levels) plus confidence. box: where one thing is, answered as box {x, y, w, h} in fractions of the picture plus confidence.',
        'Write each question about the picture as it looks. Name the picture in backticks ("in `frame`"), ask about one thing, word it so yes means the thing is there, and describe it as it appears: "Does `frame` show a human being, even if only their face fills the picture?", "Is one large word laid over `frame`, much bigger than any other text?". To compare, name both pictures and the thing that differs: "Is there a button in `frame` that is not in `previous`?". To locate, name the one thing so only it fits ("the \'Get started for free\' button under the headline in `frame`") and, in the same call, a noul asking whether it is there; use the box on frames where that noul is high. Give a choice a none option for frames where nothing fits, and each score level a concrete situation.',
        'Read the answers this way: a noul of 0.5 or more reads as yes, and you can set your own cut-off; confidence tells you how far to trust a choice, a score or a box, and a loose box shows as low confidence. Work in passes: every_seconds 1 over the whole media, then at_seconds around the times where answers change. media.get scenes give when the picture cuts; look tells you what is on it.',
        `The result gives each question's spans (when a noul reads yes, which choice holds when); every frame's answers stay with the media (media.get include ['look'], the last 10 runs). Up to ${JUDGE_LIMITS.frames} frames and ${JUDGE_LIMITS.lookQuestions} questions a call. To find the moments that match a description, media.seek takes it in plain words and returns where it holds. For one judgment about text, a still or a single frame, judge.ask answers at once. Full guide to writing questions: https://docs.typesafe.ai/primitives and https://docs.typesafe.ai/images.`,
      ].join('\n'),
      inputSchema: MediaAnalyzeInput,
      outputSchema: withJob(MediaAnalyzeResult),
      annotations: {
        title: 'Analyze media',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (args.kind === 'look') {
        if (!(await deps.credentials.status(owner, 'typesafe')).configured) {
          throw jevKeyRequired('look');
        }
        checkQuestions('look', args.questions, JUDGE_LIMITS.lookQuestions);
        checkFrameState('look', args.state);
        checkText(args.state ?? {});
      }
      const soundColumns =
        args.kind === 'sounds' && args.labels ? soundLabelIndexes(args.labels) : undefined;
      if (args.kind === 'sounds' && args.min_probability === undefined) {
        throw new CfError('bad_request', 'sounds needs a min_probability (0–1)', {
          hint: 'Say what probability counts as heard, e.g. {min_probability: 0.3}; scores give every frame for a second look',
        });
      }
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.analyze', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      if (args.timeline_id) {
        const timelineId = args.timeline_id;
        if (!(TIMELINE_ANALYSES as readonly string[]).includes(args.kind)) {
          throw new CfError(
            'bad_request',
            `${args.kind} reads imported media; on a timeline: ${TIMELINE_ANALYSES.join(', ')}`,
            { hint: 'Give the media_id of a clip instead (timeline.get lists them)' },
          );
        }
        checkSoundArgs(args);
        await checkSound(rt, owner, {
          timeline_id: timelineId,
          from_seconds: args.from_seconds,
          until_seconds: args.until_seconds,
        });
        const admit = await admitJob(deps.limits);
        const job = await store.create({
          owner,
          tool: 'media.analyze',
          meta: { timeline_id: timelineId, kind: args.kind },
          statusMessage: `${args.kind}: starting`,
          ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
        });
        rt.jobs.start(
          job,
          async ({ signal, progress }) => {
            progress(0.02, `${args.kind}: rendering the mix`);
            const { result } = await withSound(
              rt,
              owner,
              {
                timeline_id: timelineId,
                from_seconds: args.from_seconds,
                until_seconds: args.until_seconds,
              },
              { signal },
              (sound) => measureSound(sound, args, signal, progress),
            );
            return ok({
              timeline_id: timelineId,
              kind: args.kind,
              ...inlineSpeech(result),
            }) as never;
          },
          admit,
        );
        return jobReply(job, ctx);
      }
      const mediaId = args.media_id as string;
      const record = await rt.media.get(owner, mediaId);
      if (record.status !== 'ready') {
        throw new CfError('media_not_ready', `Media ${args.media_id} is still importing`, {
          hint: 'Wait for its media.import job to finish',
        });
      }
      const p = record.probe;
      checkSoundArgs(args);
      if (!p?.audio && !['look', 'faces', 'track', 'scenes'].includes(args.kind)) {
        throw noAudio({ label: `media ${mediaId}` }, 'it has no audio stream');
      }
      if (['speech', 'loudness', 'silence'].includes(args.kind)) {
        await checkSound(rt, owner, {
          media_id: mediaId,
          from_seconds: args.from_seconds,
          until_seconds: args.until_seconds,
        });
      }
      const needsPicture = args.kind === 'faces' || args.kind === 'track' || args.kind === 'scenes';
      if (
        args.kind === 'look'
          ? !p?.video
          : needsPicture
            ? !p?.video || p.kind === 'image'
            : !p?.audio
      ) {
        throw new CfError(
          'bad_request',
          `Media ${args.media_id} has no ${args.kind === 'look' ? 'picture' : needsPicture ? 'moving picture' : 'sound'} to analyze`,
        );
      }
      // look: the sample times, checked before any job exists.
      let times: number[] = [];
      if (args.kind === 'look') {
        const sampled = sampleTimes(p?.kind === 'image' ? 0 : (p?.duration ?? 0), args);
        times = sampled.times;
        const asked = sampled.asked;
        await checkQuota(
          rt.ws,
          owner,
          JUDGMENTS,
          asked,
          (await deps.limits?.())?.judgmentsPerDay ?? rt.config.judgmentsPerDay,
          {
            unit: 'judgments (one a frame)',
            hint: 'Sample fewer frames (a larger every_seconds, or at_seconds around the moments you need)',
          },
        );
      }
      if (args.kind === 'track' && !args.region) {
        throw new CfError('bad_request', 'track needs a region: {at_seconds, x, y, w, h}');
      }
      if (args.kind === 'scenes' && args.threshold === undefined) {
        throw new CfError('bad_request', 'scenes needs a threshold (0–100)', {
          hint: 'Lower finds subtler cuts, e.g. {threshold: 10}',
        });
      }
      const admit = await admitJob(deps.limits);
      const job = await store.create({
        owner,
        tool: 'media.analyze',
        meta: { media_id: mediaId, kind: args.kind },
        statusMessage: `${args.kind}: starting`,
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(
        job,
        async ({ signal, progress }) => {
          const file = renderSource(record, 'export');
          const v = p?.video;
          const size = pictureSize(record);
          const keep = (kind: 'transcript' | 'beats' | 'faces' | 'speech', value: unknown) =>
            rt.media.saveAnalysis(owner, mediaId, kind, value);
          switch (args.kind) {
            case 'transcript': {
              const transcript = await transcribe(file, {
                model: args.model,
                modelsDir: rt.modelsDir,
                language: args.language,
                ...(p?.duration ? { duration: p.duration } : {}),
                signal,
                onProgress: (f, m) => progress(f, `transcript: ${m}`),
              });
              const latest = await keep('transcript', transcript);
              return ok({
                media_id: mediaId,
                kind: args.kind,
                summary: mediaInfo(latest).analyses?.transcript,
                ...inline(mediaId, 'transcript', transcript),
              }) as never;
            }
            case 'beats': {
              progress(0.1, 'beats: listening');
              const beats = await analyseBeats(file, signal);
              const latest = await keep('beats', beats);
              return ok({
                media_id: mediaId,
                kind: args.kind,
                summary: mediaInfo(latest).analyses?.beats,
                ...inline(mediaId, 'beats', beats),
              }) as never;
            }
            case 'faces': {
              progress(0.1, 'faces: looking');
              const faces = await detectFaces(file, size, { signal });
              const latest = await keep('faces', faces);
              return ok({
                media_id: mediaId,
                kind: args.kind,
                summary: mediaInfo(latest).analyses?.faces,
                ...inline(mediaId, 'faces', faces),
              }) as never;
            }
            case 'look': {
              const key = await deps.credentials.resolve(owner, 'typesafe');
              if (!key) throw new CfError('credential_required', 'The TypeSafe API key went away');
              const questions = args.questions as NonNullable<typeof args.questions>;
              progress(0.02, `look: taking ${times.length} frames`);
              const stills = await mediaStills(file, size, times, {
                ...PICTURE,
                signal,
                checker: mayBeTransparent(record.probe),
                onFrame: (n) =>
                  progress(0.02 + (0.28 * n) / times.length, `look: frame ${n} of ${times.length}`),
              });
              const frames = await askFrames({
                base: rt.config.typesafeUrl ?? JEV_URL,
                key,
                times,
                stills,
                withPrevious: args.with_previous,
                state: args.state,
                questions,
                signal,
                onFrame: (done, of) =>
                  progress(0.3 + (0.7 * done) / of, `look: asked ${done} of ${of} frames`),
              });
              const run = {
                id: job.id,
                model: JEV_MODEL,
                questions,
                with_previous: args.with_previous,
                ...(args.state ? { state: args.state } : {}),
                frames,
              };
              await rt.media.saveAnalysis(owner, mediaId, 'look', run);
              await addUsage(rt.ws, owner, JUDGMENTS, job.id, frames.length);
              return ok({
                media_id: mediaId,
                kind: args.kind,
                model: JEV_MODEL,
                frames: frames.length,
                summary: lookDigest(questions, frames),
                ...inline(mediaId, 'look', run),
              }) as never;
            }
            case 'track': {
              progress(0.1, 'track: following');
              const region = args.region as NonNullable<typeof args.region>;
              const fps = v?.fps ? Math.min(30, v.fps.num / v.fps.den) : 25;
              const points = await trackRegion(file, size, {
                start: region.at_seconds,
                box: { x: region.x, y: region.y, w: region.w, h: region.h },
                ...(args.until_seconds !== undefined ? { until: args.until_seconds } : {}),
                rate: fps,
                signal,
              });
              return ok({
                media_id: mediaId,
                kind: args.kind,
                track: { rate: fps, points },
              }) as never;
            }
            case 'speech':
            case 'loudness':
            case 'silence': {
              // Whole-media speech is kept with the media and read back for any range.
              const kept = record.analyses?.speech;
              const stored =
                args.kind === 'speech' && kept?.model === SPEECH_MODELS.vad.name ? kept : undefined;
              const whole = args.from_seconds === undefined && args.until_seconds === undefined;
              const { result, speech } = await withSound(
                rt,
                owner,
                {
                  media_id: mediaId,
                  from_seconds: args.from_seconds,
                  until_seconds: args.until_seconds,
                },
                { signal },
                (sound) => measureSound(sound, args, signal, progress, stored),
              );
              if (speech && whole) await keep('speech', speech);
              return ok({
                media_id: mediaId,
                kind: args.kind,
                ...inlineSpeech(result, mediaId),
              }) as never;
            }
            case 'sounds': {
              progress(0.02, 'sounds: listening');
              const scores = await detectSounds(file, {
                signal,
                onProgress: (f) => progress(0.02 + 0.93 * f, 'sounds: listening'),
              });
              const { stored, result } = soundsReport(scores, {
                model: SOUND_MODELS.sounds,
                min: args.min_probability as number,
                ...(soundColumns ? { columns: soundColumns } : {}),
              });
              const latest = await rt.media.saveAnalysis(owner, mediaId, 'sounds', stored);
              return ok({
                media_id: mediaId,
                kind: args.kind,
                summary: mediaInfo(latest).analyses?.sounds,
                sounds: result,
              }) as never;
            }
            case 'scenes': {
              progress(0.1, 'scenes: looking');
              const scenes = await detectScenes(file, {
                threshold: args.threshold as number,
                signal,
              });
              return ok({ media_id: mediaId, kind: args.kind, scenes }) as never;
            }
          }
        },
        admit,
      );
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'media.correlate',
    {
      title: 'Sync offset',
      description: [
        "Find how far one recording sits from another: the sync offset of b against a, by cross-correlating their sound, with how strongly they match. Use it to line up a camera with a separate microphone, two cameras of the same moment, or a re-recorded line against the original. Each side is imported media or an edit's mix (timeline_id), over its own from_seconds to until_seconds, so you can match a short stretch of b against a longer stretch of a.",
        `offset_seconds: b's moment t lines up with a's moment t + offset_seconds, each in its own seconds. To line them up on a timeline, place b's clip so it starts offset_seconds later than a's (earlier when negative), source starts being equal. strength is the correlation of the overlapping sound at that offset, -1 to 1: near 1 the same sound, near 0 unrelated; next_best is the best offset outside the winning peak, and a strength close to it means the match is unclear (repetitive sound, or not the same moment). Offsets are searched up to max_offset_seconds either way, where at least half of the shorter sound overlaps the other. Up to ${CORRELATE_LIMITS.maxSeconds} s read from each side.`,
        'A side with no sound in its range (no audio stream, a range past its end, or digital silence) fails with no_audio, naming which side. Short reads answer at once; longer ones return a task or job.',
      ].join('\n'),
      inputSchema: MediaCorrelateInput,
      outputSchema: withJob(MediaCorrelateResult),
      annotations: {
        title: 'Sync offset',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.correlate', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      const sides = { a: args.a, b: args.b };
      let longest = 0;
      for (const [name, ref] of Object.entries(sides)) {
        const { seconds } = await checkSound(rt, owner, ref, name);
        if (seconds > CORRELATE_LIMITS.maxSeconds) {
          throw new CfError(
            'limit_exceeded',
            `${name} reads ${Math.round(seconds)} s of sound; media.correlate reads up to ${CORRELATE_LIMITS.maxSeconds} s a side`,
            { hint: `Give ${name} a from_seconds and until_seconds around the moment to match` },
          );
        }
        longest = Math.max(longest, seconds);
      }
      const work = async ({ signal, progress }: JobContext) => {
        progress(0.05, 'reading a');
        const found = await withSound(rt, owner, args.a, { name: 'a', signal }, (a) =>
          withSound(rt, owner, args.b, { name: 'b', signal }, async (b) => {
            progress(0.4, 'correlating');
            const range = (s: Sound) => ({
              file: s.file,
              label: s.label,
              ...(s.from !== undefined ? { from: s.from } : {}),
              ...(s.until !== undefined ? { until: s.until } : {}),
            });
            const out = await soundOffset(range(a), range(b), {
              maxSeconds: args.max_offset_seconds,
              signal,
            });
            // Back to each source's own clock (a timeline's mix starts at its range).
            const shift = a.shift - b.shift;
            const r = (x: number) => Math.round(x * 1e4) / 1e4;
            return {
              ...out,
              offset_seconds: r(out.offset_seconds + shift),
              next_best: out.next_best
                ? { ...out.next_best, offset_seconds: r(out.next_best.offset_seconds + shift) }
                : null,
            };
          }),
        );
        return ok(found);
      };
      if (longest <= CORRELATE_INLINE_SECONDS && !args.a.timeline_id && !args.b.timeline_id) {
        const signal =
          (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal ??
          new AbortController().signal;
        return work({ signal, progress: () => undefined, status: () => undefined });
      }
      const admit = await admitJob(deps.limits);
      const job = await store.create({
        owner,
        tool: 'media.correlate',
        statusMessage: 'starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(job, work as never, admit);
      return jobReply(job, ctx);
    }),
  );

  server.registerTool(
    'media.get',
    {
      title: 'Get media',
      description: [
        'Status, where it came from (origin: the import source, the export of which timeline_id and preset, or the create.* tool and the media it was made from), a signed download url for the file (media is kept 7 days after last use: save the file from it to keep it, and media.import it again later) and a page_url that plays or shows it in any browser (to give a person), its format (extension and mime_type, read from the file, not its name), everything the probe read (probe: the format and every stream, e.g. pix_fmt, colour space, primaries, transfer), duration, frame rate, conform reasons, integrated loudness and summaries of media.analyze results under analyses (counts only: analyses.transcript.words is how many words).',
        'include returns those results at the top level, e.g. include ["transcript"] gives transcript.words, the list of words with times. For long media, read them in pieces: from_seconds and to_seconds keep what overlaps that stretch of the media, offset and limit page through what is left, and pages says, per analysis, the index of the first item returned in the whole list (for transcript words, the index clip.add source {words} takes), how many matched and next_offset for the next page (null at the end).',
      ].join(' '),
      inputSchema: MediaRefInput,
      outputSchema: MediaInfo,
      _meta: PLAYER_TOOL_META,
      annotations: {
        title: 'Get media',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const owner = deps.owner();
      if (
        args.from_seconds !== undefined &&
        args.to_seconds !== undefined &&
        args.to_seconds <= args.from_seconds
      ) {
        throw new CfError('bad_request', 'to_seconds must be after from_seconds');
      }
      const record = await rt.media.get(owner, args.media_id);
      const link = await rt.signMedia(owner, record);
      const info = mediaInfo(record, args.include ?? [], { probe: true });
      const windowed =
        args.from_seconds !== undefined ||
        args.to_seconds !== undefined ||
        args.offset > 0 ||
        args.limit !== undefined;
      return ok({
        ...info,
        ...(windowed
          ? paged(info, {
              offset: args.offset,
              ...(args.from_seconds !== undefined ? { from: args.from_seconds } : {}),
              ...(args.to_seconds !== undefined ? { to: args.to_seconds } : {}),
              ...(args.limit !== undefined ? { limit: args.limit } : {}),
            })
          : {}),
        ...(link ? { url: link.url, page_url: link.pageUrl, expires_at: link.expiresAt } : {}),
      });
    }),
  );
}

/** Starts the import job that ingests a media record whose file is in place (or downloads). */
async function startIngest(
  rt: ServerDeps['runtime'],
  owner: string,
  record: MediaRecord,
  admit: Awaited<ReturnType<typeof admitJob>>,
  options: { room?: number; idempotencyKey?: string } = {},
): Promise<Job> {
  const { room } = options;
  const job = await rt.jobs.store.create({
    owner,
    tool: 'media.import',
    meta: { media_id: record.media_id },
    statusMessage: `importing ${record.media_id}`,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  });
  rt.jobs.start(
    job,
    async ({ signal, progress }) => {
      const done = await rt.media.ingest(
        owner,
        record,
        (f, m) => progress(f, `${record.media_id}: ${m}`),
        signal,
        room === undefined
          ? {}
          : {
              maxBytes: room,
              tooBigHint:
                "That is more than the account's storage has left. Files expire on their own (uploads after a day, media and exports 7 days after last use); media.list shows what is held and media.delete frees room",
            },
      );
      return ok(mediaInfo(done)) as never;
    },
    admit,
  );
  return job;
}

/**
 * After the PUT that completes an upload media.import made (source {upload}): moves the file
 * into its media and starts the import. Undefined for any other upload. `key` is the owner key
 * the upload URL names.
 */
export async function importSent(
  rt: ServerDeps['runtime'],
  key: string,
  uploadId: string,
): Promise<{ media_id: string; job_id: string } | undefined> {
  const sent = await rt.uploads.sent(key, uploadId);
  if (!sent) return undefined;
  const record = await rt.media.get(sent.owner, sent.media_id);
  record.file = await rt.media.adopt(sent.owner, record, sent.file, { move: true });
  await rt.media.save(sent.owner, record);
  await rt.uploads.remove(sent.owner, uploadId);
  const job = await startIngest(
    rt,
    sent.owner,
    record,
    sent.owner_limit === undefined ? {} : { ownerLimit: sent.owner_limit },
  );
  return { media_id: record.media_id, job_id: job.id };
}

/** A file name as one shell word, for the example command. */
function shellQuote(name: string): string {
  return /^[\w.@%+=:,/-]+$/.test(name) ? name : `'${name.replace(/'/g, "'\\''")}'`;
}

/** The MIME type a data: URI declares, or '' for none. */
function dataUriType(uri: string): string {
  return /^data:([^;,]*)/i.exec(uri)?.[1]?.toLowerCase() ?? '';
}

/** A data: URI's bytes (RFC 2397), checked against the SHA-256 the caller gave. */
function decodeDataUri(uri: string, sha256: string | undefined): Buffer {
  const m = /^data:[^,]*?(;base64)?,(.*)$/is.exec(uri);
  if (!m) {
    throw new CfError('bad_request', 'data must be a data: URI', {
      hint: 'data:<type>;base64,<the file in base64>, e.g. data:image/png;base64,iVBORw0…',
    });
  }
  const body = m[2] ?? '';
  let bytes: Buffer;
  if (m[1]) {
    const clean = body.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) {
      throw new CfError('bad_request', 'The base64 in data has characters base64 never uses', {
        hint: 'Send the file again, base64-encoded exactly; for anything long, media.upload is safer',
      });
    }
    bytes = Buffer.from(clean, 'base64');
  } else {
    bytes = Buffer.from(decodeURIComponent(body), 'utf8');
  }
  if (!bytes.length) throw new CfError('bad_request', 'data holds no bytes');
  if (bytes.length > MEDIA_LIMITS.inlineBytes) {
    throw new CfError(
      'limit_exceeded',
      `data holds ${bytes.length} bytes; a data: URI takes up to ${MEDIA_LIMITS.inlineBytes}`,
      { hint: 'Send it with media.upload instead' },
    );
  }
  if (sha256) {
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== sha256) {
      throw new CfError(
        'bad_request',
        `data decodes to a file with SHA-256 ${got}, not ${sha256}`,
        {
          hint: 'The copy was changed on the way; send it again, or use media.upload for the file itself',
        },
      );
    }
  }
  return bytes;
}

/** A file extension for a MIME type, so the stored file reads as what it is. */
function extensionFor(type: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'font/ttf': '.ttf',
    'font/otf': '.otf',
    'text/plain': '.txt',
  };
  return known[type] ?? '';
}
