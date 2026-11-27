import { readFileSync } from 'node:fs';

// The music engine's devices: every instrument and effect cf-music (tools/music) has, with each
// param's kind, range, unit and default, as the engine takes them. renderMusic (packages/engine)
// checks a project against it before the engine sees it, and the engine checks the same ranges
// itself (a test compares the two). Defaults fill params a device is given without; a param with
// no default must be given. What a score's tools take and show agents is devices.ts, which is
// made from this, so the two cannot drift.

export type ParamDef =
  | {
      kind: 'number';
      min: number;
      max: number;
      unit?: string;
      default?: number;
      /** false: read once (at the device's start, or each note's), so it cannot move. */
      automatable: boolean;
      /** May be left out, with no default (the device decides, as its description says). */
      optional?: boolean;
      description: string;
    }
  | { kind: 'integer'; min: number; max: number; default?: number; description: string }
  | { kind: 'boolean'; default?: boolean; description: string }
  | {
      kind: 'choice';
      choices: readonly (string | number)[];
      default?: string | number;
      description: string;
    }
  | { kind: 'file'; description: string }
  | { kind: 'object'; optional: boolean; fields: Record<string, ParamDef>; description: string }
  | {
      kind: 'list';
      optional: boolean;
      min_items: number;
      max_items: number;
      fields: Record<string, ParamDef>;
      description: string;
    };

export interface DeviceDef {
  name: string;
  kind: 'instrument' | 'effect';
  description: string;
  params: Record<string, ParamDef>;
  /** Drum kits: each pitch the kit has and what it plays (a pitch selects a sound). */
  pitches?: Array<{ pitch: number; name: string }>;
}

interface ContentSpec {
  /** dBFS the loudest note of every named instrument and kit is recorded at, at gain_db 0. */
  peak_db: number;
  instruments: Record<
    string,
    { description: string; attack_ms: number; release_ms: number; synth?: unknown }
  >;
  kits: Record<string, { description: string; pitches: number[] }>;
  drum_names: Record<string, string>;
  choke_groups: number[][];
}

type NumberParam = Extract<ParamDef, { kind: 'number' }>;

let content: ContentSpec | undefined;

/** packages/schema/src/device-content.json: the named instruments and kits the image renders. */
export function musicContent(): ContentSpec {
  content ??= JSON.parse(
    readFileSync(new URL('./device-content.json', import.meta.url), 'utf8'),
  ) as ContentSpec;
  return content;
}

const ms = (description: string, d?: number): NumberParam => ({
  kind: 'number',
  min: 0,
  max: 60000,
  unit: 'ms',
  ...(d !== undefined ? { default: d } : {}),
  automatable: true,
  description,
});
const db = (description: string, min: number, max: number, d?: number): NumberParam => ({
  kind: 'number',
  min,
  max,
  unit: 'dB',
  ...(d !== undefined ? { default: d } : {}),
  automatable: true,
  description,
});
const amount = (description: string, min: number, max: number, d?: number): NumberParam => ({
  kind: 'number',
  min,
  max,
  ...(d !== undefined ? { default: d } : {}),
  automatable: true,
  description,
});
const fixed = (
  description: string,
  min: number,
  max: number,
  unit: string,
  d?: number,
): NumberParam => ({
  kind: 'number',
  min,
  max,
  unit,
  ...(d !== undefined ? { default: d } : {}),
  automatable: false,
  description,
});
const slope = (d = 12): ParamDef => ({
  kind: 'choice',
  choices: [12, 24, 48],
  default: d,
  description: 'How fast it falls past the cutoff, dB per octave',
});
const resonance = (): NumberParam =>
  amount('Q at the cutoff: 0.7071 is flat (Butterworth), higher rings', 0.1, 30, Math.SQRT1_2);
const gain = (): NumberParam => db('Level', -96, 24, 0);
const attack = (d: number): NumberParam => ms('Fade in from each note start', d);
const release = (d: number): NumberParam => ms('Fade out after each note ends', d);

const envelope = (what: string): Record<string, ParamDef> => ({
  attack_ms: ms(`${what}: rise from 0 to full, read at each note start`, 0),
  decay_ms: ms(`${what}: fall from full to sustain, read at each note start`, 0),
  sustain: { ...amount(`${what}: level held while the note is held`, 0, 1, 1) },
  release_ms: ms(`${what}: fall to 0 after the note ends, read at each note start`, 0),
});

