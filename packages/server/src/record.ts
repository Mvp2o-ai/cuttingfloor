import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMicrophoneTake,
  applyPadsTake,
  beatsToSeconds,
  defineCollection,
  findPart,
  type LoopGrid,
  loopGrid,
  ownerKey,
  partPads,
  positionAt,
  regionPlace,
  scoreAtSpeed,
  scoreEnd,
  takeAgain,
  takeDigest,
  ticksToSeconds,
} from '@cuttingfloor/core';
import { soundOffset } from '@cuttingfloor/engine';
import { errorResult, type Job, type JobContext, type JobResult } from '@cuttingfloor/jobs';
import {
  CfError,
  deviceKind,
  expiry,
  nativeView,
  pitchName,
  pitchNumber,
  RECORD_LIMITS,
  type RecordDelay,
  type RecordInputKind,
  RecordMicrophoneTake,
  RecordPadsTake,
  RecordSessionInput,
  type RecordSessionResult,
  type RecordTakeInput,
  type ScoreDoc,
  type ScoreRecordInput,
  type ScoreRecordResult,
  type ScoreRecordTake,
  span,
} from '@cuttingfloor/schema';
import type { OwnerLimits } from './meter.ts';
import { asStereo16, clickWav, mono, readWav, wav16, wavFormat } from './record-audio.ts';
import { mediaResolver } from './render.ts';
import { ok, waitForChange } from './result.ts';
import type { Runtime } from './runtime.ts';
import { beatsOf, renderScoreSound } from './score-render.ts';
import { withSound } from './sound.ts';
import { startUpload } from './storage.ts';
import { importUpload } from './tools/media.ts';

// score.record's sessions: the tool opens one (a job waiting for a person, and a signed link to
// play it in a browser); POST /v1/record.session renders the loop and the pad sounds at a speed;
// POST /v1/record.take takes what was played, once, and the job puts it in the score. Contract
// v1.1 with the phone app's team (plans/music/mobile-native-record.md): its shapes are fixed.

/**
 * A score's sound over a range of seconds of `doc` (its own tempo map: a copy at a speed renders
 * at that speed), to a WAV whose first sample is at `from_seconds`. `parts` renders only those
 * parts' own notes and audio; `tail_db` runs past `until_seconds` until the sound falls under it.
 * `done` (when given) is called once the file has been read, to remove it.
 */
export type RenderScoreDoc = (
  owner: string,
  doc: ScoreDoc,
  opts: {
    from_seconds: number;
    until_seconds: number;
    parts?: string[];
    tail_db?: number;
    signal?: AbortSignal;
  },
) => Promise<{
  wav: string;
  sample_rate: number;
  frames: number;
  parts_sounded: string[];
  ends_seconds?: number;
  done?: () => Promise<void>;
}>;

export interface RecordDeps {
  runtime: Runtime;
  renderScoreDoc?: RenderScoreDoc | undefined;
  limits?: (() => Promise<OwnerLimits>) | undefined;
}

/** What a session holds from the call that opened it. */
export interface RecordSession {
  owner: string;
  job_id: string;
  score_id: string;
  part_id: string;
  input: RecordInputKind;
  from_beats: number;
  until_beats: number;
  click: boolean;
  count_in_beats: number;
  velocity?: number;
  length_beats?: number;
  pads: Array<{ pitch: number; name: string; plays?: string }>;
  expires_at: string;
  url: string;
  upload?: { upload_id: string; url: string; max_bytes: number };
}

export const RECORD_SESSIONS = defineCollection<RecordSession>({
  name: 'record_sessions',
  scope: 'owner',
  fs: { dir: 'record-sessions' },
});

/** A session's one take: the body as it came, its digest, and whether its placing has begun. */
export interface RecordTakeRecord {
  digest: string;
  at: string;
  started: boolean;
  body: RecordTakeInput;
}

export const RECORD_TAKES = defineCollection<RecordTakeRecord>({
  name: 'record_takes',
  scope: 'owner',
  fs: { dir: 'record-takes' },
});

/** The pad sounds are rendered to here: the 16-bit floor, below which a 16-bit WAV is silence. */
const PAD_TAIL_DB = -96;

const SCORE_BPM = { min: 20, max: 400 };
const fmt = (x: number) => String(Math.round(x * 1e6) / 1e6);

