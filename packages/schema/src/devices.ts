import * as z from 'zod/v4';
import { MediaId } from './ids.ts';
import { PitchInput } from './score.ts';

// The device registry: every instrument and effect a part of a score can sound through, with
// typed parameters. score.add_device takes a name and a params object checked against this at
// run time (so tool definitions stay small); video://catalog/devices lists it, and errors list
// the names and params inline. A param is required, or has the default published here (which
// score.get shows applied), or has none (null: the instrument's own, or off). Numbers marked
// automatable can be moved over time with score.set_automation, named by their path.

type Num = {
  kind: 'number';
  min: number;
  max: number;
  /** null: no value unless given (the instrument's own behaviour, or the feature off). */
  default: number | null;
  required?: true;
  integer?: true;
  automatable?: true;
  about: string;
};
type Choice = {
  kind: 'choice';
  values: readonly string[];
  default: string | null;
  required?: true;
  about: string;
};
type Bool = { kind: 'boolean'; default: boolean; about: string };
type Media = { kind: 'media'; required?: true; about: string };
type Pitch = { kind: 'pitch'; required?: true; about: string };
/** A nested object of params (filter.cutoff_hz). Left out, the whole feature is off. */
type Group = { kind: 'group'; required?: true; params: Record<string, DeviceParam>; about: string };
/** A list of objects (bands[0].gain_db). */
type List = {
  kind: 'list';
  min: number;
  max: number;
  required?: true;
  item: Record<string, DeviceParam>;
  about: string;
};
export type DeviceParam = Num | Choice | Bool | Media | Pitch | Group | List;

export interface DeviceSpec {
  kind: 'instrument' | 'effect';
  about: string;
  params: Record<string, DeviceParam>;
  /** A rule across params; returns what is wrong, in words, or nothing. */
  check?: (params: Record<string, unknown>) => string | undefined;
  /** Drum kits and other instruments where a pitch selects a sound: which pitch plays what. */
  sounds?: Record<number, string>;
}

const num = (
  min: number,
  max: number,
  def: number | null,
  about: string,
  flags: { required?: true; automatable?: true; integer?: true } = {},
): Num => ({ kind: 'number', min, max, default: def, about, ...flags });
const auto = (min: number, max: number, def: number | null, about: string): Num =>
  num(min, max, def, about, { automatable: true });
const need = (min: number, max: number, about: string): Num =>
  num(min, max, null, about, { required: true, automatable: true });

const GAIN = auto(-60, 24, 0, 'Level in dB');

/** What each pitch of a drum kit plays: the standard drum map, with C4 as 60. */
export const KIT_SOUNDS: Record<number, string> = {
  36: 'kick (C2)',
  38: 'snare (D2)',
  39: 'clap (D#2)',
  41: 'low floor tom (F2)',
  42: 'closed hat (F#2)',
  43: 'high floor tom (G2)',
  45: 'low tom (A2)',
  46: 'open hat (A#2)',
  47: 'low-mid tom (B2)',
  48: 'high-mid tom (C3)',
  49: 'crash (C#3)',
  50: 'high tom (D3)',
  51: 'ride (D#3)',
};

const named = (about: string): DeviceSpec => ({
  kind: 'instrument',
  about,
  params: {
    gain_db: GAIN,
    attack_ms: num(0, 10_000, null, "Fade-in of each note; left out, the instrument's own"),
    release_ms: num(
      0,
      30_000,
      null,
      "Fade-out after each note ends; left out, the instrument's own",
    ),
  },
});

const kit = (about: string): DeviceSpec => ({
  kind: 'instrument',
  about: `${about}. A pitch selects a sound (the standard drum map, C4 as 60)`,
  params: { gain_db: GAIN },
  sounds: KIT_SOUNDS,
});

const envelope = (about: string, extra: Record<string, DeviceParam> = {}): Group => ({
  kind: 'group',
  about,
  params: {
    attack_ms: num(0, 10_000, 0, 'Time to reach full'),
    decay_ms: num(0, 10_000, 0, 'Time to fall to sustain'),
    sustain: num(0, 1, 1, 'Level held while the note lasts, 0 to 1'),
    release_ms: num(0, 30_000, 10, 'Time to fall away after the note ends'),
    ...extra,
  },
});

const SLOPE: Choice = {
  kind: 'choice',
  values: ['12', '24', '48'],
  default: '12',
  about: 'Steepness in dB per octave (lowpass, highpass)',
};

