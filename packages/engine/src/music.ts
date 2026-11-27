import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CfError } from '@cuttingfloor/schema';
import * as z from 'zod/v4';
import { BIN, run } from './exec.ts';
import { type DeviceDef, musicDevices, type ParamDef } from './music-catalog.ts';
import { probe } from './probe.ts';
import { type LoudnessFacts, measureLoudness } from './speech.ts';

// The music engine, cf-music (tools/music): a render project (JSON, every time in seconds; the
// caller converts beats) in, a 24-bit WAV (or an MP3 made from it) and its facts out. The project
// is checked here against its schema, the device catalog (music-catalog.ts) and the limits below;
// the engine checks it again with the files in hand (references, routing loops, ranges against
// file lengths) and fails before rendering, so a wrong project never comes back as silence.
// Nothing is chosen for the caller: no tempo, key, loudness target, quantising or tidying.

/**
 * Limits that protect the platform: the only numbers renderMusic holds. Each is refused with the
 * limit in the error, never applied quietly. TO SIZE ON THE HOSTED MACHINE: these are first
 * guesses from an Apple M3 Max (arm64) and must be measured on the hosted servers (Fly.io,
 * x86-64) before they are relied on. Callers may pass their own.
 */
export const MUSIC_LIMITS = {
  /** Longest render: until (plus the tail), seconds. A render always runs from 0. */
  renderSeconds: 600,
  /** Most a tail may run past until when tail_db is given, seconds. */
  tailSeconds: 30,
  tracks: 64,
  devicesPerTrack: 16,
  masterDevices: 16,
  /** Notes in the whole project. */
  notes: 50_000,
  /** Audio clips in the whole project. */
  clips: 1_000,
  /** Automation points in the whole project. */
  automationPoints: 50_000,
  /** Different audio files the project reads (samplers and clips). */
  files: 64,
  /** Longest audio file a project may read, seconds (each is decoded whole). */
  fileSeconds: 3600,
  /** Wall clock for one render, decoding the files included. */
  timeoutMs: 10 * 60_000,
};
export type MusicLimits = typeof MUSIC_LIMITS;

/** Where the image keeps the named instruments and kits (tools/music/content). */
export const MUSIC_CONTENT =
  process.env.CUTTINGFLOOR_MUSIC_CONTENT ?? '/usr/share/cuttingfloor/music';

const id = z.string().min(1).max(200);
const seconds = z.number().min(0).max(1e6);

const MusicNote = z.strictObject({
  /** Seconds from the start of the project. */
  start: seconds,
  length: z.number().gt(0).max(1e6),
  /** MIDI pitch, decimals allowed: 60 is middle C, 60.5 a quarter-tone above. */
  pitch: z.number().min(0).max(127),
  velocity: z.number().int().min(1).max(127),
});

const MusicClip = z.strictObject({
  /** Absolute path of the audio (any file FFmpeg reads). */
  file: z.string().min(1),
  /** Where it starts in the project, seconds. */
  at: seconds,
  /** Source range, seconds; until left out is the file's end. */
  from: seconds.default(0),
  until: seconds.optional(),
  gain_db: z.number().min(-96).max(24).default(0),
  /** Stretch the source range to this many seconds, pitch unchanged. */
  stretch_to: z.number().gt(0).max(1e6).optional(),
});

const MusicSend = z.strictObject({
  id,
  /** The track that receives it. */
  to: id,
  level_db: z.number().min(-120).max(6),
  /** Taken before the track's own gain and pan. */
  before_gain: z.boolean().default(false),
});

const MusicDevice = z.strictObject({
  id,
  name: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  /** false: bypassed (left out of the chain). */
  enabled: z.boolean().default(true),
});

const MusicTrack = z.strictObject({
  id,
  gain_db: z.number().min(-120).max(24).default(0),
  pan: z.number().min(-1).max(1).default(0),
  /** master, or the id of the track it plays through (a group). */
  output: id.default('master'),
  /** Instruments first (each plays every note), then effects in order. */
  devices: z.array(MusicDevice).default([]),
  sends: z.array(MusicSend).default([]),
  notes: z.array(MusicNote).default([]),
  clips: z.array(MusicClip).default([]),
});

