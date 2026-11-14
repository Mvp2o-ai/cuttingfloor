import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JUDGMENTS_PER_CREDIT } from '@cuttingfloor/plans';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billedSeconds, type MeterEntry, meteredSeconds } from '../src/index.ts';
import { call, connect, ok, type TestEnv, testRuntime } from './helpers.ts';

// judge.ask against a stand-in for api.typesafe.ai, with no engines: text state, limits,
// credentials, Jev's refusals, metering and cancellation. Pictures (image media and video
// frames) are checked in apps/hosted/test/e2e.test.ts, where FFmpeg is.

const KEY = 'ts-judge-secret-key';
let env: TestEnv;
let jev: Server;
const seen: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
/** What the stand-in answers next: answers, a refusal, or nothing at all (to cancel). */
let mode: 'answer' | 'too_long' | 'too_big' | 'invalid' | 'hang' = 'answer';
let closed: () => void = () => undefined;

const keyed = () => connect(env.runtime, 'judge', { TYPESAFE_API_KEY: KEY });
const filler = {
  type: 'noul',
  instructions: 'Is the word marked [[like this]] in `passage` a filler word?',
};

beforeAll(async () => {
  jev = createPlainServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    seen.push({ headers: req.headers, body });
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end('{}');
    if (mode === 'hang') {
      res.on('close', () => closed());
      return;
    }
    if (mode === 'too_long') {
      return res
        .writeHead(400, { 'content-type': 'application/json' })
        .end('{"error":{"code":"max_tokens_exceeded","message":"request is 70000 tokens"}}');
    }
    if (mode === 'too_big') return res.writeHead(413).end('{"error":"body too large"}');
    if (mode === 'invalid') return res.writeHead(422).end('{"error":"criteria: required"}');
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions as Record<string, { type: string }>)) {
      answers[id] =
        q.type === 'noul'
          ? { type: 'noul', noul: 0.912345 }
          : {
              type: 'choice',
              choice: 'filler',
              probabilities: { filler: 0.7, meaning: 0.3 },
              confidence: 0.55,
            };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 1 } }));
  });
  await new Promise<void>((r) => jev.listen(0, '127.0.0.1', r));
  env = await testRuntime({
    typesafeUrl: `http://127.0.0.1:${(jev.address() as AddressInfo).port}`,
  });
});
afterAll(() => jev?.close());
beforeEach(() => {
  mode = 'answer';
  seen.length = 0;
});

