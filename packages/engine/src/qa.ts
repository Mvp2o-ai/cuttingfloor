import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { span as sourceSpan, ticksPerFrame } from '@cuttingfloor/core';
import { CfError, QA_CUTS_LIMIT, TICKS_PER_SECOND, type TimelineDoc } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { lengthFrames, type MltSource, scaledSize, writeMltProject } from './mlt.ts';
import { countFrames } from './render.ts';
import { type SpeechProbabilities, speechProbabilities } from './speech.ts';
import type { TranscriptWord } from './transcribe.ts';

interface Span {
  start: number;
  end: number;
}
export interface QaReport {
  range: Span;
  /** Frames with no enabled clip on any visible video track. */
  gaps: Span[];
  offline_media: string[];
  /** null when offline media stopped the render. */
  frames: { expected: number; rendered: number } | null;
  /** Only when black settings were given. */
  black?: Span[];
  /** Only when silence settings were given. */
  silences?: Span[];
  integrated_lufs: number | null;
  true_peak_dbtp: number | null;
  /** Only when speech settings were given: facts about every cut. */
  cuts?: CutFact[];
  cuts_total?: number;
}

/** The word a clip edge cuts through, in media seconds. */
export interface CutWord {
  text: string;
  start: number;
  end: number;
  /** Where the edge is in the media. */
  at: number;
  /** Seconds of the word that don't play: after the edge for an out, before it for an in. */
  seconds_cut: number;
}

export interface CutFact {
  frame: number;
  seconds: number;
  /** Silero VAD speech probability of the mix just before and just after the cut. */
  speech_before: number;
  speech_after: number;
  /** Both at or above min_probability: speech runs straight through the cut. */
  in_speech: boolean;
  /** Seconds with the speech probability under min_probability, back and on from the cut. */
  silence_before_seconds: number;
  silence_after_seconds: number;
  /** The clip edges at this frame, per track, with any transcript word they cut through. */
  edges: Array<{
    track_id: string;
    out_clip_id: string | null;
    in_clip_id: string | null;
    out_word: CutWord | null;
    in_word: CutWord | null;
  }>;
}

export interface QaOptions {
  range?: Span;
  /** A pixel at or under pixelThreshold (0–1) is black; a frame with pictureShare of them is. */
  black?: { pixelThreshold: number; pictureShare: number; minSeconds: number };
  silence?: { thresholdDb: number; minSeconds: number };
  /** Cut facts: speech is a VAD probability at or above minProbability; words per media id. */
  speech?: { minProbability: number; words: Map<string, TranscriptWord[]> };
  signal?: AbortSignal;
  onProgress?: (f: number) => void;
}

/**
 * Measures the rendered timeline: gaps, offline media, the rendered frame count, integrated
 * loudness and true peak, and black or silent stretches with the caller's settings. Facts only:
 * what is wrong is the caller's call. Renders a small pass with melt, then measures it.
 */