const MusicPoint = z.strictObject({
  time: seconds,
  value: z.number(),
  /** The shape from this point to the next. */
  curve: z.enum(['hold', 'linear', 'smooth']),
});

const MusicTarget = z.union([
  z.strictObject({ track: id, param: z.enum(['gain_db', 'pan']) }),
  z.strictObject({ send: id, param: z.literal('level_db') }),
  /** A device param, nested ones by path: filter.cutoff_hz, bands[0].gain_db. */
  z.strictObject({ device: id, param: z.string().min(1) }),
]);

export const MusicProject = z.strictObject({
  sample_rate: z.union([z.literal(44100), z.literal(48000)]),
  /** The range rendered, seconds. */
  from: seconds.default(0),
  until: z.number().gt(0).max(1e6),
  /** Run past until until the output falls under this level (dBFS), and report when. */
  tail_db: z.number().min(-200).lt(0).optional(),
  /** Render only these tracks' notes and clips (groups and returns they reach still play). */
  alone: z.array(id).optional(),
  tracks: z.array(MusicTrack),
  master: z.strictObject({ devices: z.array(MusicDevice).default([]) }).default({ devices: [] }),
  automation: z
    .array(z.strictObject({ target: MusicTarget, points: z.array(MusicPoint).min(1) }))
    .default([]),
});
/** A render project as callers write it: params and fields with defaults may be left out. */
export type MusicProjectInput = z.input<typeof MusicProject>;
export type MusicProject = z.output<typeof MusicProject>;

export interface MusicRender {
  /** The audio: a 24-bit stereo WAV, or an MP3 made from it. */
  file: string;
  format: 'wav' | 'mp3';
  sample_rate: number;
  frames: number;
  length_seconds: number;
  from_seconds: number;
  /** With tail_db: when the output fell under it, in project seconds. */
  ends_seconds?: number;
  /** With tail_db: the sound was still over it when the tail limit ran out. */
  tail_capped?: boolean;
  /** Highest sample, dBFS (above 0 means samples were clipped in the 24-bit file). */
  sample_peak_dbfs: number | null;
  clipped_samples: number;
  /** Integrated loudness, true peak and the rest, measured on the WAV. */
  loudness: LoudnessFacts;
  load_ms: number;
  render_ms: number;
}

//==============================================================================

function paramSchema(def: ParamDef): z.ZodType {
  switch (def.kind) {
    case 'number':
    case 'integer': {
      let s = z.number().min(def.min).max(def.max);
      if (def.kind === 'integer') s = s.int();
      if (def.default !== undefined) return s.default(def.default);
      return def.kind === 'number' && def.optional ? s.optional() : s;
    }
    case 'boolean':
      return def.default !== undefined ? z.boolean().default(def.default) : z.boolean();
    case 'choice': {
      const s = z.union(def.choices.map((c) => z.literal(c)) as [z.ZodLiteral, z.ZodLiteral]);
      return def.default !== undefined ? s.default(def.default as never) : s;
    }
    case 'file':
      return z.string().min(1);
    case 'object': {
      const s = fieldsSchema(def.fields);
      return def.optional ? s.optional() : s;
    }
    case 'list': {
      const s = z.array(fieldsSchema(def.fields)).min(def.min_items).max(def.max_items);
      return def.optional ? s.optional() : s;
    }
  }
}

function fieldsSchema(fields: Record<string, ParamDef>) {
  return z.strictObject(
    Object.fromEntries(Object.entries(fields).map(([k, d]) => [k, paramSchema(d)])),
  );
}

const deviceSchemas = new Map<string, z.ZodType>();