describe('judge.ask', () => {
  it('asks every question about a text state in one call and maps the answers', async () => {
    const c = await keyed();
    const got = await ok<{ model: string; answers: Record<string, unknown> }>(c, 'judge.ask', {
      state: {
        passage: 'So [[basically]] the way this works is',
        speaker: { name: 'Donna', style: 'casual' },
        before: ['Hi everyone.', 'Welcome back.'],
        seconds: 12.5,
      },
      questions: {
        is_filler: filler,
        kind: {
          type: 'choice',
          instructions: 'What does the word marked [[like this]] in `passage` do?',
          criteria: { filler: 'Adds nothing', meaning: 'Carries meaning' },
        },
      },
    });
    expect(got).toEqual({
      model: 'jev-1.14.0',
      answers: {
        is_filler: { noul: 0.9123 },
        kind: { choice: 'filler', probabilities: { filler: 0.7, meaning: 0.3 }, confidence: 0.55 },
      },
    });
    // One request: the state as given, no assets, the pinned model, the key only in its header.
    expect(seen).toHaveLength(1);
    const r = seen[0] as (typeof seen)[number];
    expect(r.body).toMatchObject({
      model: 'jev-1.14.0',
      state: {
        passage: 'So [[basically]] the way this works is',
        speaker: { name: 'Donna', style: 'casual' },
        before: ['Hi everyone.', 'Welcome back.'],
        seconds: 12.5,
      },
    });
    expect(r.body).not.toHaveProperty('assets');
    expect(r.headers['typesafe-danger-zone-images']).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(KEY);
    expect(JSON.stringify(got)).not.toContain(KEY);
  });

  it('needs a TypeSafe key, and never shows it', async () => {
    const bare = await connect(env.runtime, 'judge');
    const res = await call(bare, 'judge.ask', {
      state: { passage: 'So basically' },
      questions: { is_filler: filler },
    });
    expect(res.structured).toMatchObject({
      code: 'credential_required',
      detail: { provider: 'typesafe', env: 'TYPESAFE_API_KEY' },
    });
    const wrong = await connect(env.runtime, 'judge', { TYPESAFE_API_KEY: 'ts-wrong-key' });
    const refused = await call(wrong, 'judge.ask', {
      state: { passage: 'So basically' },
      questions: { is_filler: filler },
    });
    expect(refused.structured).toMatchObject({ code: 'credential_invalid' });
    expect(JSON.stringify(refused)).not.toContain('ts-wrong-key');
  });

  it('refuses calls past the limits before asking Jev', async () => {
    const c = await keyed();
    const many = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`q${i}`, filler]));
    const tooMany = await call(c, 'judge.ask', { state: { passage: 'x' }, questions: many });
    expect(tooMany.structured).toMatchObject({ code: 'bad_request' });
    expect(String(tooMany.structured.hint)).toMatch(/Split the questions/);
    const none = await call(c, 'judge.ask', { state: { passage: 'x' }, questions: {} });
    expect(none.structured).toMatchObject({ code: 'bad_request' });

    const pictures = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `shot${i}`,
        { media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
      ]),
    );
    const tooManyPictures = await call(c, 'judge.ask', {
      state: pictures,
      questions: { is_filler: filler },
    });
    expect(tooManyPictures.structured).toMatchObject({ code: 'limit_exceeded' });

    const long = await call(c, 'judge.ask', {
      state: { passage: 'um '.repeat(70_000) },
      questions: { is_filler: filler },
    });
    expect(long.structured).toMatchObject({ code: 'limit_exceeded' });
    expect(String(long.structured.hint)).toMatch(/Split the state/);

    const missing = await call(c, 'judge.ask', {
      state: { shot: { media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa', at_seconds: 1 } },
      questions: { is_filler: filler },
    });
    expect(missing.structured).toMatchObject({ code: 'not_found' });
    expect(seen).toHaveLength(0);
  });

  it("turns Jev's refusals into errors that say what to do", async () => {
    const c = await keyed();
    const ask = { state: { passage: 'So basically' }, questions: { is_filler: filler } };
    for (const m of ['too_long', 'too_big'] as const) {
      mode = m;
      const res = await call(c, 'judge.ask', ask);
      expect(res.structured, m).toMatchObject({ code: 'limit_exceeded' });
      expect(String(res.structured.hint), m).toMatch(/Split the questions or the state/);
    }
    mode = 'invalid';
    const invalid = await call(c, 'judge.ask', ask);
    expect(invalid.structured).toMatchObject({ code: 'bad_request' });
    expect(String(invalid.structured.message)).toContain('criteria: required');
  });

  it('meters each call, a judgment at 1/200 of a credit, with the owner’s jobs', async () => {
    const owner = 'judge-meter';
    const c = await connect(env.runtime, owner, { TYPESAFE_API_KEY: KEY });
    const since = new Date();
    const told: MeterEntry[] = [];
    const off = env.runtime.onMetered((o, entry) => {
      if (o === owner) told.push(entry);
    });
    const ask = { state: { passage: 'So basically' }, questions: { is_filler: filler } };
    await ok(c, 'judge.ask', ask);
    // One per 32 questions: 65 questions are 3 judgments.
    const questions = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`w${i}`, filler]));
    await ok(c, 'judge.ask', { state: { passage: 'So basically' }, questions });
    off();
    expect(told.map((e) => [e.tool, e.seconds, e.judgments]).sort()).toEqual([
      ['judge.ask', 0, 1],
      ['judge.ask', 0, 3],
    ]);
    expect(told.map(billedSeconds).sort()).toEqual([
      60 / JUDGMENTS_PER_CREDIT,
      180 / JUDGMENTS_PER_CREDIT,
    ]);
    expect(await meteredSeconds(env.runtime.ws, owner, since)).toBeCloseTo(
      240 / JUDGMENTS_PER_CREDIT,
      3,
    );
  });

  it('stops asking when the call is cancelled', async () => {
    mode = 'hang';
    const c = await keyed();
    const gone = new Promise<void>((r) => {
      closed = r;
    });
    const abort = new AbortController();
    const pending = c.callTool(
      {
        name: 'judge.ask',
        arguments: { state: { passage: 'So basically' }, questions: { is_filler: filler } },
      },
      { signal: abort.signal },
    );
    while (!seen.length) await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await gone; // The request to Jev was dropped, not left running.
  });
});

// media.seek's checks before any job: frames and Jev's answers on them are checked in
// apps/hosted/test/e2e.test.ts, where FFmpeg and melt are.
describe('media.seek', () => {
  const media = { media_id: 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const dark = { too_dark: 'the faces are too dark to make out their eyes' };

  it('needs a TypeSafe key', async () => {
    const bare = await connect(env.runtime, 'seek');
    const res = await call(bare, 'media.seek', { ...media, criteria: dark });
    expect(res.structured).toMatchObject({
      code: 'credential_required',
      detail: { provider: 'typesafe', env: 'TYPESAFE_API_KEY' },
    });
  });

  it('refuses what it cannot judge before asking Jev', async () => {
    const c = await keyed();
    const none = await call(c, 'media.seek', { ...media, criteria: {} });
    expect(none.structured).toMatchObject({ code: 'bad_request' });
    expect(String(none.structured.hint)).toMatch(/criteria: \{too_dark/);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, 'black']));
    const tooMany = await call(c, 'media.seek', { ...media, criteria: many });
    expect(tooMany.structured).toMatchObject({ code: 'bad_request' });
    expect(String(tooMany.structured.hint)).toMatch(/Split the criteria/);
    const both = await call(c, 'media.seek', {
      ...media,
      timeline_id: 'tl_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      criteria: dark,
    });
    expect(both.isError).toBe(true);
    const reserved = await call(c, 'media.seek', {
      ...media,
      criteria: dark,
      state: { previous: 'mine' },
    });
    expect(reserved.structured).toMatchObject({ code: 'bad_request' });
    const missing = await call(c, 'media.seek', { ...media, criteria: dark });
    expect(missing.structured).toMatchObject({ code: 'not_found' });
    const { timeline_id } = await ok<{ timeline_id: string }>(c, 'timeline.create', {
      name: 'empty',
      sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
    });
    const empty = await call(c, 'media.seek', { timeline_id, criteria: dark });
    expect(empty.structured).toMatchObject({ code: 'bad_request' });
    expect(String(empty.structured.message)).toMatch(/empty/);
    expect(seen).toHaveLength(0);
  });
});
