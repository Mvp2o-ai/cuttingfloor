import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import {
  RECORD_LIMITS,
  RecordSessionResult,
  ScoreRecordResult,
  ScoreRecordTake,
  ScoreView,
} from '@cuttingfloor/schema';
import { Runtime } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';
import { ScriptKeys } from '../src/keys.ts';
import { readMono, type StubCall, stereoWav, stubRenderer } from './record-stub.ts';

// score.record end to end over HTTP: the tool (POST /v1/score.record, the same server /mcp
// builds), then POST /v1/record.session and /v1/record.take as the phone app calls them (signed
// in with the account's key) and as the view does (the session's signed url as credential),
// with a stand-in score engine that renders a click on every beat.

const exec = promisify(execFile);
const ffmpegFound = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
if (!ffmpegFound && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but FFmpeg is missing');
}
// The score engine itself, where it is (the image): one case renders a real loop and real pads.
const engineFound =
  ffmpegFound &&
  (await exec(process.env.CUTTINGFLOOR_MUSIC ?? 'cf-music', [
    'catalog',
    '--content',
    process.env.CUTTINGFLOOR_MUSIC_CONTENT ?? '/usr/share/cuttingfloor/music',
  ]).then(
    ({ stdout }) => stdout.includes('kit_808'),
    () => false,
  ));
if (!engineFound && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but cf-music or its content is missing');
}

const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ07';
let base: string;
let server: Server;
let bare: Server;
let engineBase: string;
let key: string;
const renders: StubCall[] = [];

type Rec = Record<string, unknown>;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-record-'));
  const runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 2,
    outputUrlTtlMs: 3_600_000,
    maxDownloadBytes: 1024 ** 3,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  const keys = new ScriptKeys(runtime.ws);
  key = (await keys.create(USER, 'record test')).key;
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    scriptKeys: keys,
    renderScoreDoc: stubRenderer(renders),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
  // The same account on a server given no stand-in: it renders with the score engine itself.
  bare = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    scriptKeys: keys,
  });
  await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
  engineBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  bare?.close();
});