function describe(def: ParamDef): string {
  switch (def.kind) {
    case 'number':
    case 'integer':
      return `${def.min} to ${def.max}${def.kind === 'number' && def.unit ? ` ${def.unit}` : ''}${def.default !== undefined ? `, default ${def.default}` : def.kind === 'number' && def.optional ? ', optional' : ', required'}`;
    case 'boolean':
      return `true or false${def.default !== undefined ? `, default ${def.default}` : ''}`;
    case 'choice':
      return `${def.choices.join('|')}${def.default !== undefined ? `, default ${def.default}` : ', required'}`;
    case 'file':
      return 'an audio file path, required';
    case 'object':
      return `{${Object.entries(def.fields)
        .map(([k, d]) => `${k}: ${describe(d)}`)
        .join('; ')}}${def.optional ? ', optional' : ''}`;
    case 'list':
      return `${def.min_items} to ${def.max_items} of {${Object.entries(def.fields)
        .map(([k, d]) => `${k}: ${describe(d)}`)
        .join('; ')}}${def.optional ? ', optional' : ''}`;
  }
}

/** One device's params with their ranges, units and defaults, for an error's hint. */
export function describeDevice(device: DeviceDef): string {
  return `${device.name}: ${Object.entries(device.params)
    .map(([k, d]) => `${k} (${describe(d)})`)
    .join('; ')}`;
}

function issuePath(prefix: string, path: ReadonlyArray<PropertyKey>): string {
  let out = prefix;
  for (const p of path) out += typeof p === 'number' ? `[${p}]` : `${out ? '.' : ''}${String(p)}`;
  return out;
}

function refused(prefix: string, error: z.ZodError, hint?: string): CfError {
  const first = error.issues[0];
  const path = issuePath(prefix, first?.path ?? []);
  return new CfError('bad_request', `${path}: ${first?.message ?? 'invalid'}`, {
    detail: { path, issues: error.issues.length },
    ...(hint ? { hint } : {}),
  });
}

/** A device with every param filled in from the catalog's defaults, or a typed refusal. */
function device(d: z.output<typeof MusicDevice>, path: string): z.output<typeof MusicDevice> {
  const def = musicDevices().get(d.name);
  if (!def) {
    throw new CfError('bad_request', `${path}.name: unknown device ${d.name}`, {
      detail: { path: `${path}.name` },
      hint: `Devices: ${[...musicDevices().keys()].join(', ')}`,
    });
  }
  let schema = deviceSchemas.get(d.name);
  if (!schema) {
    schema = fieldsSchema(def.params);
    deviceSchemas.set(d.name, schema);
  }
  const parsed = schema.safeParse(d.params);
  if (!parsed.success) throw refused(`${path}.params`, parsed.error, describeDevice(def));
  return { ...d, params: parsed.data as Record<string, unknown> };
}

/**
 * Checks a project against the schema, the catalog and the limits, and fills in every default.
 * Throws a bad_request or limit_exceeded CfError that names the path of what was wrong.
 */
export function checkMusicProject(
  input: unknown,
  limits: MusicLimits = MUSIC_LIMITS,
): MusicProject {
  const parsed = MusicProject.safeParse(input);
  if (!parsed.success) throw refused('', parsed.error);
  const p = parsed.data;
  const over = (what: string, value: number, limit: number) => {
    if (value > limit) {
      throw new CfError('limit_exceeded', `${what}: ${value}, over the limit of ${limit}`, {
        detail: { limit, value },
        hint: 'Render a shorter range, or split the work into several renders',
      });
    }
  };
  if (p.until <= p.from) {
    throw new CfError('bad_request', 'until: must be after from', { detail: { path: 'until' } });
  }
  over(
    'Render length (until plus the tail), seconds',
    p.until + (p.tail_db !== undefined ? limits.tailSeconds : 0),
    limits.renderSeconds,
  );
  over('Tracks', p.tracks.length, limits.tracks);
  over('Master devices', p.master.devices.length, limits.masterDevices);
  over(
    'Notes',
    p.tracks.reduce((n, t) => n + t.notes.length, 0),
    limits.notes,
  );
  over(
    'Clips',
    p.tracks.reduce((n, t) => n + t.clips.length, 0),
    limits.clips,
  );
  over(
    'Automation points',
    p.automation.reduce((n, a) => n + a.points.length, 0),
    limits.automationPoints,
  );
  for (const t of p.tracks)
    over(`Devices on track ${t.id}`, t.devices.length, limits.devicesPerTrack);
  return {
    ...p,
    tracks: p.tracks.map((t, i) => ({
      ...t,
      devices: t.devices.map((d, k) => device(d, `tracks[${i}].devices[${k}]`)),
    })),
    master: { devices: p.master.devices.map((d, k) => device(d, `master.devices[${k}]`)) },
  };
}

