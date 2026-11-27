import * as z from 'zod/v4';
import { type DeviceDef, musicDevices, type ParamDef } from './device-catalog.ts';
import { MediaId } from './ids.ts';
import { PitchInput, pitchName } from './score.ts';

// The device registry: every instrument and effect a part of a score can sound through, with
// typed parameters, as a score's tools take them and show them. score.add_device takes a name and
// a params object checked against this at run time (so tool definitions stay small);
// video://catalog/devices lists it, and errors list the names and params inline.
//
// It is made from the engine's own catalog (device-catalog.ts), so a param, range or default can
// never differ from what the engine does. Three things differ on purpose, all listed below:
// - a sampler names media (media_id), not a file, and its pitches take note names;
// - a delay's time can be given in beats;
// - a param the engine gives a default that is a matter of taste, not a neutral value, is
//   required here: a tool holds no opinion, so the agent says how long a room rings.
// Numbers marked automatable can be moved over time with score.set_automation, by their path.

type Num = {
  kind: 'number';
  min: number;
  max: number;
  /** null: no value unless given (off, or required). */
  default: number | null;
  unit?: string;
  required?: true;
  integer?: true;
  automatable?: true;
  about: string;
};
type Choice = {
  kind: 'choice';
  values: readonly (string | number)[];
  default: string | number | null;
  required?: true;
  about: string;
};
type Bool = { kind: 'boolean'; default: boolean | null; required?: true; about: string };
type Media = { kind: 'media'; required?: true; about: string };
type Pitch = { kind: 'pitch'; required?: true; about: string };
/** A nested object of params (filter.cutoff_hz). Left out, the whole feature is off. */
type Group = {
  kind: 'group';
  required?: true;
  /** Always there: left out, it is its params' defaults (none of them has to be given). */
  filled?: true;
  params: Record<string, DeviceParam>;
  about: string;
};
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
  /** Drum kits: which pitch plays what (a pitch selects a sound, not a height). */
  sounds?: Record<number, string>;
}

/**
 * Params the engine defaults to a value that is a choice of taste. Here they must be given.
 * Paths are device.param, with [] for a list's items.
 */
const NO_DEFAULT = new Set([
  'reverb.decay_seconds',
  'reverb.wet',
  'delay.wet',
  'chorus.rate_hz',
  'chorus.depth',
  'chorus.wet',
  'compressor.attack_ms',
  'compressor.release_ms',
]);

/** Engine numbers that are pitches: here they also take a note name. */
const PITCHES = new Set(['sampler.root_note', 'sampler.slices[].note']);

const must = (required: boolean) => (required ? { required: true as const } : {});

function fromEngine(def: ParamDef, path: string): DeviceParam {
  const about = def.description;
  if (def.kind === 'object') {
    const params = shapeFromEngine(def.fields, `${path}.`);
    // The engine always has it; where every param in it has a default, an agent may leave it out.
    const needs = Object.values(params).some((p) => 'required' in p && p.required);
    return {
      kind: 'group',
      about,
      params,
      ...(def.optional ? {} : needs ? { required: true as const } : { filled: true as const }),
    };
  }
  if (def.kind === 'list') {
    return {
      kind: 'list',
      about,
      min: def.min_items,
      max: def.max_items,
      item: shapeFromEngine(def.fields, `${path}[].`),
      ...must(!def.optional),
    };
  }
  if (def.kind === 'file') return { kind: 'media', about, required: true };
  if (PITCHES.has(path)) {
    return { kind: 'pitch', about, ...must(path === 'sampler.slices[].note') };
  }
  const strip = NO_DEFAULT.has(path);
  if (def.kind === 'boolean') {
    const given = strip ? undefined : def.default;
    return { kind: 'boolean', about, default: given ?? null, ...must(given === undefined) };
  }
  if (def.kind === 'choice') {
    const given = strip ? undefined : def.default;
    return {
      kind: 'choice',
      about,
      values: def.choices,
      default: given ?? null,
      ...must(given === undefined),
    };
  }
  const given = strip ? undefined : def.default;
  const optional = def.kind === 'number' && def.optional === true;
  return {
    kind: 'number',
    about,
    min: def.min,
    max: def.max,
    default: given ?? null,
    ...(def.kind === 'number' && def.unit ? { unit: def.unit } : {}),
    ...(def.kind === 'integer' ? { integer: true as const } : {}),
    ...(def.kind === 'number' && def.automatable ? { automatable: true as const } : {}),
    ...must(given === undefined && !optional),
  };
}