/** The server's own way to a score's sound: the music engine, through score-render.ts. */
function engineRender(rt: Runtime): RenderScoreDoc {
  return async (owner, doc, opts) => {
    const sound = await renderScoreSound(rt, owner, doc, {
      ...beatsOf(doc, opts),
      ...(opts.parts ? { parts: opts.parts } : {}),
      ...(opts.tail_db !== undefined ? { tail_db: opts.tail_db } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return {
      wav: sound.file,
      sample_rate: sound.render.sample_rate,
      frames: sound.render.frames,
      parts_sounded: sound.parts_sounded,
      ...(sound.render.ends_seconds !== undefined
        ? { ends_seconds: sound.render.ends_seconds }
        : {}),
      done: sound.done,
    };
  };
}

// ---------------------------------------------------------------------------- the link

/** The signed link of a session: its page in a browser, and the credential the page sends. */
async function sign(rt: Runtime, path: string, exp: number): Promise<string> {
  return createHmac('sha256', await rt.secret())
    .update(`${path}\n${exp}`)
    .digest('base64url');
}

async function recordLink(rt: Runtime, owner: string, jobId: string, exp: number): Promise<string> {
  const path = `/record/${ownerKey(owner)}/${jobId}`;
  return `${rt.config.publicUrl}${path}?exp=${exp}&sig=${await sign(rt, path, exp)}`;
}

/**
 * The session a signed record link names, or undefined when the link is not one this server
 * signed or it has expired. Takes a full url or a path with its query.
 */
export async function verifyRecordLink(
  rt: Runtime,
  link: string,
): Promise<{ key: string; job_id: string } | undefined> {
  let url: URL;
  try {
    url = new URL(link, 'http://record.invalid');
  } catch {
    return undefined;
  }
  const m = /^\/record\/([A-Za-z0-9_-]{1,64})\/(j_[0-9a-z]{26})$/.exec(url.pathname);
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  if (!m || !exp || !sig || !(Number(exp) > Date.now())) return undefined;
  const expected = Buffer.from(await sign(rt, url.pathname, Number(exp)), 'base64url');
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return { key: m[1] as string, job_id: m[2] as string };
}

// ---------------------------------------------------------------------------- opening a session

const limitError = (message: string, limit: number | string, hint?: string) =>
  new CfError('limit_exceeded', `${message} (a limit of the platform)`, {
    detail: { limit },
    ...(hint ? { hint } : {}),
  });

/** Every tempo of a rendition stays within what a score plays, or the speed is refused. */
function checkSpeed(doc: ScoreDoc, speed: number): void {
  const { min, max } = RECORD_LIMITS.speed;
  if (!(speed >= min && speed <= max)) {
    throw limitError(`speed ${speed} is outside ${min} to ${max}`, `${min} to ${max}`);
  }
  for (const t of doc.tempo) {
    const bpm = t.bpm * speed;
    if (bpm < SCORE_BPM.min || bpm > SCORE_BPM.max) {
      throw limitError(
        `At speed ${speed} the tempo ${t.bpm} (from beat ${fmt(t.at)}) plays at ${fmt(bpm)} bpm; scores play ${SCORE_BPM.min} to ${SCORE_BPM.max}`,
        `${SCORE_BPM.min} to ${SCORE_BPM.max} bpm`,
      );
    }
  }
}

function checkLoopSeconds(grid: LoopGrid): void {
  if (grid.seconds > RECORD_LIMITS.loopSeconds) {
    throw limitError(
      `The loop lasts ${fmt(grid.seconds)} s at speed ${grid.speed}; a loop lasts up to ${RECORD_LIMITS.loopSeconds} s`,
      RECORD_LIMITS.loopSeconds,
      'A shorter range (from_beats, until_beats), or a faster speed',
    );
  }
}

/** Sessions of the owner still waiting for a take. */
async function openSessions(rt: Runtime, owner: string): Promise<Job[]> {
  const now = Date.now();
  return rt.jobs.store.list(owner, {
    status: 'working',
    limit: 1000,
    where: (j) => j.tool === 'score.record' && Date.parse(j.meta?.waits_until ?? '') > now,
  });
}

/** score.record: checks the arguments, opens the session (a job waiting for its take), answers. */
export async function openRecordSession(
  deps: RecordDeps,
  owner: string,
  args: ScoreRecordInput,
): Promise<ScoreRecordResult> {
  const rt = deps.runtime;
  const doc = await rt.scores.get(owner, args.score_id);
  const part = findPart(doc, args.part_id);
  const warnings: string[] = [];
  const end = scoreEnd(doc);
  if (args.until_beats === undefined && end <= 0) {
    throw new CfError(
      'bad_request',
      'until_beats is required: this score has no regions yet, so it has no end to loop to',
    );
  }
  const until = args.until_beats ?? end;
  const grid = loopGrid(doc, {
    from_beats: args.from_beats,
    until_beats: until,
    speed: 1,
    count_in_beats: args.count_in_beats,
  });
  checkLoopSeconds(grid);
  let pads: RecordSession['pads'] = [];
  if (args.input === 'pads') {
    const missing = (['velocity', 'length_beats'] as const).filter((k) => args[k] === undefined);
    if (missing.length) {
      throw new CfError(
        'bad_request',
        `Pads need ${missing.join(' and ')}: ${missing.includes('velocity') ? 'the strength a tap is stored with where the device measures none (most phones do not), 1 to 127' : ''}${missing.length === 2 ? '; ' : ''}${missing.includes('length_beats') ? 'the length each tapped note is stored with' : ''}. Nothing is assumed`,
      );
    }
    const found = partPads(doc, part.id);
    if (args.pads) {
      const seen = new Set<number>();
      pads = args.pads.map((p, i) => {
        const pitch = pitchNumber(p);
        if (seen.has(pitch)) {
          throw new CfError('bad_request', `pads[${i}]: pitch ${pitch} is named twice`);
        }
        seen.add(pitch);
        const plays = found.pads.find((f) => f.pitch === pitch)?.plays;
        return { pitch, name: pitchName(pitch).name, ...(plays ? { plays } : {}) };
      });
    } else {
      // The agent names the pads: a kit has dozens of sounds, and which ones this layer needs
      // is its choice. The part's own sounds are listed so the call can be made again.
      const has = found.pads.map((f) => `${f.name} ${f.plays.replace(/ \([^)]*\)$/, '')}`);
      throw new CfError('bad_request', 'pads is required: the pitches that get a pad', {
        hint: has.length
          ? `Part ${part.id} plays: ${has.join(', ')}. pads: the ones this take needs, as in notes (C2, 38, F#2)`
          : 'pads: the pitches to give a pad, as in notes (C3, 60, F#4)',
      });
    }
    const instrument = part.devices.some(
      (d) => d.enabled !== false && deviceKind(d.name) === 'instrument',
    );
    if (!instrument) {
      warnings.push(
        `Part ${part.id} has no instrument yet: its pads are silent, and so are the notes the take makes, until one is on it`,
      );
    }
  } else {
    const padOnly = (['velocity', 'length_beats', 'pads'] as const).filter(
      (k) => args[k] !== undefined,
    );
    if (padOnly.length) {
      throw new CfError(
        'bad_request',
        `${padOnly.join(', ')} ${padOnly.length === 1 ? 'is' : 'are'} for pads; a microphone take is the recording as made`,
      );
    }
  }
  const open = await openSessions(rt, owner);
  if (open.length >= RECORD_LIMITS.sessionsOpen) {
    throw limitError(
      `${open.length} sessions are already waiting for a take; an account has up to ${RECORD_LIMITS.sessionsOpen} at once`,
      RECORD_LIMITS.sessionsOpen,
      `Waiting sessions: ${open.map((j) => j.id).join(', ')}. job.cancel ends one; each ends on its own ${span(RECORD_LIMITS.sessionMs)} after it opened`,
    );
  }
  const exp = Date.now() + RECORD_LIMITS.sessionMs;
  const expiresAt = new Date(exp).toISOString();
  const job = await rt.jobs.store.create({
    owner,
    tool: 'score.record',
    meta: { score_id: args.score_id, waits_until: expiresAt },
    statusMessage: 'waiting for the user to play and send the take',
  });
  const url = await recordLink(rt, owner, job.id, exp);
  const upload =
    args.input === 'microphone'
      ? await startUpload(rt, owner, `take-${job.id}.wav`, undefined, await deps.limits?.())
      : undefined;
  const session: RecordSession = {
    owner,
    job_id: job.id,
    score_id: args.score_id,
    part_id: part.id,
    input: args.input,
    from_beats: args.from_beats,
    until_beats: until,
    click: args.click,
    count_in_beats: args.count_in_beats,
    ...(args.velocity !== undefined ? { velocity: args.velocity } : {}),
    ...(args.length_beats !== undefined ? { length_beats: args.length_beats } : {}),
    pads,
    expires_at: expiresAt,
    url,
    ...(upload
      ? {
          upload: { upload_id: upload.upload_id, url: upload.url, max_bytes: upload.max_bytes },
        }
      : {}),
  };
  await rt.ws.records.collection(RECORD_SESSIONS, { owner }).put(job.id, session);
  const from = positionAt(doc, args.from_beats);
  const to = positionAt(doc, until);
  return {
    job_id: job.id,
    status: 'working',
    input: args.input,
    url,
    native_view: nativeView('record'),
    expires_at: expiresAt,
    expiry: expiry(exp, 'the take is sent from the view or the url before then'),
    loop: {
      from,
      until: to,
      length_beats: until - args.from_beats,
      length_seconds: to.seconds - from.seconds,
    },
    ...(args.input === 'pads' ? { pads } : {}),
    ...(session.upload ? { upload: session.upload } : {}),
    warnings,
    hint: `Where the chat app displays views, the user plays in the view shown with this result; ${url} opens the same in a browser. Nothing is sent until they tap Send. job.get with this job_id gives the take once it is in.`,
  };
}

// ---------------------------------------------------------------------------- the two calls

/** A session and its job, still waiting for its take (or refused, saying why). */
async function liveSession(
  rt: Runtime,
  key: string,
  jobId: string,
): Promise<{ session: RecordSession; job: Job; take?: RecordTakeRecord }> {
  const session = await rt.ws.records.collection(RECORD_SESSIONS, { owner: key }).get(jobId);
  if (!session) {
    throw new CfError('not_found', `No record session ${jobId}`, {
      hint: 'The job_id score.record returned, by the account that called it',
    });
  }
  const job = await rt.jobs.store.get(jobId, session.owner);
  if (!job) throw new CfError('expired', `Record session ${jobId} has ended and gone`);
  const take = await rt.ws.records.collection(RECORD_TAKES, { owner: key }).get(jobId);
  if (job.status === 'cancelled')
    throw new CfError('cancelled', `Record session ${jobId} was cancelled`);
  if (!take && (job.status !== 'working' || Date.parse(session.expires_at) <= Date.now())) {
    throw new CfError('expired', `Record session ${jobId} ended at ${session.expires_at}`, {
      hint: 'score.record opens a new one',
      detail: { expires_at: session.expires_at },
    });
  }
  return { session, job, ...(take ? { take } : {}) };
}

const speedKey = (speed: number) => String(speed);
const loopName = (speed: number) => `loop@${speedKey(speed)}.wav`;
const padName = (pitch: number, speed: number) => `pad-${pitch}@${speedKey(speed)}.wav`;

async function stored(rt: Runtime, owner: string, jobId: string, name: string) {
  const key = rt.outputs.key(owner, jobId, name);
  return (await rt.ws.blobs.head(key)) ? key : undefined;
}

async function storedBytes(rt: Runtime, owner: string, jobId: string, name: string) {
  const key = await stored(rt, owner, jobId, name);
  return key ? readFile(await rt.ws.scratch.materialize(key)) : undefined;
}

async function put(rt: Runtime, owner: string, jobId: string, name: string, bytes: Buffer) {
  await rt.ws.blobs.put(rt.outputs.key(owner, jobId, name), { bytes });
}

/** Renders a range of a document to 16-bit stereo, as the session serves it. */
async function render(
  deps: RecordDeps,
  owner: string,
  doc: ScoreDoc,
  opts: Parameters<RenderScoreDoc>[2],
): Promise<Buffer> {
  const out = await (deps.renderScoreDoc ?? engineRender(deps.runtime))(owner, doc, opts);
  try {
    const raw = await readFile(out.wav);
    const { wav, format } = asStereo16(raw, 'The rendered loop');
    if (format.sample_rate !== doc.sample_rate) {
      throw new CfError(
        'engine_error',
        `The score engine rendered at ${format.sample_rate} Hz; the score is ${doc.sample_rate} Hz`,
      );
    }
    return wav;
  } finally {
    await out.done?.();
  }
}

/** The grid of a session's loop at a speed, every limit checked. */
function sessionGrid(doc: ScoreDoc, s: RecordSession, speed: number): LoopGrid {
  checkSpeed(doc, speed);
  const grid = loopGrid(doc, {
    from_beats: s.from_beats,
    until_beats: s.until_beats,
    speed,
    count_in_beats: s.count_in_beats,
  });
  checkLoopSeconds(grid);
  return grid;
}

/**
 * Where a microphone session's next recording goes. An upload takes one file: once bytes have
 * arrived in it (a recording whose take never got stored, or half of one), another recording
 * sent to it would be refused as already there, or joined onto the first, and the take would
 * place the first recording where the second was played. So a session whose upload holds
 * anything, with no take stored, gets a new one, and the old one goes.
 */
async function sessionUpload(
  deps: RecordDeps,
  key: string,
  session: RecordSession,
): Promise<RecordSession['upload']> {
  if (!session.upload) return undefined;
  const rt = deps.runtime;
  const state = await rt.uploads.state(key, session.upload.upload_id);
  if (state && state.received === 0 && !state.complete) return session.upload;
  const made = await startUpload(
    rt,
    session.owner,
    `take-${session.job_id}.wav`,
    undefined,
    await deps.limits?.(),
  );
  const upload = { upload_id: made.upload_id, url: made.url, max_bytes: made.max_bytes };
  await rt.ws.records
    .collection(RECORD_SESSIONS, { owner: key })
    .put(session.job_id, { ...session, upload });
  if (state) await rt.uploads.remove(key, session.upload.upload_id).catch(() => undefined);
  return upload;
}

/** POST /v1/record.session: what to play and show, rendered at the speed asked. */
export async function recordSessionCall(
  deps: RecordDeps,
  key: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<RecordSessionResult> {
  const rt = deps.runtime;
  const args = parse(RecordSessionInput, body, '{job_id, speed?}');
  const { session, take } = await liveSession(rt, key, args.job_id);
  if (take) {
    throw new CfError('output_exists', `Record session ${args.job_id} has its take already`, {
      hint: 'One take a session: score.record opens a new one',
    });
  }
  const speed = args.speed ?? 1;
  const owner = session.owner;
  const upload = await sessionUpload(deps, key, session);
  const doc = await rt.scores.get(owner, session.score_id);
  const grid = sessionGrid(doc, session, speed);
  const scaled = scoreAtSpeed(doc, speed);
  const name = loopName(speed);
  let loop: Buffer | undefined = await storedBytes(rt, owner, session.job_id, name);
  if (!loop) {
    loop = await render(deps, owner, scaled, {
      from_seconds: grid.start_seconds,
      until_seconds: grid.start_seconds + grid.seconds,
      ...(signal ? { signal } : {}),
    });
    await put(rt, owner, session.job_id, name, loop);
  }
  const format = wavFormat(loop);
  for (const [file, accent] of [
    ['click.wav', false],
    ['accent.wav', true],
  ] as const) {
    if (!(await stored(rt, owner, session.job_id, file)))
      await put(rt, owner, session.job_id, file, clickWav(doc.sample_rate, accent));
  }
  const pads: RecordSessionResult['pads'] = [];
  if (session.input === 'pads') {
    const beatSeconds = (b: number) => beatsToSeconds(scaled.tempo, b);
    const start = beatSeconds(session.from_beats);
    const length = session.length_beats as number;
    for (const pad of session.pads) {
      const file = padName(pad.pitch, speed);
      if (!(await stored(rt, owner, session.job_id, file))) {
        // One note of the pad's pitch through the part's devices, where the loop starts.
        const one = structuredClone(scaled);
        const part = findPart(one, session.part_id);
        one.sources = { pad: { notes: [] } };
        for (const p of one.parts) p.regions = [];
        part.regions = [
          { id: 'pad', type: 'notes', start: session.from_beats, length, source: 'pad', offset: 0 },
        ];
        one.sources.pad = {
          notes: [
            {
              id: 'pad-note',
              pitch: pad.pitch,
              at: 0,
              length,
              velocity: session.velocity as number,
            },
          ],
        };
        const wav = await render(deps, owner, one, {
          from_seconds: start,
          until_seconds: beatSeconds(session.from_beats + length),
          parts: [session.part_id],
          tail_db: PAD_TAIL_DB,
          ...(signal ? { signal } : {}),
        });
        await put(rt, owner, session.job_id, file, wav);
      }
      pads.push({
        pitch: pad.pitch,
        name: pad.name,
        url: (await rt.signOutput(owner, session.job_id, file)).url,
      });
    }
  }
  return {
    job_id: session.job_id,
    input: session.input,
    expires_at: session.expires_at,
    speed,
    loop: {
      url: (await rt.signOutput(owner, session.job_id, name)).url,
      sample_rate: format.sample_rate,
      frames: format.frames,
      seconds: format.frames / format.sample_rate,
      beats: grid.beats,
      bars: grid.bars,
    },
    click: {
      on: session.click,
      url: (await rt.signOutput(owner, session.job_id, 'click.wav')).url,
      accent_url: (await rt.signOutput(owner, session.job_id, 'accent.wav')).url,
    },
    count_in: grid.count_in,
    pads,
    ...(upload ? { upload } : {}),
    limits: {
      passes: RECORD_LIMITS.passes,
      taps: RECORD_LIMITS.taps,
      microphone_seconds: RECORD_LIMITS.microphoneSeconds,
    },
  };
}

function parse<T>(
  schema: {
    safeParse(
      v: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
  body: unknown,
  shape: string,
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new CfError(
    'bad_request',
    parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; '),
    { hint: `The body is ${shape}` },
  );
}

/** The loop as rendered at a speed for this session, or why there is none. */
async function rendition(
  rt: Runtime,
  s: RecordSession,
  speed: number,
): Promise<{ frames: number; sample_rate: number; seconds: number; wav: Buffer }> {
  const wav = await storedBytes(rt, s.owner, s.job_id, loopName(speed));
  if (!wav) {
    throw new CfError(
      'bad_request',
      `No loop was rendered at speed ${speed} for this session: positions are in the loop as rendered, so record.session at that speed comes first`,
    );
  }
  const f = wavFormat(wav);
  return { frames: f.frames, sample_rate: f.sample_rate, seconds: f.frames / f.sample_rate, wav };
}

/** Where a position may be in the loop: [0, seconds), or on pass 0 down to the count-in. */
function checkPosition(
  what: string,
  at: number,
  pass: number,
  loop: { seconds: number },
  grid: LoopGrid,
): void {
  const low = pass === 0 ? -grid.count_in.seconds : 0;
  if (at < low || at >= loop.seconds) {
    throw new CfError(
      'bad_request',
      `${what} at ${at} s on pass ${pass} is outside the loop: ${pass === 0 ? `-${fmt(grid.count_in.seconds)} (the count-in)` : '0'} up to ${loop.seconds} s (its frames / sample_rate), not including the end`,
      {
        hint: 'Positions are seconds in that pass of the loop as rendered at speed; a later pass counts up in pass',
      },
    );
  }
  if (pass >= RECORD_LIMITS.passes) {
    throw limitError(
      `${what} is on pass ${pass}; a take spans up to ${RECORD_LIMITS.passes} passes (0 to ${RECORD_LIMITS.passes - 1})`,
      RECORD_LIMITS.passes,
    );
  }
}

/** POST /v1/record.take: what the user played. Safe to repeat; one take a session. */
export async function recordTakeCall(
  deps: RecordDeps,
  key: string,
  body: unknown,
): Promise<{ ok: true }> {
  const rt = deps.runtime;
  // Pads or microphone by what the body carries, so a refusal names the field that is wrong.
  const pads = Boolean(body && typeof body === 'object' && 'taps' in body);
  // A limit like the others (the schema's own refusal of a long list reads as a malformed body).
  const sent = pads ? (body as { taps?: unknown }).taps : undefined;
  if (Array.isArray(sent) && sent.length > RECORD_LIMITS.taps) {
    throw limitError(
      `${sent.length.toLocaleString('en-US')} taps: up to ${RECORD_LIMITS.taps.toLocaleString('en-US')} taps a take`,
      RECORD_LIMITS.taps,
    );
  }
  const args: RecordTakeInput = parse<RecordTakeInput>(
    pads ? RecordPadsTake : RecordMicrophoneTake,
    body,
    '{job_id, speed, taps: [{pitch, at_seconds, pass, velocity?}], delay} for pads, or {job_id, speed, upload_id, starts_at_seconds, passes, delay} for the microphone',
  );
  const { session, job, take } = await liveSession(rt, key, args.job_id);
  const takes = rt.ws.records.collection(RECORD_TAKES, { owner: key });
  if (take) {
    const again = takeAgain(take.digest, args);
    if (again === 'other') {
      throw new CfError(
        'output_exists',
        `Record session ${args.job_id} has its take already, and this one differs from it`,
        {
          hint: 'One take a session; the same body again is answered {ok: true}. score.record opens a new session',
        },
      );
    }
    // The take was kept but its placing never began (the server stopped in between).
    if (!take.started && job.status === 'working') await startPlacing(deps, session, job, key);
    return { ok: true };
  }
  const isPads = 'taps' in args;
  if ((session.input === 'pads') !== isPads) {
    throw new CfError(
      'bad_request',
      `This session takes ${session.input === 'pads' ? 'taps (pads)' : 'a microphone recording (upload_id)'}`,
    );
  }
  const loop = await rendition(rt, session, args.speed);
  const doc = await rt.scores.get(session.owner, session.score_id);
  const grid = sessionGrid(doc, session, args.speed);
  if (isPads) {
    const pads = new Set(session.pads.map((p) => p.pitch));
    args.taps.forEach((t, i) => {
      if (!pads.has(t.pitch)) {
        throw new CfError(
          'bad_request',
          `taps[${i}]: pitch ${t.pitch} has no pad in this session`,
          { hint: `Its pads: ${session.pads.map((p) => p.pitch).join(', ')}` },
        );
      }
      checkPosition(`taps[${i}]`, t.at_seconds, t.pass, loop, grid);
    });
  } else {
    const mic = args as RecordMicrophoneTake;
    checkPosition('starts_at_seconds', mic.starts_at_seconds, 0, loop, grid);
    // Only the upload this session gave out for its take: any other complete upload of the
    // account would be placed, and used up, in its stead.
    if (mic.upload_id !== session.upload?.upload_id) {
      throw new CfError(
        'bad_request',
        `Upload ${mic.upload_id} is not this session's: its recording goes to ${session.upload?.upload_id}`,
        { hint: 'record.session answers the upload (upload_id, url) the next recording goes to' },
      );
    }
    const upload = await rt.uploads.take(session.owner, mic.upload_id);
    const file = upload.file ?? (await rt.ws.scratch.materialize(upload.blob));
    const f = await wavHeader(file, `Upload ${mic.upload_id}`);
    const seconds = f.frames / f.sample_rate;
    if (seconds > RECORD_LIMITS.microphoneSeconds) {
      throw limitError(
        `The recording lasts ${fmt(seconds)} s; a microphone take lasts up to ${RECORD_LIMITS.microphoneSeconds} s`,
        RECORD_LIMITS.microphoneSeconds,
      );
    }
    // Refused while the session is open, where it could only fail once the session is spent.
    const ends = mic.starts_at_seconds + seconds;
    if (!f.frames || ends <= 0) {
      throw new CfError(
        'bad_request',
        `The recording (${fmt(seconds)} s from ${fmt(mic.starts_at_seconds)} s) ends before the loop starts: none of it is in the take`,
        {
          hint: "A take holds sound from the loop's start on; what was recorded in the count-in alone is not one",
        },
      );
    }
    const passes = takePasses(ends, loop.seconds);
    if (passes > RECORD_LIMITS.passes) {
      throw limitError(
        `The recording ends ${fmt(ends)} s into the take, in pass ${passes}; a take spans up to ${RECORD_LIMITS.passes} passes of the loop (${fmt(RECORD_LIMITS.passes * loop.seconds)} s here)`,
        RECORD_LIMITS.passes,
      );
    }
  }
  const record: RecordTakeRecord = {
    digest: takeDigest(args),
    at: new Date().toISOString(),
    started: false,
    body: args,
  };
  if (!(await takes.insertOnce(session.job_id, record))) {
    // Another call with a take got in first: the same rule as a repeat.
    const first = await takes.get(session.job_id);
    if (takeAgain(first?.digest, args) !== 'same') {
      throw new CfError('output_exists', `Record session ${args.job_id} has its take already`);
    }
    return { ok: true };
  }
  await startPlacing(deps, session, job, key);
  return { ok: true };
}

/**
 * The passes of the loop a recording spans, from where it ends in the take. The app cuts a take
 * on a pass's last frame, so an end a rounding's width past a pass is that pass, not the next.
 */
const takePasses = (endsSeconds: number, loopSeconds: number) =>
  Math.max(1, Math.ceil(endsSeconds / loopSeconds - 1e-9));

/** A WAV's format from its first bytes and its size: the recording itself is not read. */
async function wavHeader(file: string, what: string) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 65_536));
    await handle.read(head, 0, head.length, 0);
    const f = wavFormat(head, what, size);
    return f;
  } finally {
    await handle.close();
  }
}

/** Starts the job's work: placing the take in the score. Once, whoever calls. */
async function startPlacing(
  deps: RecordDeps,
  session: RecordSession,
  job: Job,
  key: string,
): Promise<void> {
  const rt = deps.runtime;
  const takes = rt.ws.records.collection(RECORD_TAKES, { owner: key });
  // The job as it stands now, not as it was read before the upload was looked at: a cancel or
  // the expiry in between is not written over.
  const now = (await rt.jobs.store.get(job.id, session.owner)) ?? job;
  if (now.status !== 'working') return;
  // The job stops waiting on a person before the take is marked started. The other way round,
  // a failure in between left a take marked started on a job still waiting: a repeat was then
  // answered ok, nothing placed the take, and the session ran out a day later.
  const { waits_until: _, ...meta } = now.meta ?? {};
  const placing = await rt.jobs.store.update(now, {
    meta,
    statusMessage: 'placing the take in the score',
  });
  if (!(await takes.compareAndSet(session.job_id, { started: false }, { started: true }))) return;
  const take = (await takes.get(session.job_id)) as RecordTakeRecord;
  rt.jobs.start(placing, (ctx) => placeTake(deps, session, take.body, ctx), { lane: 'engine' });
}

// ---------------------------------------------------------------------------- placing the take

async function placeTake(
  deps: RecordDeps,
  session: RecordSession,
  body: RecordTakeInput,
  ctx: JobContext,
): Promise<JobResult> {
  const rt = deps.runtime;
  const owner = session.owner;
  const base = await rt.scores.get(owner, session.score_id);
  const doc = structuredClone(base);
  const loop = {
    part_id: session.part_id,
    from_beats: session.from_beats,
    until_beats: session.until_beats,
    speed: body.speed,
  };
  const common = {
    parent: session.score_id,
    part_id: session.part_id,
    speed: body.speed,
    delay: body.delay as RecordDelay,
  };
  if ('taps' in body) {
    ctx.progress(0.5, 'placing the taps');
    const pads = body as RecordPadsTake;
    const placed = applyPadsTake(doc, {
      ...loop,
      length_beats: session.length_beats as number,
      velocity: session.velocity as number,
      taps: pads.taps,
    });
    doc.parent = session.score_id;
    doc.op = { tool: 'score.record', args: { job_id: session.job_id, input: 'pads' } };
    const id = await rt.scores.put(owner, doc);
    const taps = placed.taps.map((t) => ({
      note_id: t.note_id,
      pitch: t.pitch,
      pass: t.pass,
      at_seconds: t.at_seconds,
      at: positionAt(doc, t.beats),
      velocity: t.velocity,
      velocity_measured: t.velocity_measured,
      sounds: t.sounds,
    }));
    const outside = taps.filter((t) => !t.sounds);
    const measured = taps.filter((t) => t.velocity_measured).length;
    const result: ScoreRecordTake = {
      score_id: id,
      ...common,
      input: 'pads',
      region_id: placed.region_id,
      region: regionPlace(doc, placed.region_id),
      note_ids: placed.note_ids,
      taps,
      outside: outside.map((t) => ({
        note_id: t.note_id,
        pass: t.pass,
        at_seconds: t.at_seconds,
        at: t.at,
      })),
      velocities: { measured, given: taps.length - measured },
      warnings: [
        ...(outside.length
          ? [
              `${outside.length} of ${taps.length} taps were played outside the loop's range (on a later pass, or before it starts): stored as notes outside region ${placed.region_id}, silent until it is widened`,
            ]
          : []),
        ...(taps.length ? [] : ['The take has no taps: the region is empty']),
      ],
    };
    return ok(result) as JobResult;
  }
  const mic = body as RecordMicrophoneTake;
  ctx.progress(0.1, 'importing the recording');
  const { record, job: ingest } = await importUpload(rt, owner, mic.upload_id);
  await ctx.aside(waitJob(rt, owner, ingest.id, ctx.signal));
  const ended = await rt.jobs.store.get(ingest.id, owner);
  if (ended?.result?.isError) {
    const e = ended.result.structuredContent as { code?: string; message?: string } | undefined;
    throw new CfError('bad_request', `The recording did not import: ${e?.message ?? 'unknown'}`);
  }
  const refs = await mediaResolver(rt, owner, [record.media_id]);
  const ref = refs.get(record.media_id);
  if (!ref?.audio) {
    throw new CfError('no_audio', `The recording (${record.media_id}) has no sound`);
  }
  const duration = ticksToSeconds(ref.sound ?? ref.duration ?? 0);
  ctx.progress(0.6, 'measuring where the loop is in the recording');
  // The loop as it played: kept since record.session rendered it, or rendered again where its
  // file has gone (files under a session last as long as their links).
  const loopWav =
    (await storedBytes(rt, owner, session.job_id, loopName(mic.speed))) ??
    (await (async () => {
      const grid = sessionGrid(base, session, mic.speed);
      return render(deps, owner, scoreAtSpeed(base, mic.speed), {
        from_seconds: grid.start_seconds,
        until_seconds: grid.start_seconds + grid.seconds,
        signal: ctx.signal,
      });
    })());
  const correlation = await withSound(
    rt,
    owner,
    { media_id: record.media_id },
    { signal: ctx.signal },
    (sound) => correlate(loopWav, sound.file, mic, ctx.signal),
  ).catch((error: unknown) => {
    // No sound to compare (a silent take): the fact is that nothing could be measured.
    if (error instanceof CfError && (error.code === 'no_audio' || error.code === 'bad_request'))
      return null;
    throw error;
  });
  ctx.progress(0.9, 'placing the recording');
  const placed = applyMicrophoneTake(doc, {
    ...loop,
    starts_at_seconds: mic.starts_at_seconds,
    media: { media_id: record.media_id, name: ref.name, duration },
  });
  doc.parent = session.score_id;
  doc.op = { tool: 'score.record', args: { job_id: session.job_id, input: 'microphone' } };
  const id = await rt.scores.put(owner, doc);
  const before = placed.from;
  const after = duration - placed.until;
  const result: ScoreRecordTake = {
    score_id: id,
    ...common,
    input: 'microphone',
    region_id: placed.region_id,
    region: regionPlace(doc, placed.region_id),
    media_id: record.media_id,
    route: mic.delay.route,
    // The passes the recording spans, counted from the recording (what was sent is not placed by).
    passes: takePasses(
      mic.starts_at_seconds + duration,
      wavFormat(loopWav).frames / wavFormat(loopWav).sample_rate,
    ),
    starts_at_seconds: mic.starts_at_seconds,
    recording: {
      at: positionAt(doc, placed.at_beats),
      end: positionAt(doc, placed.end_beats),
      seconds: duration,
      outside_seconds: { before, after },
    },
    ...(placed.fit_beats !== undefined ? { fit_beats: placed.fit_beats } : {}),
    correlation,
    warnings: [
      ...(before > 0 || after > 0
        ? [
            `${fmt(before)} s of the recording before the loop's start and ${fmt(after)} s after its end are outside region ${placed.region_id}: kept in the media, silent until the region is widened`,
          ]
        : []),
      ...(mic.delay.route === 'speaker'
        ? ['Recorded over the speaker: the loop is in the recording too']
        : []),
    ],
  };
  return ok(result) as JobResult;
}

/** Waits until a job ends. */
async function waitJob(rt: Runtime, owner: string, id: string, signal: AbortSignal) {
  for (;;) {
    if (signal.aborted) throw new CfError('cancelled', 'Cancelled');
    const job = await rt.jobs.store.get(id, owner);
    if (job?.status !== 'working') return;
    await waitForChange(rt.jobs.store, owner, [id], 30, signal);
  }
}

/** Seconds of a recording, from its start, the loop is looked for in: the measure's memory. */
const CORRELATE_SECONDS = 60;

/**
 * Where the loop heard in a recording puts its first sample, by cross-correlation: the loop as
 * it played (pass after pass, from where the recording began) against the recording, searched
 * within half a loop either way of where the device said it began. Both are whitened first: the
 * performance and the room sit on top of the loop and are far louder than it low down.
 */
async function correlate(
  loopWav: Buffer,
  takeFile: string,
  mic: RecordMicrophoneTake,
  signal: AbortSignal,
): Promise<ScoreRecordTake['correlation']> {
  const loop = readWav(loopWav);
  const take = wavFormat(await readFile(takeFile));
  const rate = loop.sample_rate;
  const one = mono(loop);
  const takeSeconds = Math.min(CORRELATE_SECONDS, take.frames / take.sample_rate);
  // What played from the recording's first sample on: the loop's passes, silence before it.
  const s0 = Math.round(mic.starts_at_seconds * rate);
  const length = Math.ceil(takeSeconds * rate) + one.length;
  const heard = new Float32Array(Math.max(1, length));
  for (let i = 0; i < heard.length; i++) {
    const t = s0 + i;
    if (t >= 0) heard[i] = one[t % one.length] as number;
  }
  const dir = await mkdtemp(join(tmpdir(), 'cf-take-'));
  try {
    const a = join(dir, 'heard.wav');
    await writeFile(
      a,
      wav16({ sample_rate: rate, channels: 1, frames: heard.length, data: [heard] }),
    );
    const max = loop.frames / rate / 2;
    const out = await soundOffset(
      { file: a },
      { file: takeFile, until: takeSeconds },
      { maxSeconds: max, whiten: true, signal },
    );
    const at = (x: number) => s0 / rate + x;
    return {
      starts_at_seconds: at(out.offset_seconds),
      strength: out.strength,
      overlap_seconds: out.overlap_seconds,
      next_best: out.next_best
        ? { starts_at_seconds: at(out.next_best.offset_seconds), strength: out.next_best.strength }
        : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The page behind a session's url, with what it needs filled in. */
export async function recordPageSession(
  rt: Runtime,
  link: string,
): Promise<RecordSession | undefined> {
  const found = await verifyRecordLink(rt, link);
  if (!found) return undefined;
  return rt.ws.records.collection(RECORD_SESSIONS, { owner: found.key }).get(found.job_id);
}

/** Ends a session's job in error (cancelled by the agent goes through job.cancel instead). */
export function expiredResult(session: { job_id: string; expires_at: string }): JobResult {
  return errorResult(
    new CfError('expired', `No take was sent before the session ended at ${session.expires_at}`, {
      hint: 'score.record opens a new session',
    }),
  );
}