/** Every audio file a project reads: sampler params and clips. */
function projectFiles(p: MusicProject): string[] {
  const files = new Set<string>();
  for (const t of p.tracks) {
    for (const c of t.clips) files.add(c.file);
    for (const d of t.devices) if (d.name === 'sampler') files.add(String(d.params.file));
  }
  return [...files];
}

/** Decodes a file's audio to 32-bit float WAV at the project's rate, mono or stereo. */
async function decode(
  file: string,
  dest: string,
  rate: number,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  try {
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-i',
        `file:${file}`,
        '-vn',
        // Mono stays mono (the engine plays it on both channels at full level); more than two
        // channels are mixed down to stereo.
        '-af',
        'aformat=channel_layouts=mono|stereo',
        '-ar',
        String(rate),
        '-c:a',
        'pcm_f32le',
        '-f',
        'wav',
        '-y',
        `file:${dest}`,
      ],
      { timeoutMs, ...(signal ? { signal } : {}) },
    );
  } catch (error) {
    if (error instanceof CfError && error.code === 'engine_error' && !error.hint) {
      throw new CfError('bad_request', `${file} has no audio FFmpeg can read`, {
        detail: { file, ...(error.detail ?? {}) },
      });
    }
    throw error;
  }
}

/** The engine's own refusal (the last line of its stderr), as a CfError. */
function engineRefusal(error: unknown): unknown {
  if (!(error instanceof CfError) || error.code !== 'engine_error') return error;
  const stderr = String(error.detail?.stderr ?? '');
  const last = stderr.trim().split('\n').at(-1) ?? '';
  try {
    const parsed = JSON.parse(last) as {
      error?: { code?: string; message?: string; path?: string };
    };
    if (parsed.error?.message) {
      const code = z
        .enum(['bad_request', 'not_found', 'engine_error', 'render_failed'])
        .safeParse(parsed.error.code);
      return new CfError(code.success ? code.data : 'engine_error', parsed.error.message, {
        ...(parsed.error.path ? { detail: { path: parsed.error.path } } : {}),
      });
    }
  } catch {
    // Not the engine's JSON: the failure as run() reported it.
  }
  return error;
}

/**
 * Renders a project to `dest` (.wav, or .mp3 with format mp3) with cf-music and measures it.
 * The files the project names are decoded by FFmpeg to the project's rate first; nothing renders
 * until the project and every file have been checked.
 */