const filterFields = (): Record<string, ParamDef> => ({
  type: {
    kind: 'choice',
    choices: ['lowpass', 'highpass', 'bandpass'],
    description: 'Filter shape',
  },
  cutoff_hz: { ...amount('Cutoff (centre for bandpass)', 10, 24000), unit: 'Hz' },
  resonance: resonance(),
  slope_db_per_octave: slope(),
});

function effects(): DeviceDef[] {
  return [
    {
      name: 'eq',
      kind: 'effect',
      description: 'Equaliser: bands applied in order',
      params: {
        bands: {
          kind: 'list',
          optional: false,
          min_items: 1,
          max_items: 32,
          description: 'The bands, in order',
          fields: {
            type: {
              kind: 'choice',
              choices: ['peak', 'low_shelf', 'high_shelf', 'lowpass', 'highpass'],
              description: 'Band shape',
            },
            hz: { ...amount('Centre, corner or cutoff', 10, 24000), unit: 'Hz' },
            gain_db: db('Boost or cut (peak and shelves)', -48, 48, 0),
            q: amount(
              'Width (peak), shelf slope, or resonance (lowpass, highpass)',
              0.05,
              40,
              Math.SQRT1_2,
            ),
            slope_db_per_octave: slope(),
          },
        },
      },
    },
    {
      name: 'filter',
      kind: 'effect',
      description:
        'Low-pass, high-pass or band-pass filter with a real 12, 24 or 48 dB per octave slope',
      params: filterFields(),
    },
    {
      name: 'compressor',
      kind: 'effect',
      description: 'Compressor: feed-forward, stereo-linked peak detector, hard knee',
      params: {
        threshold_db: db('Level above which it compresses', -96, 0),
        ratio: amount('Input dB over the threshold per output dB', 1, 100),
        attack_ms: { ...ms('How fast gain reduction rises', 10), max: 2000 },
        release_ms: { ...ms('How fast gain reduction falls', 100), max: 10000 },
        makeup_db: db('Gain after compressing', -48, 48, 0),
      },
    },
    {
      name: 'limiter',
      kind: 'effect',
      description:
        'True-peak limiter: no sample or inter-sample peak (8x oversampled) passes the ceiling; 2 ms lookahead',
      params: {
        ceiling_dbtp: { ...db('The highest true peak let through', -60, 0), unit: 'dBTP' },
        release_ms: { ...ms('How fast the gain recovers', 100), min: 0.01, max: 10000 },
      },
    },
    {
      name: 'reverb',
      kind: 'effect',
      description: 'Algorithmic reverb (8-line feedback delay network)',
      params: {
        size: amount('Room size: 0 small, 1 large', 0, 1, 0.5),
        decay_seconds: { ...amount('Time the tail takes to fall 60 dB', 0.05, 60, 2), unit: 's' },
        damping: amount('How much faster the highs die: 0 none, 1 most', 0, 1, 0.5),
        wet: amount('Level of the reverb', 0, 4, 0.25),
        dry: amount('Level of the input', 0, 4, 1),
      },
    },
    {
      name: 'delay',
      kind: 'effect',
      description: 'Echo: the input time_ms later, fed back',
      params: {
        time_ms: {
          ...ms('Time between echoes (convert beats to ms yourself)'),
          min: 0.1,
          max: 10000,
        },
        feedback: amount('Share of each echo fed back into the next', 0, 0.99, 0),
        wet: amount('Mix: 0 only the input, 1 only the echoes', 0, 1, 0.3),
      },
    },
    {
      name: 'chorus',
      kind: 'effect',
      description:
        'Chorus: a 7 to 17 ms delay swept by a sine, right channel a quarter turn behind',
      params: {
        rate_hz: { ...amount('Sweep rate', 0.001, 40, 1), unit: 'Hz' },
        depth: amount('Sweep depth: 0 none, 1 the full 10 ms', 0, 1, 0.5),
        wet: amount('Mix: 0 only the input, 1 only the chorus', 0, 1, 0.5),
      },
    },
    {
      name: 'saturation',
      kind: 'effect',
      description: 'Soft clipping (tanh) at 4x oversampling',
      params: {
        drive_db: db('Gain into the clipper', -24, 60),
        wet: amount('Mix: 0 only the input, 1 only the clipped sound', 0, 1, 1),
      },
    },
    {
      name: 'gain',
      kind: 'effect',
      description: 'Level',
      params: { gain_db: db('Level', -96, 48) },
    },
  ];
}