function shapeFromEngine(
  fields: Record<string, ParamDef>,
  prefix: string,
): Record<string, DeviceParam> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, def]) => [key, fromEngine(def, `${prefix}${key}`)]),
  );
}

function specFromEngine(def: DeviceDef): DeviceSpec {
  const params = shapeFromEngine(def.params, `${def.name}.`);
  const spec: DeviceSpec = { kind: def.kind, about: def.description, params };
  if (def.pitches) {
    spec.sounds = Object.fromEntries(
      def.pitches.map((p) => [p.pitch, `${p.name} (${pitchName(p.pitch).name})`]),
    );
  }
  if (def.name === 'sampler') {
    // A score names media, which the server turns into the file the engine reads.
    const { file, ...rest } = params;
    spec.params = {
      media_id: {
        kind: 'media',
        required: true,
        about: file?.about ?? 'The media whose sound it plays',
      },
      ...rest,
    };
    spec.check = (p) =>
      p.slices === undefined && p.root_note === undefined
        ? 'sampler needs root_note (the pitch that plays the sound unchanged) or slices'
        : undefined;
  }
  if (def.name === 'delay') {
    const ms = params.time_ms as Num;
    spec.params = {
      time_beats: {
        kind: 'number',
        min: 0.001,
        max: 64,
        default: null,
        unit: 'beats',
        about: `Time between echoes in beats at the score's opening tempo: one time for the whole render, it does not follow tempo changes (it becomes time_ms, ${ms.min} to ${ms.max})`,
      },
      ...params,
      time_ms: { ...ms, default: null, required: undefined as never },
    };
    delete (spec.params.time_ms as { required?: true }).required;
    spec.check = (p) =>
      (p.time_beats === undefined) === (p.time_ms === undefined)
        ? 'delay takes exactly one of time_beats or time_ms'
        : undefined;
  }
  return spec;
}

let registry: Record<string, DeviceSpec> | undefined;

/** Every device, by name, in the engine's order: instruments, then effects. */
export function devices(): Record<string, DeviceSpec> {
  registry ??= Object.fromEntries(
    [...musicDevices().values()].map((def) => [def.name, specFromEngine(def)]),
  );
  return registry;
}

/** Every device by name (read when first used: the named instruments come from a file). */
export const DEVICES: Record<string, DeviceSpec> = new Proxy(
  {},
  {
    get: (_t, key) => devices()[key as string],
    has: (_t, key) => (key as string) in devices(),
    ownKeys: () => Reflect.ownKeys(devices()),
    getOwnPropertyDescriptor: (_t, key) => Object.getOwnPropertyDescriptor(devices(), key),
  },
);

export const deviceNames = (): string[] => Object.keys(devices());

const spec = (name: string): DeviceSpec | undefined => devices()[name];

/** Whether a device makes sound from notes (an instrument) or changes sound (an effect). */
export function deviceKind(name: string): DeviceSpec['kind'] | undefined {
  return spec(name)?.kind;
}

/** Every device name, by kind: what an error about an unknown device lists. */
export function deviceNamesText(): string {
  const of = (kind: DeviceSpec['kind']) =>
    deviceNames()
      .filter((n) => spec(n)?.kind === kind)
      .join(', ');
  return `Instruments: ${of('instrument')}. Effects: ${of('effect')}`;
}

function paramText(key: string, p: DeviceParam): string {
  const must = 'required' in p && p.required ? ', required' : '';
  if (p.kind === 'number') {
    const def = p.required ? '' : p.default === null ? ', no default' : `, default ${p.default}`;
    const unit = p.unit ? ` ${p.unit}` : '';
    return `${key}: ${p.min} to ${p.max}${unit}${def}${must} (${p.about}${p.automatable ? '; automatable' : ''})`;
  }
  if (p.kind === 'choice') {
    const def = p.required || p.default === null ? '' : `, default ${p.default}`;
    return `${key}: one of ${p.values.join(', ')}${def}${must} (${p.about})`;
  }
  if (p.kind === 'boolean') {
    const def = p.default === null ? '' : `, default ${p.default}`;
    return `${key}: true or false${def}${must} (${p.about})`;
  }
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
  if (p.kind === 'choice') {
    const [first, ...rest] = p.values.map((v) => z.literal(v));
    if (!first) return z.never();
    return opt(
      rest.length
        ? z.union([first, ...rest] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
        : first,
    );
  }
  if (p.kind === 'boolean') return opt(z.boolean());
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
      if (v !== undefined || p.filled)
        out[key] = applied(p.params, (v ?? {}) as Record<string, unknown>);
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