export async function qaCheck(
  doc: TimelineDoc,
  sources: Map<string, MltSource>,
  offline: string[],
  options: QaOptions,
): Promise<QaReport> {
  const length = lengthFrames(doc);
  if (!length)
    throw new CfError('bad_request', 'The timeline is empty', {
      hint: 'Add clips with clip.add first',
    });
  const range = options.range ?? { start: 0, end: length };
  if (range.end <= range.start || range.end > length) {
    throw new CfError(
      'bad_request',
      `Range ${range.start}-${range.end} is not inside the timeline (0-${length})`,
    );
  }
  const fps = doc.sequence.fps;
  const toFrame = (seconds: number) => range.start + Math.round((seconds * fps.num) / fps.den);

  const tpf = ticksPerFrame(fps);
  const covered: Array<[number, number]> = doc.tracks
    .filter((t) => t.kind === 'video' && !t.hidden)
    .flatMap((t) =>
      t.clips
        .filter((c) => c.enabled)
        .map(
          (c) =>
            [Math.round(c.start / tpf), Math.round((c.start + c.duration) / tpf)] as [
              number,
              number,
            ],
        ),
    )
    .sort((a, b) => a[0] - b[0]);
  const gaps: Span[] = [];
  let cursor = range.start;
  for (const [s, e] of covered) {
    if (e <= cursor) continue;
    if (s > cursor && s < range.end) gaps.push({ start: cursor, end: Math.min(s, range.end) });
    cursor = Math.max(cursor, e);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end && doc.tracks.some((t) => t.kind === 'video'))
    gaps.push({ start: cursor, end: range.end });
  const report: QaReport = {
    range,
    gaps,
    offline_media: offline,
    frames: null,
    integrated_lufs: null,
    true_peak_dbtp: null,
  };
  if (offline.length) return report;

  const dir = await mkdtemp(join(tmpdir(), 'cf-qa-'));
  try {
    const size = scaledSize(doc.sequence.width, doc.sequence.height, 320);
    const project = await writeMltProject(dir, doc, { ...size, sources, range });
    const total = range.end - range.start;
    await run(
      BIN.melt,
      [
        '-silent',
        '-progress',
        ...project,
        '-consumer',
        'avformat:qa.mkv',
        'vcodec=mjpeg',
        'qscale=5',
        'acodec=pcm_s16le',
        `frequency=${doc.sequence.audio_rate}`,
        `channels=${doc.sequence.channels}`,
        `width=${size.width}`,
        `height=${size.height}`,
        'real_time=-1',
        'progressive=1',
      ],
      {
        cwd: dir,
        heavy: true,
        ...(options.signal ? { signal: options.signal } : {}),
        onLine: (line) => {
          const m = /Current Frame:\s+(\d+)/.exec(line);
          if (m) options.onProgress?.(Math.min(0.8, (0.8 * Number(m[1])) / total));
        },
      },
    );
    report.frames = { expected: total, rendered: await countFrames(join(dir, 'qa.mkv')) };
    options.onProgress?.(0.85);
    const b = options.black;
    const q = options.silence;
    const { stderr } = await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        'qa.mkv',
        ...(b
          ? [
              '-vf',
              `blackdetect=d=${b.minSeconds}:pix_th=${b.pixelThreshold}:pic_th=${b.pictureShare}`,
            ]
          : ['-vn']),
        '-af',
        [
          ...(q ? [`silencedetect=n=${q.thresholdDb}dB:d=${q.minSeconds}`] : []),
          'ebur128=peak=true:framelog=quiet',
        ].join(','),
        '-f',
        'null',
        '-',
      ],
      { cwd: dir, ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (b) {
      report.black = [];
      for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
        // Gaps are their own fact; a black span is only the part that has a picture.
        for (const [s, e] of subtract([toFrame(Number(m[1])), toFrame(Number(m[2]))], gaps)) {
          report.black.push({ start: s, end: e });
        }
      }
    }
    if (q) {
      report.silences = [];
      let open: number | null = null;
      for (const line of stderr.split('\n')) {
        const s = /silence_start: (-?[\d.]+)/.exec(line);
        const e = /silence_end: (-?[\d.]+)/.exec(line);
        if (s) open = Math.max(0, Number(s[1]));
        if (e && open !== null) {
          report.silences.push({ start: toFrame(open), end: toFrame(Number(e[1])) });
          open = null;
        }
      }
      if (open !== null) report.silences.push({ start: toFrame(open), end: range.end });
    }
    // EBU R128: below its -70 LUFS absolute gate there is no integrated loudness.
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const lufsMatch = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
    const peakMatch = /Peak:\s+(-?[\d.inf]+) dBFS/.exec(summary);
    report.integrated_lufs = lufsMatch && Number(lufsMatch[1]) > -70 ? Number(lufsMatch[1]) : null;
    report.true_peak_dbtp =
      peakMatch && Number.isFinite(Number(peakMatch[1])) ? Number(peakMatch[1]) : null;
    if (options.speech) {
      options.onProgress?.(0.9);
      const probs = await speechProbabilities(join(dir, 'qa.mkv'), {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const all = cutFacts(doc, range, probs, options.speech.minProbability, options.speech.words);
      report.cuts = all.slice(0, QA_CUTS_LIMIT);
      report.cuts_total = all.length;
    }
    options.onProgress?.(1);
    return report;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The parts of [start, end) not covered by any of `holes`. */
function subtract(span: [number, number], holes: Span[]): Array<[number, number]> {
  let parts: Array<[number, number]> = [span];
  for (const h of holes) {
    parts = parts.flatMap(([s, e]): Array<[number, number]> => {
      if (h.end <= s || h.start >= e) return [[s, e]];
      const out: Array<[number, number]> = [];
      if (h.start > s) out.push([s, h.start]);
      if (h.end < e) out.push([h.end, e]);
      return out;
    });
  }
  return parts.filter(([s, e]) => e > s);
}

type MediaClip = Extract<TimelineDoc['tracks'][number]['clips'][number], { type: 'media' }>;

/**
 * Facts about each cut in the range: the frames where a media clip starts or ends on any track
 * (inside the range, not at its edges), the mix's speech either side from `probs` (measured from
 * the range start), and the transcript words each clip edge cuts through.
 */
export function cutFacts(
  doc: TimelineDoc,
  range: Span,
  probs: Pick<SpeechProbabilities, 'frame_seconds' | 'probabilities'>,
  minProbability: number,
  words: Map<string, TranscriptWord[]>,
): CutFact[] {
  const fps = doc.sequence.fps;
  const tpf = ticksPerFrame(fps);
  const edges = new Map<number, CutFact['edges']>();
  for (const track of doc.tracks) {
    const at = new Map<number, { out?: MediaClip; in?: MediaClip }>();
    for (const clip of track.clips) {
      if (clip.type !== 'media' || !clip.enabled) continue;
      const a = Math.round(clip.start / tpf);
      const b = Math.round((clip.start + clip.duration) / tpf);
      if (a > range.start && a < range.end) at.set(a, { ...at.get(a), in: clip });
      if (b > range.start && b < range.end) at.set(b, { ...at.get(b), out: clip });
    }
    for (const [frame, pair] of at) {
      const list = edges.get(frame) ?? [];
      list.push({
        track_id: track.id,
        out_clip_id: pair.out?.id ?? null,
        in_clip_id: pair.in?.id ?? null,
        out_word: pair.out ? edgeWord(pair.out, 'out', words) : null,
        in_word: pair.in ? edgeWord(pair.in, 'in', words) : null,
      });
      edges.set(frame, list);
    }
  }
  const p = probs.probabilities;
  const fs = probs.frame_seconds;
  const total = ((range.end - range.start) * fps.den) / fps.num;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return [...edges.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, list]) => {
      const t = ((frame - range.start) * fps.den) / fps.num;
      const i = Math.min(p.length, Math.round(t / fs));
      const before = p[i - 1] ?? 0;
      const after = p[i] ?? 0;
      let k = i - 1;
      while (k >= 0 && (p[k] as number) < minProbability) k--;
      const silenceBefore = k >= 0 ? Math.max(0, t - (k + 1) * fs) : t;
      let m = i;
      while (m < p.length && (p[m] as number) < minProbability) m++;
      const silenceAfter = m < p.length ? Math.max(0, m * fs - t) : total - t;
      return {
        frame,
        seconds: round((frame * fps.den) / fps.num),
        speech_before: before,
        speech_after: after,
        in_speech: before >= minProbability && after >= minProbability,
        silence_before_seconds: round(silenceBefore),
        silence_after_seconds: round(Math.max(0, silenceAfter)),
        edges: list,
      };
    });
}

/** The transcript word a clip's in or out point lands inside, if its media has a transcript. */
function edgeWord(
  clip: MediaClip,
  edge: 'in' | 'out',
  words: Map<string, TranscriptWord[]>,
): CutWord | null {
  const list = words.get(clip.media_id);
  if (!list?.length) return null;
  const reverse = Boolean(clip.speed?.reverse);
  const first = clip.in;
  const last = clip.in + sourceSpan(clip);
  // Forward, the clip starts at `in` and ends at in + span; reversed, the other way round.
  const ticks = (edge === 'in') !== reverse ? first : last;
  const at = ticks / TICKS_PER_SECOND;
  const w = list.find((x) => x.start < at && at < x.end);
  if (!w) return null;
  // An out plays the part of the word before the edge; an in, the part after it.
  const forwardOut = (edge === 'out') !== reverse;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    text: w.text,
    start: w.start,
    end: w.end,
    at: round(at),
    seconds_cut: round(forwardOut ? w.end - at : at - w.start),
  };
}
