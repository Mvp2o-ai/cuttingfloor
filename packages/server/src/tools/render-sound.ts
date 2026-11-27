import { createHash } from 'node:crypto';
import { beatsToSeconds, secondsToBeats } from '@cuttingfloor/core';
import {
  CYCLES,
  drawPianoRoll,
  encodePng,
  FLOOR_DB,
  type Grid,
  HIGH_PITCH,
  hex,
  LOW_PITCH,
  noteName,
  partColour,
  pitchHz,
  playedNotes,
  renderSpectrogram,
  type SoundLayout,
  scoreEndBeats,
  scoreGrid,
  spectrogramPad,
  windowSeconds,
} from '@cuttingfloor/engine';
import {
  CfError,
  RenderNotesInput,
  RenderNotesResult,
  RenderSpectrogramInput,
  RenderSpectrogramResult,
  type ScoreDoc,
  SOUND_PICTURE_LIMITS,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { checkSound } from '../sound.ts';

// render.spectrogram and render.notes: pictures of sound on one pair of axes (engine
// sound-axes.ts), so a spectrogram of a score's sound and the piano roll of its notes line up
// row for row and, over the same seconds, pixel for pixel.

/** The score store: a score document by id. Wired where the store lives; absent, scores are refused. */
export type LoadScore = (owner: string, scoreId: string) => Promise<ScoreDoc>;

/**
 * A score's sound over a range of score seconds, rendered to a WAV whose first sample is at
 * `from_seconds`, with the document it was rendered from. `done` (when given) is called once the
 * file has been read, to remove it.
 */
export type RenderScoreSound = (
  owner: string,
  scoreId: string,
  range: { from_seconds: number; until_seconds: number },
  signal?: AbortSignal,
) => Promise<{ wav: string; doc: ScoreDoc; done?: () => Promise<void> }>;

const MAX = SOUND_PICTURE_LIMITS.seconds;
const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Scores are not on this server yet: the store or the score's sound is not wired. */
function notWired(): CfError {
  return new CfError('service_unavailable', 'Scores are not available on this server yet', {
    hint: 'render.spectrogram draws media (media_id) without a score',
  });
}

/** What a picture covers, in the result's words. */
function axes(l: SoundLayout) {
  return {
    seconds_per_pixel: round((l.until - l.from) / l.plotWidth, 6),
    plot: { left: l.left, top: l.top, width: l.plotWidth, height: l.plotHeight },
    pitch: {
      lowest: noteName(LOW_PITCH),
      highest: noteName(HIGH_PITCH),
      lowest_midi: LOW_PITCH,
      highest_midi: HIGH_PITCH,
      lowest_hz: round(pitchHz(LOW_PITCH), 2),
      highest_hz: round(pitchHz(HIGH_PITCH), 1),
      row_pixels: l.rowPx,
    },
  };
}

/** The beat grid of a tempo on media: beats from first_bar_seconds on, bars when their length is given. */
export function tempoGrid(
  tempo: number,
  first: number,
  beatsPerBar: number | undefined,
  from: number,
  until: number,
): Grid {
  const period = 60 / tempo;
  const beats: number[] = [];
  const bars: Grid['bars'] = [];
  const k0 = Math.max(0, Math.ceil((from - first) / period - 1e-9));
  for (let k = k0; first + k * period < until - 1e-9; k++) {
    const t = round(first + k * period, 6);
    beats.push(t);
    if (beatsPerBar && k % beatsPerBar === 0) bars.push({ bar: k / beatsPerBar + 1, seconds: t });
  }
  return { beats, bars };
}

const ANALYSIS = `Constant-Q: each semitone row measured with Blackman windows ${CYCLES} periods of its own pitch long (three a third of a semitone apart, the loudest kept), so low rows resolve pitch and high rows resolve time; a column is the mean power over its time. Levels in dBFS, mono mix. A pure tone also lights the rows beside it about 30 dB down, and two rows away about 65 dB down.`;

export function registerRenderSoundTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };

  /** The image inline and kept under outputs/ for its signed link. */
  const keep = async (
    owner: string,
    key: string,
    name: string,
    png: Buffer,
    width: number,
    height: number,
  ) => {
    const dir = `f_${createHash('sha256').update(key).digest('hex').slice(0, 26)}`;
    await rt.outputs.write(owner, dir, name, png, 'frames');
    const { url, expiresAt } = await rt.signOutput(owner, dir, name);
    return {
      image: {
        url,
        expires_at: expiresAt,
        mime_type: 'image/png',
        bytes: png.length,
        width,
        height,
      },
      content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }],
    };
  };

  const loadScore = async (owner: string, scoreId: string): Promise<ScoreDoc> => {
    if (!deps.loadScore) throw notWired();
    return deps.loadScore(owner, scoreId);
  };

  server.registerTool(
    'render.spectrogram',
    {
      title: 'Render spectrogram',
      description: `Look at sound: a spectrogram of media or of a score as an image, time left to right, pitch bottom to top on a musical scale with note names up the side, brighter is louder. With a score_id, or a tempo you give, bar and beat lines are drawn. Up to ${MAX} s an image. Low notes sit at the bottom, a voice in the middle, hiss and cymbals at the top; a held note is a level line, a hit is a vertical one. Comes inline and with a signed download url.
One row per semitone from C1 (32.7 Hz) to B9 (15.8 kHz), A4 = 440 Hz; brightness is the level in dBFS from ${FLOOR_DB} dB (black) to 0 (a full-scale sine), the same scale on every picture. Low rows trade time detail for pitch (a window of ${round(windowSeconds(36), 2)} s at C2, ${round(windowSeconds(60), 2)} s at C4, ${round(windowSeconds(96) * 1000)} ms at C7); the result gives each octave's window, the plot's pixel box, and where each bar line is. Drawn on the same axes as render.notes.`,
      inputSchema: RenderSpectrogramInput,
      outputSchema: RenderSpectrogramResult,
      annotations: { ...readOnly, title: 'Render spectrogram' },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const signal = (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal;
      const from = args.from_seconds;
      const tooLong = (until: number) =>
        new CfError(
          'limit_exceeded',
          `${round(from, 3)} s to ${round(until, 3)} s is ${round(until - from, 3)} s; a spectrogram covers up to ${MAX} s`,
          { hint: `Split it into ranges of up to ${MAX} s`, detail: { limit_seconds: MAX } },
        );
      if (args.until_seconds !== undefined && args.until_seconds - from > MAX + 1e-9) {
        throw tooLong(args.until_seconds);
      }
      const shared = {
        from_seconds: from,
        long_edge: args.long_edge,
      };
      if (args.media_id) {
        if (
          (args.first_bar_seconds !== undefined || args.beats_per_bar !== undefined) &&
          args.tempo === undefined
        ) {
          throw new CfError(
            'bad_request',
            'first_bar_seconds and beats_per_bar draw bars only with tempo',
            {
              hint: 'Give tempo (beats per minute) with them',
            },
          );
        }
        const { plan } = await checkSound(rt, owner, {
          media_id: args.media_id,
          from_seconds: from,
          ...(args.until_seconds !== undefined ? { until_seconds: args.until_seconds } : {}),
        });
        if (plan.kind !== 'media') throw new CfError('bad_request', 'Not media');
        const duration = plan.sound.duration ?? from + MAX;
        const until = Math.min(args.until_seconds ?? from + MAX, duration);
        const grid =
          args.tempo !== undefined
            ? tempoGrid(args.tempo, args.first_bar_seconds ?? 0, args.beats_per_bar, from, until)
            : null;
        const picture = await renderSpectrogram(
          plan.sound.file,
          { start: 0, from, until, longEdge: args.long_edge, grid },
          signal,
        );
        const key = JSON.stringify({
          tool: 'spectrogram',
          media: args.media_id,
          ...shared,
          until,
          grid,
        });
        const name = `spectrogram-${args.media_id}-${round(from, 2)}-${round(until, 2)}.png`;
        const { image, content } = await keep(
          owner,
          key,
          name,
          picture.png,
          picture.width,
          picture.height,
        );
        return ok(
          spectrogramResult({ media_id: args.media_id }, image, picture, from, until, (b) => b),
          content,
        );
      }
      // A score: its own tempo and meter draw the bars.
      const scoreId = args.score_id as string;
      if (
        args.tempo !== undefined ||
        args.first_bar_seconds !== undefined ||
        args.beats_per_bar !== undefined
      ) {
        throw new CfError('bad_request', "A score's bars come from its own tempo and meter", {
          hint: 'Leave out tempo, first_bar_seconds and beats_per_bar with score_id',
        });
      }
      if (!deps.renderScoreSound) throw notWired();
      const doc = await loadScore(owner, scoreId);
      const end = beatsToSeconds(doc.tempo, scoreEndBeats(doc));
      if (from >= end) {
        throw new CfError(
          'bad_request',
          `The score's music ends at ${round(end)} s; from_seconds is ${from}`,
          {
            hint: `from_seconds before ${round(end)}`,
          },
        );
      }
      const until = args.until_seconds ?? Math.min(end, from + MAX);
      const pad = spectrogramPad();
      const readFrom = Math.max(0, from - pad);
      const sound = await deps.renderScoreSound(
        owner,
        scoreId,
        { from_seconds: readFrom, until_seconds: until + pad },
        signal,
      );
      try {
        const fromBeats = secondsToBeats(sound.doc.tempo, from);
        const untilBeats = secondsToBeats(sound.doc.tempo, until);
        const g = scoreGrid(sound.doc, fromBeats, untilBeats);
        const picture = await renderSpectrogram(
          sound.wav,
          {
            start: readFrom,
            from,
            until,
            longEdge: args.long_edge,
            grid: { bars: g.bars, beats: g.beats },
          },
          signal,
        );
        const beatsOf = new Map(g.bars.map((b, i) => [b.bar, g.barBeats[i] as number]));
        const key = JSON.stringify({ tool: 'spectrogram', score: scoreId, ...shared, until });
        const name = `spectrogram-${scoreId}-${round(from, 2)}-${round(until, 2)}.png`;
        const { image, content } = await keep(
          owner,
          key,
          name,
          picture.png,
          picture.width,
          picture.height,
        );
        return ok(
          spectrogramResult({ score_id: scoreId }, image, picture, from, until, (b) => ({
            ...b,
            beats: round(beatsOf.get(b.bar) ?? 0, 6),
          })),
          content,
        );
      } finally {
        await sound.done?.();
      }
    }),
  );

  server.registerTool(
    'render.notes',
    {
      title: 'Render notes',
      description: `Look at a score's notes: a piano roll as an image, time left to right, one row per pitch with note names up the side, one colour per part, bar and beat lines. A range of beats, and parts to show (default all). It is drawn on the same axes as render.spectrogram, so the two can be compared row for row. Comes inline and with a signed download url.
Time runs in seconds by the score's tempo map, as the music plays; rows run C1 to B9, A4 = 440 Hz. A note's fill is as strong as its velocity, with a white line where it starts. The notes drawn are the ones the score plays: each notes region plays its source's notes that start inside it, a region that shares a source shows them too, and a note that starts outside its region is silent and not drawn. Audio regions are sound, not notes: render.spectrogram shows them. The result names each part's colour, the plot's pixel box and where each bar line is.`,
      inputSchema: RenderNotesInput,
      outputSchema: RenderNotesResult,
      annotations: { ...readOnly, title: 'Render notes' },
    },
    guard(async (args) => {
      const owner = deps.owner();
      const doc = await loadScore(owner, args.score_id);
      const ids = args.parts ?? doc.parts.map((p) => p.id);
      const unknown = ids.filter((id) => !doc.parts.some((p) => p.id === id));
      if (unknown.length) {
        throw new CfError('not_found', `No part ${unknown.join(', ')} in score ${args.score_id}`, {
          hint: `Its parts: ${doc.parts.map((p) => `${p.id} (${p.name})`).join(', ') || 'none'}`,
        });
      }
      const fromBeats = args.from_beats;
      const end = scoreEndBeats(doc);
      const untilBeats = args.until_beats ?? end;
      if (untilBeats <= fromBeats) {
        throw new CfError(
          'bad_request',
          `The score's music ends at beat ${round(end)}; from_beats is ${fromBeats}`,
          {
            hint:
              end > 0
                ? `from_beats before ${round(end)}, or until_beats after from_beats`
                : 'The score has no regions yet',
          },
        );
      }
      const from = beatsToSeconds(doc.tempo, fromBeats);
      const until = beatsToSeconds(doc.tempo, untilBeats);
      const notes = playedNotes(doc, ids, fromBeats, untilBeats);
      const parts = ids.map(
        (id) => doc.parts.find((p) => p.id === id) as ScoreDoc['parts'][number],
      );
      const g = scoreGrid(doc, fromBeats, untilBeats);
      const roll = drawPianoRoll(
        notes,
        parts.map((p) => p.name),
        { from, until, longEdge: args.long_edge, grid: { bars: g.bars, beats: g.beats } },
      );
      const png = encodePng(roll.image);
      const key = JSON.stringify({ tool: 'notes', ...args, parts: ids });
      const name = `notes-${args.score_id}-${round(fromBeats, 2)}-${round(untilBeats, 2)}.png`;
      const { image, content } = await keep(
        owner,
        key,
        name,
        png,
        roll.image.width,
        roll.image.height,
      );
      const beatsOf = new Map(g.bars.map((b, i) => [b.bar, g.barBeats[i] as number]));
      const audio = parts.reduce(
        (n, p) =>
          n +
          p.regions.filter((r) => {
            if (r.type !== 'audio') return false;
            const startS = beatsToSeconds(doc.tempo, r.start);
            return startS < until && startS + (r.until - r.from) > from;
          }).length,
        0,
      );
      const drawnBy = new Map<number, number>();
      for (const n of notes) {
        if (n.pitch >= LOW_PITCH - 0.5 && n.pitch <= HIGH_PITCH + 0.5)
          drawnBy.set(n.part, (drawnBy.get(n.part) ?? 0) + 1);
      }
      const result: z.infer<typeof RenderNotesResult> = {
        score_id: args.score_id,
        image,
        from_beats: round(fromBeats, 6),
        until_beats: round(untilBeats, 6),
        from_seconds: round(from, 6),
        until_seconds: round(until, 6),
        ...axes(roll.layout),
        parts: parts.map((p, i) => ({
          part_id: p.id,
          name: p.name,
          colour: hex(partColour(i)),
          notes: drawnBy.get(i) ?? 0,
        })),
        notes: roll.drawn,
        notes_outside_rows: roll.outside,
        audio_regions: audio,
        bars: roll.bars.map((b) => ({
          bar: b.bar,
          seconds: round(b.seconds, 6),
          beats: round(beatsOf.get(b.bar) ?? 0, 6),
          x: b.x,
        })),
        beat_lines: roll.beatLines,
      };
      return ok(result, content);
    }),
  );
}

type Bar = { bar: number; seconds: number; x: number };

function spectrogramResult(
  source: { media_id?: string; score_id?: string },
  image: z.infer<typeof RenderSpectrogramResult>['image'],
  picture: { layout: SoundLayout; bars: Bar[]; beatLines: number; peakDb: number | null },
  from: number,
  until: number,
  bar: (b: Bar) => Bar & { beats?: number },
): z.infer<typeof RenderSpectrogramResult> {
  const windows: Record<string, number> = {};
  for (let p = LOW_PITCH; p <= HIGH_PITCH; p += 12)
    windows[noteName(p)] = round(windowSeconds(p), 4);
  return {
    ...source,
    image,
    from_seconds: round(from, 6),
    until_seconds: round(until, 6),
    ...axes(picture.layout),
    level: {
      black_db: FLOOR_DB,
      brightest_db: 0,
      unit: 'dBFS',
      peak_db: picture.peakDb === null ? null : round(picture.peakDb, 1),
    },
    analysis: ANALYSIS,
    window_seconds: windows,
    bars: picture.bars.map((b) => bar({ ...b, seconds: round(b.seconds, 6) })),
    beat_lines: picture.beatLines,
  };
}