export async function renderMusic(
  input: unknown,
  dest: string,
  options: {
    format?: 'wav' | 'mp3';
    limits?: MusicLimits;
    signal?: AbortSignal;
    onQueue?: (ahead: number) => void;
    /** Where the decoded files and the engine's project go; a temp folder of its own otherwise. */
    workDir?: string;
  } = {},
): Promise<MusicRender> {
  const limits = options.limits ?? MUSIC_LIMITS;
  const format = options.format ?? 'wav';
  // One wall clock for the whole render: each step gets what is left of it.
  const deadline = Date.now() + limits.timeoutMs;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) {
      throw new CfError(
        'engine_error',
        `The render took longer than ${limits.timeoutMs} ms and was stopped`,
        {
          hint: 'The engine took too long and was stopped',
        },
      );
    }
    return ms;
  };
  const project = checkMusicProject(input, limits);
  const files = projectFiles(project);
  if (files.length > limits.files) {
    throw new CfError(
      'limit_exceeded',
      `Audio files: ${files.length}, over the limit of ${limits.files}`,
      {
        detail: { limit: limits.files, value: files.length },
      },
    );
  }
  for (const f of files) {
    if (!isAbsolute(f)) throw new CfError('bad_request', `${f}: must be an absolute path`);
    try {
      await access(f);
    } catch {
      throw new CfError('not_found', `No such file: ${f}`, { detail: { file: f } });
    }
    const probed = await probe(f, options.signal);
    if (!probed.audio)
      throw new CfError('bad_request', `${f} has no audio`, { detail: { file: f } });
    if ((probed.duration ?? 0) > limits.fileSeconds) {
      throw new CfError(
        'limit_exceeded',
        `${f} is ${probed.duration} s long, over the limit of ${limits.fileSeconds} s`,
        {
          detail: { file: f, limit: limits.fileSeconds, value: probed.duration },
          hint: 'Cut the part you need into a shorter file first',
        },
      );
    }
  }
  const work = options.workDir ?? (await mkdtemp(join(tmpdir(), 'cf-music-')));
  const signal = options.signal;
  try {
    // Each file once, at the project's rate: the engine reads only these.
    const decoded = new Map<string, string>();
    for (const [i, f] of files.entries()) {
      const to = join(work, `in-${i}.wav`);
      await decode(f, to, project.sample_rate, left(), signal);
      decoded.set(f, to);
    }
    const engineProject = {
      version: 1,
      ...project,
      ...(project.tail_db !== undefined ? { tail_max_seconds: limits.tailSeconds } : {}),
      tracks: project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({ ...c, file: decoded.get(c.file) })),
        devices: t.devices.map((d) =>
          d.name === 'sampler'
            ? { ...d, params: { ...d.params, file: decoded.get(String(d.params.file)) } }
            : d,
        ),
      })),
    };
    const json = join(work, 'project.json');
    await writeFile(json, JSON.stringify(engineProject));
    const wav = format === 'wav' ? dest : join(work, 'render.wav');
    let stdout: string;
    try {
      ({ stdout } = await run(BIN.music, ['render', json, wav, '--content', MUSIC_CONTENT], {
        heavy: true,
        timeoutMs: left(),
        ...(signal ? { signal } : {}),
        ...(options.onQueue ? { onQueue: options.onQueue } : {}),
      }));
    } catch (error) {
      throw engineRefusal(error);
    }
    const facts = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      ok?: boolean;
      sample_rate: number;
      frames: number;
      length_seconds: number;
      from_seconds: number;
      ends_seconds?: number;
      tail_capped?: boolean;
      sample_peak_dbfs: number | null;
      clipped_samples: number;
      load_ms: number;
      render_ms: number;
    };
    if (!facts.ok) throw new CfError('render_failed', 'cf-music returned no result');
    const loudness = await measureLoudness(wav, signal ? { signal } : {});
    if (format === 'mp3') {
      await run(
        BIN.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          `file:${wav}`,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '320k',
          '-y',
          `file:${dest}`,
        ],
        { heavy: true, timeoutMs: left(), ...(signal ? { signal } : {}) },
      );
    }
    return {
      file: dest,
      format,
      sample_rate: facts.sample_rate,
      frames: facts.frames,
      length_seconds: facts.length_seconds,
      from_seconds: facts.from_seconds,
      ...(facts.ends_seconds !== undefined ? { ends_seconds: facts.ends_seconds } : {}),
      ...(facts.tail_capped !== undefined ? { tail_capped: facts.tail_capped } : {}),
      sample_peak_dbfs: facts.sample_peak_dbfs,
      clipped_samples: facts.clipped_samples,
      loudness,
      load_ms: facts.load_ms,
      render_ms: facts.render_ms,
    };
  } finally {
    if (!options.workDir) await rm(work, { recursive: true, force: true });
  }
}
