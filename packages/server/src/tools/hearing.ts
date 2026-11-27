import {
  findNotes,
  levelsDb,
  measureKey,
  measureSpectrum,
  measureSteps,
  NOTES_METHOD,
  onsetsOf,
} from '@cuttingfloor/engine';
import { CfError, HEARING_LIMITS } from '@cuttingfloor/schema';
import type { Sound } from '../sound.ts';

// media.analyze onsets, notes, key and spectrum, and loudness's level on steps: measured facts
// about any sound, returned whole in the result on the source's own clock. Every threshold is
// the caller's; the only numbers here are the limits that protect the server (HEARING_LIMITS),
// each refused with its number.

export const HEARING_KINDS = ['onsets', 'notes', 'key', 'spectrum'] as const;
type HearingKind = (typeof HEARING_KINDS)[number];

export function isHearingKind(kind: string): kind is HearingKind {
  return (HEARING_KINDS as readonly string[]).includes(kind);
}

export interface HearingArgs {
  kind: string;
  every_seconds?: number | undefined;
  threshold_db?: number | undefined;
  min_seconds?: number | undefined;
  split_cents?: number | undefined;
  tempo?: number | undefined;
  first_bar_seconds?: number | undefined;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The arguments each sound fact needs, checked before any job exists. */
export function checkHearingArgs(args: HearingArgs): void {
  const step = args.every_seconds;
  if ((args.kind === 'look' || args.kind === 'colour') && step !== undefined && step < 0.04) {
    throw new CfError('bad_request', `${args.kind} samples a frame at most every 0.04 s`, {
      hint: 'every_seconds is 0.04 or more for look and colour',
    });
  }
  if (args.kind === 'silence' && args.threshold_db !== undefined && args.threshold_db > 0) {
    throw new CfError('bad_request', 'silence takes threshold_db as a level, -100 to 0 dBFS');
  }
  if (args.kind === 'onsets') {
    if (step === undefined || args.threshold_db === undefined) {
      throw new CfError('bad_request', 'onsets needs every_seconds and threshold_db', {
        hint: 'every_seconds is the step levels are measured on; threshold_db the rise in dB over the step before that counts',
      });
    }
  }
  if (args.kind === 'notes') {
    if (args.split_cents === undefined || args.min_seconds === undefined) {
      throw new CfError('bad_request', 'notes needs split_cents and min_seconds', {
        hint: 'split_cents is how far the pitch moves to start a new note (100 a semitone); min_seconds the shortest note kept',
      });
    }
    if (args.threshold_db !== undefined && step === undefined) {
      throw new CfError('bad_request', 'notes with threshold_db needs every_seconds', {
        hint: 'every_seconds is the step whose level rise threshold_db is measured over',
      });
    }
    if (args.first_bar_seconds !== undefined && args.tempo === undefined) {
      throw new CfError(
        'bad_request',
        'first_bar_seconds counts beats; notes needs a tempo with it',
      );
    }
  }
  if ((args.kind === 'onsets' || args.kind === 'notes') && args.threshold_db !== undefined) {
    if (args.threshold_db <= 0) {
      throw new CfError('bad_request', `${args.kind} takes threshold_db as a rise in dB, above 0`);
    }
  }
  const least = (HEARING_LIMITS.minStep as Record<string, number>)[args.kind];
  if (step !== undefined && least !== undefined && step < least) {
    throw new CfError(
      'limit_exceeded',
      `${args.kind} takes every_seconds of ${least} s or more; got ${step}`,
      { hint: `The shortest step ${args.kind} measures on is ${least} s` },
    );
  }
}

/** The limits on how much sound a call reads and how many steps it returns. */
export function checkHearingSize(args: HearingArgs, seconds: number): void {
  const most = (HEARING_LIMITS.seconds as Record<string, number>)[args.kind];
  if (most !== undefined && seconds > most) {
    throw new CfError(
      'limit_exceeded',
      `${args.kind} reads up to ${most} s of sound a call; this range is ${Math.round(seconds)} s`,
      { hint: `Give from_seconds and until_seconds at most ${most} s apart` },
    );
  }
  const cap = (HEARING_LIMITS.steps as Record<string, number>)[args.kind];
  if (cap !== undefined && args.every_seconds !== undefined) {
    const steps = Math.ceil(seconds / args.every_seconds - 1e-9);
    if (steps > cap) {
      throw new CfError(
        'limit_exceeded',
        `That is ${steps} steps; ${args.kind} returns up to ${cap} steps a call`,
        {
          hint: `every_seconds ${Math.ceil((seconds / cap) * 1000) / 1000} covers this range in ${cap} steps, or a shorter range`,
        },
      );
    }
  }
}

function tooMany(kind: string, found: number, cap: number, why: string): CfError {
  return new CfError('limit_exceeded', `Found ${found} ${kind}; a call returns up to ${cap}`, {
    hint: `A shorter range, or ${why}`,
  });
}

/** onsets, notes, key or spectrum of a sound, on the source's own clock. */
export async function measureHearing(
  sound: Sound,
  args: HearingArgs,
  signal: AbortSignal,
  progress: (f: number, m: string) => void,
): Promise<Record<string, unknown>> {
  const range = {
    ...(sound.from !== undefined ? { from: sound.from } : {}),
    ...(sound.until !== undefined ? { until: sound.until } : {}),
    label: sound.label,
    signal,
  };
  const at = (t: number) => r3(t + sound.shift);
  progress(0.05, `${args.kind}: listening`);
  if (args.kind === 'onsets') {
    const step = args.every_seconds as number;
    const threshold = args.threshold_db as number;
    // One step before the range, when there is room, so its first step has one to rise over.
    const lead = sound.from !== undefined && sound.from >= step;
    const levels = await measureSteps(sound.file, {
      ...range,
      ...(lead ? { from: (sound.from as number) - step } : {}),
      step,
      bands: true,
    });
    const onsets = onsetsOf(levels, threshold);
    if (onsets.length > HEARING_LIMITS.onsets) {
      throw tooMany('onsets', onsets.length, HEARING_LIMITS.onsets, 'a higher threshold_db');
    }
    return {
      onsets: {
        every_seconds: step,
        threshold_db: threshold,
        onsets: onsets.map((o) => ({ ...o, time: at(o.time) })),
      },
    };
  }
  if (args.kind === 'notes') {
    const notes = await findNotes(sound.file, {
      ...range,
      rules: {
        splitCents: args.split_cents as number,
        minSeconds: args.min_seconds as number,
        ...(args.threshold_db !== undefined
          ? { thresholdDb: args.threshold_db, step: args.every_seconds as number }
          : {}),
        ...(args.tempo !== undefined
          ? { tempo: args.tempo, firstBarSeconds: (args.first_bar_seconds ?? 0) - sound.shift }
          : {}),
      },
    });
    if (notes.length > HEARING_LIMITS.notes) {
      throw tooMany('notes', notes.length, HEARING_LIMITS.notes, 'a higher min_seconds');
    }
    return {
      notes: {
        method: NOTES_METHOD,
        split_cents: args.split_cents,
        min_seconds: args.min_seconds,
        ...(args.threshold_db !== undefined
          ? { threshold_db: args.threshold_db, every_seconds: args.every_seconds }
          : {}),
        ...(args.tempo !== undefined
          ? { tempo: args.tempo, first_bar_seconds: args.first_bar_seconds ?? 0 }
          : {}),
        notes: notes.map((n) => ({ ...n, start: at(n.start), end: at(n.end) })),
      },
    };
  }
  if (args.kind === 'key') {
    const key = await measureKey(sound.file, {
      ...range,
      ...(args.every_seconds !== undefined ? { step: args.every_seconds } : {}),
    });
    return {
      key: {
        scores: key.scores,
        notes: key.notes,
        ...(key.steps
          ? {
              steps: {
                start: at(key.steps.start),
                every_seconds: key.steps.step,
                notes: key.steps.notes,
              },
            }
          : {}),
      },
    };
  }
  const spectrum = await measureSpectrum(sound.file, {
    ...range,
    ...(args.every_seconds !== undefined ? { step: args.every_seconds } : {}),
  });
  return {
    spectrum: {
      bands_hz: spectrum.bands_hz,
      level_db: spectrum.level_db,
      ...(spectrum.steps
        ? {
            steps: {
              start: at(spectrum.steps.start),
              every_seconds: spectrum.steps.step,
              level_db: spectrum.steps.level_db,
            },
          }
        : {}),
    },
  };
}

/** loudness with every_seconds: the level on steps, on the source's own clock. */
export async function levelSteps(sound: Sound, step: number, signal: AbortSignal) {
  const levels = await measureSteps(sound.file, {
    ...(sound.from !== undefined ? { from: sound.from } : {}),
    ...(sound.until !== undefined ? { until: sound.until } : {}),
    label: sound.label,
    step,
    signal,
  });
  return { start: r3(levels.start + sound.shift), every_seconds: step, level_db: levelsDb(levels) };
}