export const DEVICES = {
  // Instruments
  sampler: {
    kind: 'instrument',
    about:
      "Plays any media's sound, or a time range of it, at each note's pitch: from its start for the note's length, then release_ms. With slices, each pitch plays its own range unchanged (as a drum kit does) and a pitch with no slice is silent",
    params: {
      media_id: { kind: 'media', required: true, about: 'The media whose sound it plays' },
      from_seconds: num(0, 86_400, null, 'Start of the range played; left out, the start'),
      until_seconds: num(0, 86_400, null, 'End of the range played; left out, the end'),
      root_note: {
        kind: 'pitch',
        about: 'The pitch that plays the sound unchanged. Required without slices',
      },
      one_shot: {
        kind: 'boolean',
        default: false,
        about: 'true plays the sound to its end whatever the note length',
      },
      loop: {
        kind: 'boolean',
        default: false,
        about: 'true repeats the range for as long as the note lasts',
      },
      slices: {
        kind: 'list',
        min: 1,
        max: 128,
        about: 'One sound per pitch: each note plays its own range of the media, unchanged',
        item: {
          note: { kind: 'pitch', required: true, about: 'The pitch that plays this slice' },
          from_seconds: num(0, 86_400, null, 'Start of the slice', { required: true }),
          until_seconds: num(0, 86_400, null, 'End of the slice', { required: true }),
        },
      },
      attack_ms: num(0, 10_000, 0, 'Fade-in of each note'),
      release_ms: num(0, 30_000, 10, 'Fade-out after each note ends'),
      gain_db: GAIN,
    },
    check: (p) =>
      p.slices === undefined && p.root_note === undefined
        ? 'sampler needs root_note (the pitch that plays the sound unchanged) or slices'
        : undefined,
  },
  synth: {
    kind: 'instrument',
    about: 'Oscillators through a filter, shaped by envelopes',
    params: {
      oscillators: {
        kind: 'list',
        min: 1,
        max: 4,
        required: true,
        about: 'The waves that sound together for each note',
        item: {
          wave: {
            kind: 'choice',
            values: ['sine', 'saw', 'square', 'triangle', 'noise'],
            default: null,
            required: true,
            about: 'The wave shape',
          },
          octave: num(-4, 4, 0, 'Octaves above or below the note', { integer: true }),
          detune_cents: auto(-1200, 1200, 0, 'Cents above or below the note'),
          level: auto(0, 1, 1, 'How much of this wave, 0 to 1'),
        },
      },
      filter: {
        kind: 'group',
        about: 'A filter after the oscillators; left out, none',
        params: {
          type: {
            kind: 'choice',
            values: ['lowpass', 'highpass', 'bandpass'],
            default: null,
            required: true,
            about: 'What it lets through',
          },
          cutoff_hz: need(20, 20_000, 'Where it cuts'),
          resonance: auto(0, 1, 0, 'Emphasis at the cutoff, 0 to 1'),
        },
      },
      amp_envelope: envelope(
        "The level of each note over its life; left out, on for the note's length",
      ),
      filter_envelope: envelope('Moves the filter cutoff over each note; left out, none', {
        octaves: num(-8, 8, null, 'How far the cutoff moves at full, in octaves', {
          required: true,
        }),
      }),
      glide_ms: num(0, 5000, 0, 'Time to slide from the note before'),
      gain_db: GAIN,
    },
  },
  grand_piano: named('Acoustic grand piano'),
  electric_piano: named('Electric piano'),
  organ: named('Organ'),
  acoustic_bass: named('Upright bass, plucked'),
  electric_bass: named('Electric bass guitar'),
  synth_bass: named('Synthesiser bass'),
  sub_bass: named('Low sine bass'),
  strings: named('String section'),
  pad_warm: named('Soft sustained pad'),
  brass: named('Brass section'),
  flute: named('Flute'),
  bells: named('Tuned bells'),
  music_box: named('Music box'),
  marimba: named('Marimba'),
  acoustic_guitar: named('Acoustic guitar'),
  electric_guitar: named('Clean electric guitar'),
  pluck: named('Short plucked synth'),
  choir: named('Choir singing aah'),
  kit_acoustic: kit('Acoustic drum kit'),
  kit_808: kit('TR-808 style electronic kit'),
  kit_909: kit('TR-909 style electronic kit'),
  kit_lofi: kit('Soft, dusty kit'),

  // Effects
  eq: {
    kind: 'effect',
    about: 'Equaliser: bands that boost, cut or remove ranges of frequency',
    params: {
      bands: {
        kind: 'list',
        min: 1,
        max: 8,
        required: true,
        about: 'The bands, applied together',
        item: {
          type: {
            kind: 'choice',
            values: ['peak', 'low_shelf', 'high_shelf', 'lowpass', 'highpass'],
            default: null,
            required: true,
            about: 'The shape of the band',
          },
          hz: need(20, 20_000, 'Its frequency'),
          gain_db: auto(-24, 24, 0, 'Boost or cut (peak and shelves)'),
          q: auto(0.1, 18, 0.71, 'Width: higher is narrower'),
          slope_db_per_octave: SLOPE,
        },
      },
    },
  },
  filter: {
    kind: 'effect',
    about: 'One filter with a movable cutoff',
    params: {
      type: {
        kind: 'choice',
        values: ['lowpass', 'highpass', 'bandpass'],
        default: null,
        required: true,
        about: 'What it lets through',
      },
      cutoff_hz: need(20, 20_000, 'Where it cuts'),
      resonance: auto(0, 1, 0, 'Emphasis at the cutoff, 0 to 1'),
      slope_db_per_octave: SLOPE,
    },
  },
  compressor: {
    kind: 'effect',
    about: 'Turns down what is louder than a threshold',
    params: {
      threshold_db: need(-60, 0, 'Level above which it turns down'),
      ratio: need(1, 20, 'How hard: 4 lets 1 dB out for every 4 over'),
      attack_ms: num(0.1, 500, null, 'How fast it turns down', { required: true }),
      release_ms: num(1, 5000, null, 'How fast it lets go', { required: true }),
      makeup_db: auto(-24, 24, 0, 'Gain after it'),
    },
  },
  limiter: {
    kind: 'effect',
    about: 'Holds the true peak under a ceiling',
    params: {
      ceiling_dbtp: need(-24, 0, 'The true peak it never passes, in dBTP'),
      release_ms: num(1, 2000, 100, 'How fast it lets go'),
    },
  },
  reverb: {
    kind: 'effect',
    about: 'The sound of a room',
    params: {
      decay_seconds: need(0.1, 20, 'How long the room rings'),
      wet: need(0, 1, 'How much room, 0 to 1'),
      dry: auto(0, 1, 1, 'How much of the sound itself, 0 to 1'),
      size: num(0, 1, 0.5, 'Room size, 0 to 1'),
      damping: num(0, 1, 0.5, 'How fast the highs die, 0 to 1'),
    },
  },
  delay: {
    kind: 'effect',
    about: 'Echoes',
    params: {
      time_beats: num(0.01, 16, null, 'Time between echoes in beats (follows the tempo)'),
      time_ms: num(1, 5000, null, 'Time between echoes in milliseconds'),
      feedback: auto(0, 0.95, 0, 'How much of each echo feeds the next, 0 to 0.95'),
      wet: need(0, 1, 'How much echo, 0 to 1'),
    },
    check: (p) =>
      (p.time_beats === undefined) === (p.time_ms === undefined)
        ? 'delay takes exactly one of time_beats or time_ms'
        : undefined,
  },
  chorus: {
    kind: 'effect',
    about: 'Thickens a sound with moving copies of it',
    params: {
      rate_hz: need(0.01, 20, 'How fast the copies move'),
      depth: need(0, 1, 'How far they move, 0 to 1'),
      wet: need(0, 1, 'How much of them, 0 to 1'),
    },
  },
  saturation: {
    kind: 'effect',
    about: 'Warmth to distortion by overdriving',
    params: {
      drive_db: need(0, 48, 'How hard it is driven'),
      wet: auto(0, 1, 1, 'How much of the driven sound, 0 to 1'),
    },
  },
  gain: {
    kind: 'effect',
    about: 'A level change at this point in the chain',
    params: { gain_db: need(-60, 24, 'Level in dB') },
  },
} satisfies Record<string, DeviceSpec>;

