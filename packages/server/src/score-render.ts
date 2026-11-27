import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beatsToSeconds,
  type Performance,
  type PerformedAudio,
  performScore,
  secondsToBeats,
} from '@cuttingfloor/core';
import { type MusicProjectInput, type MusicRender, renderMusic } from '@cuttingfloor/engine';
import { CfError, type ScoreDoc } from '@cuttingfloor/schema';
import type { Runtime } from './runtime.ts';

// A score as sound: the score is flattened into a performance (packages/core, every time in
// seconds), the performance is written as the engine's render project, and cf-music renders it.
// score.render, the score side of render.spectrogram and score.record's loop all come through
// here, so they cannot disagree about what a score sounds like.

export interface ScoreSoundOptions {
  /** The range, in the score's own beats. */
  from_beats: number;
  until_beats: number;
  /** Only these parts' notes and audio play. Default all. */
  parts?: string[];
  /** Run past the range until the sound falls under this level (dBFS), and say when. */
  tail_db?: number;
  format?: 'wav' | 'mp3';
  /** The file to write. Left out: a file in a temp folder, removed by `done`. */
  dest?: string;
  signal?: AbortSignal;
}

export interface ScoreSound {
  file: string;
  render: MusicRender;
  /** Parts whose own notes or audio play in the range, after mute, solo and `parts`. */
  parts_sounded: string[];
  /** The range rendered, in seconds of the score. */
  from_seconds: number;
  until_seconds: number;
  /** Media the render read. */
  media: string[];
  /** Removes the temp folder, when the render made one. */
  done: () => Promise<void>;
}

/**
 * The engine's project for a range of a score. The engine plays from the start of the score
 * (a note or a reverb that began before the range still sounds in it) and keeps the range, so
 * the performance is of everything up to the range's end and times are the score's own seconds.
 */
export function musicProject(
  doc: ScoreDoc,
  options: Pick<ScoreSoundOptions, 'from_beats' | 'until_beats' | 'parts' | 'tail_db'>,
  fileOf: (mediaId: string) => string,
): { project: MusicProjectInput; performance: Performance } {
  // The range decides which parts sound; the whole stretch up to its end is what the engine plays.
  const inRange = performScore(doc, {
    from_beats: options.from_beats,
    until_beats: options.until_beats,
    ...(options.parts ? { parts: options.parts } : {}),
  });
  const whole =
    options.from_beats === 0
      ? inRange
      : performScore(doc, {
          from_beats: 0,
          until_beats: options.until_beats,
          ...(options.parts ? { parts: options.parts } : {}),
        });
  const project: MusicProjectInput = {
    sample_rate: doc.sample_rate,
    from: beatsToSeconds(doc.tempo, options.from_beats),
    until: beatsToSeconds(doc.tempo, options.until_beats),
    ...(options.tail_db !== undefined ? { tail_db: options.tail_db } : {}),
    tracks: whole.parts.map((part) => ({
      id: part.part_id,
      gain_db: part.gain_db,
      pan: part.pan,
      output: part.output,
      devices: part.devices.map((d) => device(d, fileOf)),
      sends: part.sends.map((s) => ({
        id: s.send_id,
        to: s.to_part_id,
        level_db: s.level_db,
        before_gain: s.before_gain,
      })),
      // A note that begins before the score's first beat has no time to begin at.
      notes: part.notes
        .filter((n) => n.start >= 0)
        .map((n) => ({ start: n.start, length: n.length, pitch: n.pitch, velocity: n.velocity })),
      clips: part.audio.flatMap((a) => clips(a, fileOf)),
    })),
    master: { devices: whole.master.devices.map((d) => device(d, fileOf)) },
    automation: whole.automation.map((lane) => ({
      target:
        'part_id' in lane.target
          ? { track: lane.target.part_id, param: lane.target.param }
          : 'send_id' in lane.target
            ? { send: lane.target.send_id, param: lane.target.param }
            : { device: lane.target.device_id, param: lane.target.param },
      points: lane.points.map((p) => ({ time: p.at, value: p.value, curve: p.curve })),
    })),
  };
  return { project, performance: inRange };
}

/** A device as the engine takes it: a sampler reads a file where the score names media. */
function device(
  d: Performance['parts'][number]['devices'][number],
  fileOf: (mediaId: string) => string,
): { id: string; name: string; params: Record<string, unknown> } {
  const { media_id, ...params } = d.params as { media_id?: string } & Record<string, unknown>;
  return {
    id: d.device_id,
    name: d.name,
    params: media_id === undefined ? params : { file: fileOf(media_id), ...params },
  };
}

/**
 * An audio region as engine clips. One that plays at its own speed is one clip. One fitted to
 * beats is a clip per straight piece of its time map (one piece under a steady tempo, more where
 * the tempo changes inside it), each stretched to its own length.
 */
function clips(
  a: PerformedAudio,
  fileOf: (mediaId: string) => string,
): NonNullable<MusicProjectInput['tracks'][number]['clips']> {
  const file = fileOf(a.media_id);
  if (!a.stretch) {
    // Begun before the score's first beat: the part of it from that beat on.
    const late = Math.max(0, -a.start);
    if (a.source.from + late >= a.source.until) return [];
    return [
      {
        file,
        at: a.start + late,
        from: a.source.from + late,
        until: a.source.until,
        gain_db: a.gain_db,
      },
    ];
  }
  const out: NonNullable<MusicProjectInput['tracks'][number]['clips']> = [];
  for (let i = 0; i + 1 < a.stretch.length; i += 1) {
    const here = a.stretch[i] as { at: number; source: number };
    const next = a.stretch[i + 1] as { at: number; source: number };
    if (here.at < 0 || next.at <= here.at || next.source <= here.source) continue;
    out.push({
      file,
      at: here.at,
      from: here.source,
      until: next.source,
      gain_db: a.gain_db,
      stretch_to: next.at - here.at,
    });
  }
  return out;
}

/** Renders a range of a score to a file and measures it. */
export async function renderScoreSound(
  rt: Runtime,
  owner: string,
  doc: ScoreDoc,
  options: ScoreSoundOptions,
): Promise<ScoreSound> {
  const media = Object.keys(doc.media);
  const files = new Map<string, string>();
  for (const id of media) {
    const record = await rt.media.get(owner, id);
    files.set(id, await rt.media.sourceFile(record, 'export'));
  }
  const fileOf = (id: string) => {
    const file = files.get(id);
    if (!file) throw new CfError('not_found', `The score uses media ${id}, which is not here`);
    return file;
  };
  const { project, performance } = musicProject(doc, options, fileOf);
  const format = options.format ?? 'wav';
  const temp = options.dest ? undefined : await mkdtemp(join(tmpdir(), 'cf-score-'));
  const file = options.dest ?? join(temp as string, `score.${format}`);
  const done = async () => {
    if (temp) await rm(temp, { recursive: true, force: true });
  };
  try {
    const render = await renderMusic(project, file, {
      format,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      file,
      render,
      parts_sounded: performance.played,
      from_seconds: performance.range.from_seconds,
      until_seconds: performance.range.until_seconds,
      media: Object.keys(performance.media),
      done,
    };
  } catch (error) {
    await done();
    throw error;
  }
}

/** A range given in seconds of a score, as the beats that range covers. */
export function beatsOf(
  doc: Pick<ScoreDoc, 'tempo'>,
  range: { from_seconds: number; until_seconds: number },
): { from_beats: number; until_beats: number } {
  return {
    from_beats: secondsToBeats(doc.tempo, Math.max(0, range.from_seconds)),
    until_beats: secondsToBeats(doc.tempo, range.until_seconds),
  };
}