/** POST /v1/<op>, signed in with the account's key, or with a session's link instead. */
async function post(
  op: string,
  body: unknown,
  auth: { link?: string; key?: string | null; at?: string } = {},
): Promise<{ status: number; body: Rec }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth.link) headers['x-cuttingfloor-record'] = auth.link;
  else if (auth.key !== null) headers.authorization = `Bearer ${auth.key ?? key}`;
  const r = await fetch(`${auth.at ?? base}/v1/${op}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Rec };
}

async function tool(name: string, args: Rec): Promise<Rec> {
  const r = await post(name, args);
  if (r.status !== 200) throw new Error(`${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** A score at 120 in 4/4 with a drum kit on a part and two bars of notes, and a synth part. */
async function drums(): Promise<{ score_id: string; part_id: string; synth: string }> {
  let { score_id } = (await tool('score.create', {
    tempo: 120,
    meter: { beats: 4, unit: 4 },
    sample_rate: 48_000,
  })) as { score_id: string };
  const part = (await tool('score.add_part', { score_id, name: 'Drums' })) as Rec;
  score_id = part.score_id as string;
  const part_id = part.part_id as string;
  score_id = (await tool('score.add_device', { score_id, part_id, name: 'kit_808' }))
    .score_id as string;
  score_id = (
    await tool('score.add_region', {
      score_id,
      part_id,
      at_beats: 0,
      length_beats: 8,
      notes: [{ pitch: 36, at_beats: 0, length_beats: 0.5, velocity: 100 }],
    })
  ).score_id as string;
  const synth = (await tool('score.add_part', { score_id, name: 'Keys' })) as Rec;
  score_id = synth.score_id as string;
  score_id = (
    await tool('score.add_device', { score_id, part_id: synth.part_id, name: 'grand_piano' })
  ).score_id as string;
  return { score_id, part_id, synth: synth.part_id as string };
}

async function waitJob(jobId: string): Promise<Rec> {
  for (let i = 0; i < 100; i++) {
    const job = await tool('job.get', { job_id: jobId, wait_seconds: 5 });
    if (job.status !== 'working') return job;
  }
  throw new Error(`job ${jobId} still working`);
}

const cancel = (jobId: string) => tool('job.cancel', { job_id: jobId });

const pads = {
  input: 'pads',
  velocity: 100,
  length_beats: 0.25,
  pads: ['C2', 'D2', 'F#2'],
};
const delay = { output_ms: 21.5, input_ms: 0, source: 'reported', route: 'wired' } as const;

describe('score.record over HTTP', () => {
  it('pads: session, take at another speed, repeat-safe, placed where played', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await tool('score.record', {
        score_id,
        part_id,
        ...pads,
        from_beats: 0,
        until_beats: 8,
        click: true,
        count_in_beats: 4,
      }),
    );
    expect(opened.native_view).toEqual({ component: 'record', version: 1 });
    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/record\/user_\w+\/j_\w+\?exp=\d+&sig=/);
    expect(opened.pads?.map((p) => [p.pitch, p.plays])).toEqual([
      [36, 'kick (C2)'],
      [38, 'snare (D2)'],
      [42, 'closed hi-hat (F#2)'],
    ]);
    expect(opened.loop).toMatchObject({ length_beats: 8, length_seconds: 4 });
    expect(Date.parse(opened.expires_at) - Date.now()).toBeGreaterThan(
      RECORD_LIMITS.sessionMs - 60_000,
    );
    // While it waits, job.get says so.
    const waiting = await tool('job.get', { job_id: opened.job_id });
    expect(waiting).toMatchObject({ status: 'working', tool: 'score.record' });

    // The phone app: signed in with the account's key. Speed 1, then the slider at 0.5.
    const one = RecordSessionResult.parse(
      (await post('record.session', { job_id: opened.job_id })).body,
    );
    expect(one).toMatchObject({ speed: 1, input: 'pads', click: { on: true } });
    expect(one.loop).toMatchObject({ sample_rate: 48_000, frames: 192_000, seconds: 4 });
    expect(one.loop.beats).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(one.loop.bars).toEqual([0, 2]);
    expect(one.count_in).toEqual({ beats: 4, seconds: 2, times: [-2, -1.5, -1, -0.5] });
    expect(one.pads).toHaveLength(3);
    const wav = Buffer.from(await (await fetch(one.loop.url)).arrayBuffer());
    const loop = readMono(wav);
    expect([loop.rate, loop.channels, loop.bits, loop.data.length]).toEqual([
      48_000, 2, 16, 192_000,
    ]);
    // The loop has no click in it: the stand-in's own beats only (the click is a separate file).
    const click = readMono(Buffer.from(await (await fetch(one.click.url)).arrayBuffer()));
    expect(click.data.length).toBe(Math.round(0.04 * 48_000));
    const accent = Buffer.from(await (await fetch(one.click.accent_url)).arrayBuffer());
    expect(accent.length).toBeGreaterThan(44);
    const kick = readMono(
      Buffer.from(await (await fetch(one.pads[0]?.url as string)).arrayBuffer()),
    );
    expect(kick.rate).toBe(48_000);

    // The view: the session's own url is its credential, at another speed.
    const half = RecordSessionResult.parse(
      (await post('record.session', { job_id: opened.job_id, speed: 0.5 }, { link: opened.url }))
        .body,
    );
    expect(half.loop).toMatchObject({ frames: 384_000, seconds: 8 });
    expect(half.loop.beats.slice(0, 3)).toEqual([0, 1, 2]);
    expect(half.count_in.times).toEqual([-4, -3, -2, -1]);
    // The loop is the score at tempo × speed: a copy; the score's tempo is not changed.
    expect(renders.some((r) => r.tempo[0] === 60 && r.parts === undefined)).toBe(true);
    const stored = ScoreView.parse(await tool('score.get', { score_id, include: ['parts'] }));
    expect(stored.tempo[0]?.tempo).toBe(120);
    // Rendered once a speed: asked again, the same files.
    const before = renders.length;
    await post('record.session', { job_id: opened.job_id, speed: 0.5 });
    expect(renders.length).toBe(before);

    // A take at speed 0.5 (60 bpm): one tap on a count-in click, one in the loop, one on the
    // second pass with a measured velocity, one nanosecond into the loop.
    const take = {
      job_id: opened.job_id,
      speed: 0.5,
      taps: [
        { pitch: 38, at_seconds: -1, pass: 0 },
        { pitch: 36, at_seconds: 1.0137, pass: 0 },
        { pitch: 42, at_seconds: 2.5, pass: 1, velocity: 30 },
        { pitch: 36, at_seconds: 1e-9, pass: 0 },
      ],
      delay,
    };
    expect(await post('record.take', take, { link: opened.url })).toEqual({
      status: 200,
      body: { ok: true },
    });
    // The same body again, from the app this time and with its keys in another order: ok.
    const again = { delay, taps: take.taps, speed: 0.5, job_id: opened.job_id };
    expect(await post('record.take', again)).toEqual({ status: 200, body: { ok: true } });
    // Another body after a take is refused.
    const other = await post('record.take', { ...take, taps: take.taps.slice(1) });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('output_exists');
    // And the session gives no more loops.
    expect((await post('record.session', { job_id: opened.job_id })).status).toBe(409);

    const done = await waitJob(opened.job_id);
    expect(done.status).toBe('completed');
    const result = ScoreRecordTake.parse(done.result);
    expect(result).toMatchObject({
      parent: score_id,
      input: 'pads',
      part_id,
      speed: 0.5,
      delay,
      velocities: { measured: 1, given: 3 },
    });
    expect(result.region).toMatchObject({ at: { beats: 0 }, end: { beats: 8 }, length_beats: 8 });
    // 60 bpm in the rendition: a second is a beat. Pass 1 lands 8 beats on.
    expect(result.taps?.map((t) => t.at.beats)).toEqual([-1, 1.0137, 10.5, 1e-9]);
    expect(result.taps?.map((t) => t.sounds)).toEqual([false, true, false, true]);
    expect(result.taps?.map((t) => [t.velocity, t.velocity_measured])).toEqual([
      [100, false],
      [100, false],
      [30, true],
      [100, false],
    ]);
    expect(result.outside?.map((t) => [t.pass, t.at_seconds, t.at.beats])).toEqual([
      [0, -1, -1],
      [1, 2.5, 10.5],
    ]);
    expect(result.warnings.join(' ')).toContain('2 of 4 taps were played outside');
    // In the score: the notes at those beats exactly, the outside ones stored and silent.
    const view = ScoreView.parse(await tool('score.get', { score_id: result.score_id }));
    const region = view.parts
      ?.find((p) => p.part_id === part_id)
      ?.regions?.find((r) => r.region_id === result.region_id);
    expect(region?.type).toBe('notes');
    const notes = region?.type === 'notes' ? (region.notes ?? []) : [];
    expect(notes.map((n) => [n.note_id, n.at_beats, n.length_beats, n.sounds])).toEqual(
      result.note_ids?.map((id, i) => [
        id,
        [-1, 1.0137, 10.5, 1e-9][i],
        0.25,
        [false, true, false, true][i],
      ]),
    );
  }, 60_000);

  it('a microphone take: imported, placed at starts_at, and the loop found in it', async () => {
    if (!ffmpegFound) return;
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await tool('score.record', {
        score_id,
        part_id,
        input: 'microphone',
        from_beats: 0,
        until_beats: 8,
        count_in_beats: 2,
      }),
    );
    expect(opened.upload?.upload_id).toMatch(/^u_/);
    const session = RecordSessionResult.parse(
      (await post('record.session', { job_id: opened.job_id }, { link: opened.url })).body,
    );
    expect(session.pads).toEqual([]);
    // Over a speaker: the recording holds the loop, from 0.3 s into it, for 6 s (into pass 2).
    const loop = readMono(Buffer.from(await (await fetch(session.loop.url)).arrayBuffer()));
    const rate = 48_000;
    const take = new Float32Array(6 * rate);
    for (let i = 0; i < take.length; i++) {
      take[i] = 0.5 * (loop.data[(Math.round(0.3 * rate) + i) % loop.data.length] as number);
    }
    const bytes = stereoWav(take, rate, 1);
    const put = await fetch(opened.upload?.url as string, {
      method: 'PUT',
      headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    // The device says 0.31: 10 ms late. The take keeps the device's own placing.
    const sent = await post(
      'record.take',
      {
        job_id: opened.job_id,
        speed: 1,
        upload_id: opened.upload?.upload_id,
        starts_at_seconds: 0.31,
        passes: 2,
        delay: { ...delay, route: 'speaker', echo_cancelled: false },
      },
      { link: opened.url },
    );
    expect(sent).toEqual({ status: 200, body: { ok: true } });
    const done = await waitJob(opened.job_id);
    const result = ScoreRecordTake.parse(done.result);
    expect(result).toMatchObject({
      input: 'microphone',
      route: 'speaker',
      passes: 2,
      starts_at_seconds: 0.31,
    });
    expect(result.media_id).toMatch(/^m_/);
    expect(result.region.at.beats).toBeCloseTo(0.62, 9);
    expect(result.region.end.beats).toBeCloseTo(8, 9);
    expect(result.recording?.seconds).toBeCloseTo(6, 6);
    expect(result.recording?.outside_seconds.before).toBe(0);
    expect(result.recording?.outside_seconds.after).toBeCloseTo(6 - (4 - 0.31), 6);
    // The loop heard in the recording puts its first sample at 0.3 s, not the device's 0.31.
    expect(result.correlation?.starts_at_seconds).toBeCloseTo(0.3, 3);
    expect(result.correlation?.strength).toBeGreaterThan(0.9);
    expect(result.fit_beats).toBeUndefined();
  }, 120_000);

  it('refuses what it cannot take, with the reason and the limit', async () => {
    const { score_id, part_id, synth } = await drums();
    const refused = async (name: string, args: Rec, at?: string) => {
      const r = await post(name, args, at ? { at } : {});
      expect(r.status, `${name} ${JSON.stringify(args)}`).toBeGreaterThanOrEqual(400);
      return r.body as { code: string; message: string; hint?: string; detail?: Rec };
    };
    // Pads need the strength and the length of a tap: nothing is assumed.
    expect(
      (await refused('score.record', { score_id, part_id, input: 'pads', until_beats: 8 })).message,
    ).toMatch(/Pads need velocity and length_beats/);
    // Pad arguments on a microphone take.
    expect(
      (await refused('score.record', { score_id, part_id, input: 'microphone', velocity: 9 }))
        .message,
    ).toMatch(/velocity is for pads/);
    // The agent names the pads; a kit's own sounds are listed so it can.
    const { pads: _named, ...unnamed } = pads;
    const noPads = await refused('score.record', { score_id, part_id, ...unnamed });
    expect(noPads.message).toMatch(/pads is required/);
    expect(noPads.hint).toContain('C2 kick');
    expect(
      (await refused('score.record', { score_id, part_id: synth, ...unnamed })).message,
    ).toMatch(/pads is required/);
    const empty = (await tool('score.create', {
      tempo: 90,
      meter: { beats: 3, unit: 4 },
      sample_rate: 44_100,
    })) as { score_id: string };
    const lone = (await tool('score.add_part', { score_id: empty.score_id })) as Rec;
    expect(
      (
        await refused('score.record', {
          score_id: lone.score_id,
          part_id: lone.part_id,
          ...pads,
          pads: [60],
        })
      ).message,
    ).toMatch(/until_beats is required/);
    expect((await refused('score.record', { score_id, part_id: 'p99', ...pads })).code).toBe(
      'not_found',
    );
    // The pads limit, and the loop length at the score's tempo.
    expect(
      (
        await refused('score.record', {
          score_id,
          part_id,
          ...pads,
          pads: Array.from({ length: RECORD_LIMITS.pads + 1 }, (_, i) => i),
        })
      ).message,
    ).toMatch(/up to 64 pads/);
    const long = await refused('score.record', {
      score_id,
      part_id,
      ...pads,
      until_beats: 241 * 2,
    });
    expect(long).toMatchObject({
      code: 'limit_exceeded',
      detail: { limit: RECORD_LIMITS.loopSeconds },
    });

    const opened = ScoreRecordResult.parse(
      await tool('score.record', { score_id, part_id, ...pads, until_beats: 4, count_in_beats: 1 }),
    );
    const job_id = opened.job_id;
    // The speed range, and a speed that takes the tempo past what scores play.
    const fast = await post('record.session', { job_id, speed: 3 });
    expect(fast.status).toBe(422);
    expect(fast.body).toMatchObject({ code: 'limit_exceeded' });
    // A link is for its own session only; a forged one reaches nothing.
    const forged = opened.url.replace(/sig=[^&]+/, 'sig=AAAA');
    expect((await post('record.session', { job_id }, { link: forged })).status).toBe(403);
    const two = ScoreRecordResult.parse(
      await tool('score.record', { score_id, part_id, ...pads, until_beats: 4 }),
    );
    expect(
      (await post('record.session', { job_id: two.job_id }, { link: opened.url })).status,
    ).toBe(403);
    await cancel(two.job_id);
    // No sign-in at all.
    expect((await post('record.session', { job_id }, { key: null })).status).toBe(401);
    // Positions are in a loop that was rendered: a take before any session at that speed.
    const tap = (t: Rec) => ({ job_id, speed: 1, taps: [{ pitch: 36, pass: 0, ...t }], delay });
    expect((await post('record.take', tap({ at_seconds: 0.5 }))).body.message).toMatch(
      /No loop was rendered at speed 1/,
    );
    const ses = RecordSessionResult.parse((await post('record.session', { job_id })).body);
    expect(ses.loop.seconds).toBe(2);
    // A tap at the loop's end, before the count-in, a pad the session has not got, a pass past
    // the limit, a velocity off the scale, a microphone body on a pads session.
    expect((await post('record.take', tap({ at_seconds: 2 }))).body.message).toMatch(
      /outside the loop/,
    );
    expect((await post('record.take', tap({ at_seconds: -0.5000001 }))).body.message).toMatch(
      /-0.5 \(the count-in\)/,
    );
    expect((await post('record.take', tap({ at_seconds: -0.5, pass: 1 }))).status).toBe(400);
    expect((await post('record.take', tap({ at_seconds: 0, pitch: 60 }))).body.message).toMatch(
      /pitch 60 has no pad/,
    );
    const far = await post('record.take', tap({ at_seconds: 0, pass: RECORD_LIMITS.passes }));
    expect(far).toMatchObject({ status: 422, body: { code: 'limit_exceeded' } });
    expect((await post('record.take', tap({ at_seconds: 0, velocity: 0 }))).status).toBe(400);
    expect(
      (
        await post('record.take', {
          job_id,
          speed: 1,
          upload_id: 'u_x',
          starts_at_seconds: 0,
          passes: 1,
          delay,
        })
      ).body.message,
    ).toMatch(/This session takes taps/);
    // Too many taps in one take.
    const many = await post('record.take', {
      job_id,
      speed: 1,
      taps: Array.from({ length: RECORD_LIMITS.taps + 1 }, () => ({
        pitch: 36,
        at_seconds: 0,
        pass: 0,
      })),
      delay,
    });
    expect(many.body.message).toMatch(/up to 2,000 taps/);
    // A delay the contract does not know.
    expect(
      (
        await post('record.take', {
          ...tap({ at_seconds: 0 }),
          delay: { ...delay, route: 'radio' },
        })
      ).status,
    ).toBe(400);
    // Cancelled by the agent: the session takes nothing more.
    await cancel(job_id);
    expect((await post('record.take', tap({ at_seconds: 0 }))).body.code).toBe('cancelled');
  }, 60_000);

  it('a microphone take longer than the limit is refused before anything is placed', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await tool('score.record', { score_id, part_id, input: 'microphone', until_beats: 4 }),
    );
    await post('record.session', { job_id: opened.job_id });
    const rate = 8000;
    const bytes = stereoWav(
      new Float32Array((RECORD_LIMITS.microphoneSeconds + 1) * rate),
      rate,
      1,
    );
    await fetch(opened.upload?.url as string, {
      method: 'PUT',
      headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
      body: new Uint8Array(bytes),
    });
    const body = {
      job_id: opened.job_id,
      speed: 1,
      upload_id: opened.upload?.upload_id,
      starts_at_seconds: 0,
      passes: 1,
      delay,
    };
    const r = await post('record.take', body);
    expect(r).toMatchObject({ status: 422, body: { code: 'limit_exceeded' } });
    // Not a WAV at all: refused with what is needed.
    const job2 = ScoreRecordResult.parse(
      await tool('score.record', { score_id, part_id, input: 'microphone', until_beats: 4 }),
    );
    await post('record.session', { job_id: job2.job_id });
    const aac = Buffer.from('not a wav, an encoder made this');
    await fetch(job2.upload?.url as string, {
      method: 'PUT',
      headers: { 'content-range': `bytes 0-${aac.length - 1}/${aac.length}` },
      body: new Uint8Array(aac),
    });
    const refused = await post('record.take', {
      ...body,
      job_id: job2.job_id,
      upload_id: job2.upload?.upload_id,
    });
    expect(refused.body.message).toMatch(/not a PCM WAV/);
    await cancel(opened.job_id);
    await cancel(job2.job_id);
  }, 60_000);

  it('holds the sessions an account has open at once to the limit', async () => {
    const { score_id, part_id } = await drums();
    const open: string[] = [];
    for (let i = 0; i < RECORD_LIMITS.sessionsOpen; i++) {
      open.push(
        ScoreRecordResult.parse(
          await tool('score.record', { score_id, part_id, ...pads, until_beats: 4 }),
        ).job_id,
      );
    }
    const over = await post('score.record', { score_id, part_id, ...pads, until_beats: 4 });
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({
      code: 'limit_exceeded',
      detail: { limit: RECORD_LIMITS.sessionsOpen },
    });
    for (const id of open) await cancel(id);
    expect(
      (await post('score.record', { score_id, part_id, ...pads, until_beats: 4 })).status,
    ).toBe(200);
  }, 60_000);

  it('describes the two calls in the OpenAPI document, and serves the page behind the url', async () => {
    const spec = (await (await fetch(`${base}/openapi.json`)).json()) as {
      paths: Record<string, { post: { operationId: string; tags: string[] } }>;
    };
    expect(spec.paths['/v1/record.session']?.post).toMatchObject({
      operationId: 'record_session',
      tags: ['record'],
    });
    expect(spec.paths['/v1/record.take']?.post.operationId).toBe('record_take');
    expect(spec.paths['/v1/score.record']?.post.operationId).toBe('score_record');
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await tool('score.record', { score_id, part_id, ...pads, until_beats: 4 }),
    );
    const page = await fetch(opened.url, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('permissions-policy')).toBe('microphone=(self)');
    const html = await page.text();
    expect(html).toContain(`"job_id":"${opened.job_id}"`);
    const bad = await fetch(opened.url.replace(/sig=[^&]+/, 'sig=AAAA'));
    expect(bad.status).toBe(403);
    await cancel(opened.job_id);
  }, 60_000);
  it.skipIf(!engineFound)(
    'with the score engine: the loop is the score, each pad its own sound, and a take lands',
    async () => {
      const { score_id, part_id } = await drums();
      const opened = ScoreRecordResult.parse(
        await tool('score.record', { score_id, part_id, ...pads, until_beats: 8 }),
      );
      const at = { at: engineBase };
      const got = await post('record.session', { job_id: opened.job_id }, at);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      const session = RecordSessionResult.parse(got.body);
      expect(session.loop).toMatchObject({ sample_rate: 48_000, frames: 192_000, seconds: 4 });
      const sound = async (url: string) =>
        readMono(Buffer.from(await (await fetch(url)).arrayBuffer()));
      const peak = (data: Float32Array | number[], from = 0, to = data.length) => {
        let max = 0;
        for (let i = from; i < to; i++) max = Math.max(max, Math.abs(data[i] as number));
        return max;
      };
      // The score has one kick, on beat 0: the loop is loud there and quiet a second later.
      const loop = await sound(session.loop.url);
      expect(loop.data.length).toBe(192_000);
      expect(peak(loop.data, 0, 4_800)).toBeGreaterThan(0.05);
      expect(peak(loop.data, 96_000, 144_000)).toBeLessThan(peak(loop.data, 0, 4_800) / 10);
      // Each pad plays its own sound, and they are not the same sound.
      const pad = await Promise.all((session.pads ?? []).map((p) => sound(p.url)));
      expect(pad).toHaveLength(3);
      for (const p of pad) expect(peak(p.data)).toBeGreaterThan(0.01);
      expect(pad[0]?.data.length).not.toBe(pad[2]?.data.length);
      // A take against the engine's loop lands as notes on the part.
      const take = {
        job_id: opened.job_id,
        speed: 1,
        taps: [
          { pitch: 38, at_seconds: 0.5, pass: 0 },
          { pitch: 42, at_seconds: 1.25, pass: 0 },
        ],
        delay,
      };
      expect((await post('record.take', take, at)).status).toBe(200);
      const done = await waitJob(opened.job_id);
      expect(done.status).toBe('completed');
      const result = ScoreRecordTake.parse(done.result);
      expect(result.parent).toBe(score_id);
      expect(result.note_ids).toHaveLength(2);
    },
    120_000,
  );
});