export type DeviceName = keyof typeof DEVICES;
export const DEVICE_NAMES = Object.keys(DEVICES) as DeviceName[];

const spec = (name: string): DeviceSpec | undefined =>
  (DEVICES as Record<string, DeviceSpec>)[name];

/** Whether a device makes sound from notes (an instrument) or changes sound (an effect). */
export function deviceKind(name: string): DeviceSpec['kind'] | undefined {
  return spec(name)?.kind;
}

/** Every device name, by kind: what an error about an unknown device lists. */
export function deviceNamesText(): string {
  const of = (kind: DeviceSpec['kind']) =>
    DEVICE_NAMES.filter((n) => spec(n)?.kind === kind).join(', ');
  return `Instruments: ${of('instrument')}. Effects: ${of('effect')}`;
}

function paramText(key: string, p: DeviceParam): string {
  const must = 'required' in p && p.required ? ', required' : '';
  if (p.kind === 'number') {
    const def = p.required ? '' : p.default === null ? ', no default' : `, default ${p.default}`;
    return `${key}: ${p.min} to ${p.max}${def}${must} (${p.about}${p.automatable ? '; automatable' : ''})`;
  }
  if (p.kind === 'choice') {
    const def = p.required || p.default === null ? '' : `, default ${p.default}`;
    return `${key}: one of ${p.values.join(', ')}${def}${must} (${p.about})`;
  }
  if (p.kind === 'boolean') return `${key}: true or false, default ${p.default} (${p.about})`;
  if (p.kind === 'media') return `${key}: a media_id${must} (${p.about})`;
  if (p.kind === 'pitch')
    return `${key}: a pitch, a number or a name such as C3${must} (${p.about})`;
  const inner = Object.entries(p.kind === 'group' ? p.params : p.item)
    .map(([k, v]) => paramText(k, v))
    .join('; ');
  return p.kind === 'group'
    ? `${key}: {${inner}}${must} (${p.about})`
    : `${key}: ${p.min} to ${p.max} of {${inner}}${must} (${p.about})`;
}

