import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ticksPerFrame } from '@cuttingfloor/core';
import { CfError, type TimelineDoc } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { lengthFrames, type MltSource, scaledSize, writeMltProject } from './mlt.ts';
import { countFrames } from './render.ts';

type Status = 'pass' | 'fail' | 'warn';
interface Finding {
  start: number;
  end: number;
  detail: string;
}
export interface QaReport {
  passed: boolean;
  checks: Array<{
    check: 'gaps' | 'offline_media' | 'black_frames' | 'silence' | 'loudness' | 'frame_count';
    status: Status;
    findings: Finding[];
  }>;
  measured: { frames: number; integrated_lufs: number | null; true_peak_dbtp: number | null };
}

/**
 * Exact checks, all code: gaps in the picture, offline media, black frames, silence, loudness
 * against a target, and the rendered frame count. Renders a small analysis pass with melt
 * from the proxies, then measures it with FFmpeg.
 */
export async function qaCheck(
  doc: TimelineDoc,
  sources: Map<string, MltSource>,
  offline: string[],
  options: {
    range?: { start: number; end: number };
    targetLufs: number;
    signal?: AbortSignal;
    onProgress?: (f: number) => void;
  },
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
  const checks: QaReport['checks'] = [];

  // Gaps: frames with no enabled clip on any visible video track.
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
  const gaps: Finding[] = [];
  let cursor = range.start;
  for (const [s, e] of covered) {
    if (e <= cursor) continue;
    if (s > cursor && s < range.end)
      gaps.push({ start: cursor, end: Math.min(s, range.end), detail: 'no picture' });
    cursor = Math.max(cursor, e);
    if (cursor >= range.end) break;
  }
  if (cursor < range.end && doc.tracks.some((t) => t.kind === 'video'))
    gaps.push({ start: cursor, end: range.end, detail: 'no picture' });
  checks.push({ check: 'gaps', status: gaps.length ? 'fail' : 'pass', findings: gaps });
  checks.push({
    check: 'offline_media',
    status: offline.length ? 'fail' : 'pass',
    findings: offline.map((id) => ({
      start: range.start,
      end: range.end,
      detail: `media ${id} is offline`,
    })),
  });
  if (offline.length) {
    return {
      passed: false,
      checks,
      measured: { frames: 0, integrated_lufs: null, true_peak_dbtp: null },
    };
  }

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
        ...(options.signal ? { signal: options.signal } : {}),
        onLine: (line) => {
          const m = /Current Frame:\s+(\d+)/.exec(line);
          if (m) options.onProgress?.(Math.min(0.8, (0.8 * Number(m[1])) / total));
        },
      },
    );
    const frames = await countFrames(join(dir, 'qa.mkv'));
    checks.push({
      check: 'frame_count',
      status: frames === total ? 'pass' : 'fail',
      findings:
        frames === total
          ? []
          : [
              {
                start: range.start,
                end: range.end,
                detail: `rendered ${frames} frames, expected ${total}`,
              },
            ],
    });
    options.onProgress?.(0.85);
    const { stderr } = await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        'qa.mkv',
        '-vf',
        'blackdetect=d=0.5:pix_th=0.10',
        '-af',
        'silencedetect=n=-50dB:d=1,ebur128=peak=true:framelog=quiet',
        '-f',
        'null',
        '-',
      ],
      { cwd: dir, ...(options.signal ? { signal: options.signal } : {}) },
    );
    const black: Finding[] = [];
    for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
      // Gaps are reported on their own; a black span is only the part that has a picture.
      for (const [s, e] of subtract([toFrame(Number(m[1])), toFrame(Number(m[2]))], gaps)) {
        black.push({ start: s, end: e, detail: 'black picture' });
      }
    }
    checks.push({ check: 'black_frames', status: black.length ? 'warn' : 'pass', findings: black });
    const silence: Finding[] = [];
    let open: number | null = null;
    for (const line of stderr.split('\n')) {
      const s = /silence_start: (-?[\d.]+)/.exec(line);
      const e = /silence_end: (-?[\d.]+)/.exec(line);
      if (s) open = Math.max(0, Number(s[1]));
      if (e && open !== null) {
        silence.push({
          start: toFrame(open),
          end: toFrame(Number(e[1])),
          detail: 'silence below -50 dBFS',
        });
        open = null;
      }
    }
    if (open !== null)
      silence.push({ start: toFrame(open), end: range.end, detail: 'silence below -50 dBFS' });
    checks.push({ check: 'silence', status: silence.length ? 'warn' : 'pass', findings: silence });
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const lufsMatch = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
    const peakMatch = /Peak:\s+(-?[\d.inf]+) dBFS/.exec(summary);
    const lufs = lufsMatch && Number(lufsMatch[1]) > -70 ? Number(lufsMatch[1]) : null;
    const peak = peakMatch && Number.isFinite(Number(peakMatch[1])) ? Number(peakMatch[1]) : null;
    const loudness: Finding[] = [];
    if (lufs === null)
      loudness.push({ start: range.start, end: range.end, detail: 'no measurable audio' });
    else if (Math.abs(lufs - options.targetLufs) > 2) {
      loudness.push({
        start: range.start,
        end: range.end,
        detail: `integrated ${lufs.toFixed(1)} LUFS, target ${options.targetLufs} ±2`,
      });
    }
    if (peak !== null && peak > -1)
      loudness.push({
        start: range.start,
        end: range.end,
        detail: `true peak ${peak.toFixed(1)} dBTP is above -1`,
      });
    checks.push({
      check: 'loudness',
      status: loudness.length ? 'warn' : 'pass',
      findings: loudness,
    });
    options.onProgress?.(1);
    return {
      passed: checks.every((c) => c.status !== 'fail'),
      checks,
      measured: { frames, integrated_lufs: lufs, true_peak_dbtp: peak },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The parts of [start, end) not covered by any of `holes`. */
function subtract(span: [number, number], holes: Finding[]): Array<[number, number]> {
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