function instruments(): DeviceDef[] {
  const c = musicContent();
  const list: DeviceDef[] = [
    {
      name: 'sampler',
      kind: 'instrument',
      description:
        "Plays an audio file, or a range of it, at each note's pitch from its start for the note's length, then release_ms. With slices, each pitch plays its own range at its own pitch (as a drum kit does); a pitch with no slice is silent",
      params: {
        file: { kind: 'file', description: 'Absolute path of the audio (any file FFmpeg reads)' },
        from_seconds: fixed('Start of the range in the file', 0, 1e7, 's', 0),
        until_seconds: {
          ...fixed('End of the range in the file (left out: its end)', 0, 1e7, 's'),
          optional: true,
        },
        root_note: fixed('The pitch that plays the file unchanged (C4 = 60)', 0, 127, 'pitch', 60),
        one_shot: {
          kind: 'boolean',
          default: false,
          description: 'Play to the end whatever the note length',
        },
        slices: {
          kind: 'list',
          optional: true,
          min_items: 1,
          max_items: 128,
          description: 'Ranges of the file, one per pitch',
          fields: {
            note: fixed('The pitch that plays this slice', 0, 127, 'pitch'),
            from_seconds: fixed('Start of the slice in the file', 0, 1e7, 's'),
            until_seconds: fixed('End of the slice in the file', 0, 1e7, 's'),
          },
        },
        attack_ms: attack(0),
        release_ms: release(0),
        loop: {
          kind: 'boolean',
          default: false,
          description: 'Loop the range while the note is held',
        },
        gain_db: gain(),
      },
    },
    {
      name: 'synth',
      kind: 'instrument',
      description:
        'Subtractive synth: oscillators (band-limited, every phase starts at 0), an optional filter with its own envelope, an amp envelope, glide from the note before',
      params: {
        oscillators: {
          kind: 'list',
          optional: false,
          min_items: 1,
          max_items: 8,
          description: 'The oscillators, mixed',
          fields: {
            wave: {
              kind: 'choice',
              choices: ['sine', 'saw', 'square', 'triangle', 'noise'],
              description: 'Waveform',
            },
            octave: {
              kind: 'integer',
              min: -4,
              max: 4,
              default: 0,
              description: 'Octaves from the note',
            },
            detune_cents: { ...amount('Detune', -1200, 1200, 0), unit: 'cents' },
            level: amount('Level in the mix', 0, 1, 1),
          },
        },
        filter: {
          kind: 'object',
          optional: true,
          description: 'Filter after the oscillators',
          fields: filterFields(),
        },
        amp_envelope: {
          kind: 'object',
          optional: false,
          description: 'Level over each note',
          fields: envelope('Level'),
        },
        filter_envelope: {
          kind: 'object',
          optional: true,
          description: 'Moves the filter cutoff over each note',
          fields: {
            ...envelope('Cutoff'),
            amount_octaves: {
              ...amount('Cutoff raised at full envelope', -10, 10, 0),
              unit: 'octaves',
            },
          },
        },
        glide_ms: {
          ...ms("Time to slide from the previous note's pitch, read at each note start", 0),
          max: 10000,
        },
        gain_db: gain(),
      },
    },
  ];
  for (const [name, spec] of Object.entries(c.instruments)) {
    list.push({
      name,
      kind: 'instrument',
      description: spec.description,
      params: {
        gain_db: gain(),
        attack_ms: attack(spec.attack_ms),
        release_ms: release(spec.release_ms),
      },
    });
  }
  for (const [name, spec] of Object.entries(c.kits)) {
    list.push({
      name,
      kind: 'instrument',
      description: `${spec.description}. Standard drum map, C4 = 60: a pitch selects a sound, played to its end`,
      params: { gain_db: gain() },
      pitches: spec.pitches.map((p) => ({
        pitch: p,
        name: c.drum_names[String(p)] ?? `pitch ${p}`,
      })),
    });
  }
  return list;
}

let catalog: Map<string, DeviceDef> | undefined;

/** Every device, by name: instruments (sampler, synth, named instruments, drum kits), then effects. */
export function musicDevices(): Map<string, DeviceDef> {
  catalog ??= new Map([...instruments(), ...effects()].map((d) => [d.name, d]));
  return catalog;
}