/**
 * One device's params with their ranges, units, defaults and whether they can be automated, as
 * an error about a param lists them (so no catalogue read is needed to fix the call).
 */
export function deviceParamsText(name: string): string {
  const s = spec(name);
  if (!s) return deviceNamesText();
  const params = Object.entries(s.params).map(([k, p]) => paramText(k, p));
  const sounds = s.sounds
    ? `. Pitches: ${Object.entries(s.sounds)
        .map(([n, what]) => `${n} ${what}`)
        .join(', ')}`
    : '';
  return `${name} (${s.kind}) takes ${params.join('; ')}${sounds}`;
}

function paramSchema(p: DeviceParam): z.ZodType {
  const opt = (s: z.ZodType) => ('required' in p && p.required ? s : s.optional());
  if (p.kind === 'number') {
    const n = z.number().min(p.min).max(p.max);
    return opt(p.integer ? n.int() : n);
  }
  if (p.kind === 'choice') return opt(z.enum(p.values as [string, ...string[]]));
  if (p.kind === 'boolean') return z.boolean().optional();
  if (p.kind === 'media') return opt(MediaId);
  if (p.kind === 'pitch') return opt(PitchInput);
  if (p.kind === 'group') return opt(shapeSchema(p.params));
  return opt(z.array(shapeSchema(p.item)).min(p.min).max(p.max));
}

function shapeSchema(params: Record<string, DeviceParam>): z.ZodType {
  return z.strictObject(
    Object.fromEntries(Object.entries(params).map(([k, p]) => [k, paramSchema(p)])),
  );
}

/** Checks params for a device: unknown names and values fail with what is allowed. */
export function deviceParamsSchema(name: string): z.ZodType | undefined {
  const s = spec(name);
  if (!s) return undefined;
  const shape = shapeSchema(s.params);
  const check = s.check;
  return check
    ? shape.superRefine((value, ctx) => {
        const wrong = check(value as Record<string, unknown>);
        if (wrong) ctx.addIssue({ code: 'custom', message: wrong });
      })
    : shape;
}

function applied(
  params: Record<string, DeviceParam>,
  given: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(params)) {
    const v = given[key];
    if (p.kind === 'group') {
      if (v !== undefined) out[key] = applied(p.params, v as Record<string, unknown>);
    } else if (p.kind === 'list') {
      if (v !== undefined) {
        out[key] = (v as Array<Record<string, unknown>>).map((item) => applied(p.item, item));
      }
    } else if (v !== undefined) out[key] = v;
    else if ('default' in p && p.default !== null) out[key] = p.default;
  }
  return out;
}

/** A device's params with every published default filled in: what it actually applies. */
export function deviceParamsApplied(
  name: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const s = spec(name);
  return s ? applied(s.params, params) : params;
}

/**
 * The automatable number a path names on a device as it stands (filter.cutoff_hz,
 * bands[0].gain_db), or why it names none. A list index must exist in the params given.
 */
export function deviceParamAt(
  name: string,
  params: Record<string, unknown>,
  path: string,
): { min: number; max: number } | { error: string } {
  const s = spec(name);
  if (!s) return { error: deviceNamesText() };
  let shape: Record<string, DeviceParam> = s.params;
  let value: unknown = params;
  const steps = path.split('.');
  for (const [i, step] of steps.entries()) {
    const m = /^([a-z_0-9]+)(?:\[(\d+)\])?$/.exec(step);
    const p = m?.[1] === undefined ? undefined : shape[m[1]];
    if (!m || !p) break;
    const key = m[1] as string;
    const inner = (value as Record<string, unknown> | undefined)?.[key];
    if (i === steps.length - 1) {
      if (p.kind === 'number' && p.automatable && m[2] === undefined) {
        return { min: p.min, max: p.max };
      }
      break;
    }
    if (p.kind === 'group' && m[2] === undefined && inner !== undefined) {
      shape = p.params;
      value = inner;
    } else if (p.kind === 'list' && m[2] !== undefined && Array.isArray(inner)) {
      const item = inner[Number(m[2])];
      if (item === undefined) {
        return { error: `${name} has ${inner.length} ${key}; ${step} is not one of them` };
      }
      shape = p.item;
      value = item;
    } else break;
  }
  return {
    error: `${path} is not an automatable param of this ${name}. ${deviceParamsText(name)}`,
  };
}
