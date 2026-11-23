import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createPlainServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { INDEX_VERSION, type MediaRecord, type Probe, SEARCH_MODEL } from '@cuttingfloor/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MeterEntry } from '../src/index.ts';
import { call, connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

// media.search against a stand-in for api.typesafe.ai, with no engines: media and their picture
// indexes are written as an import and the indexer would leave them. The stand-in says yes to a
// picture whose bytes spell what a criterion names, and to a passage that holds the word.
// Indexing real media (FFmpeg and the SigLIP2 model) is checked in apps/hosted/test/e2e.test.ts.

const KEY = 'ts-search-secret-key';
let env: TestEnv;
let jev: Server;
const seen: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  jev = createPlainServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      state: Record<string, string>;
      assets?: Record<string, { data_base64: string }>;
      questions: Record<string, { instructions: string }>;
    };
    seen.push(body);
    const picture = Object.values(body.assets ?? {})
      .map((a) => Buffer.from(a.data_base64, 'base64').toString())
      .join(' ');
    const passage = body.state.passage ?? '';
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const word = /(dog|cat|pricing|weather)/.exec(q.instructions)?.[1] ?? '';
      const yes = word && (picture.includes(word.toUpperCase()) || passage.includes(word));
      answers[id] = { type: 'noul', noul: yes ? 0.9 : 0.1 };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'jev-1.14.0', answers }));
  });
  await new Promise<void>((r) => jev.listen(0, '127.0.0.1', r));
  env = await testRuntime({
    typesafeUrl: `http://127.0.0.1:${(jev.address() as AddressInfo).port}`,
  });
});
afterAll(() => jev?.close());
beforeEach(() => {
  seen.length = 0;
});

const keyed = (owner: string) => connect(env.runtime, owner, { TYPESAFE_API_KEY: KEY });

const probe = (kind: Probe['kind'], duration: number | null): Probe => ({
  format: kind,
  kind,
  duration,
  video:
    kind === 'video' || kind === 'image'
      ? {
          codec: 'h264',
          width: 1280,
          height: 720,
          fps: { num: 25, den: 1 },
          vfr: false,
          rotation: 0,
          transfer: null,
          primaries: null,
          pix_fmt: 'yuv420p',
          frames: null,
        }
      : null,
  audio:
    kind === 'video' || kind === 'audio' ? { codec: 'aac', sample_rate: 48000, channels: 2 } : null,
});

/** A ready media; with `pictures`, a picture index whose keyframes start at `seconds`. */
async function seed(
  owner: string,
  name: string,
  kind: Probe['kind'],
  duration: number | null,
  pictures?: { seconds: number[]; text: string[] },
): Promise<MediaRecord> {
  const media = env.runtime.media;
  const record = await media.create(owner, { path: join(env.mediaDir, name) }, name);
  record.status = 'ready';
  record.probe = probe(kind, duration);
  await media.save(owner, record);
  if (pictures) {
    const dir = media.searchDir(owner, record.media_id);
    await mkdir(dir, { recursive: true });
    const jpegs = pictures.text.map((t) => Buffer.from(t));
    let offset = 0;
    const keyframes = pictures.seconds.map((s, i) => {
      const k = {
        seconds: s,
        end: pictures.seconds[i + 1] ?? duration ?? s,
        offset,
        bytes: (jpegs[i] as Buffer).length,
      };
      offset += k.bytes;
      return k;
    });
    const dims = 4;
    await writeFile(join(dir, 'frames.jpg'), Buffer.concat(jpegs));
    await writeFile(
      join(dir, 'vectors.f32'),
      Buffer.from(new Float32Array(keyframes.length * dims).fill(0.5).buffer),
    );
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({ version: INDEX_VERSION, model: SEARCH_MODEL, dims, keyframes }),
    );
  }
  return record;
}

async function transcript(owner: string, id: string, lines: Array<[number, string]>) {
  const words = lines.flatMap(([start, line]) =>
    line
      .split(' ')
      .map((text, i) => ({ text, start: start + i, end: start + i + 0.5, confidence: 0.9 })),
  );
  await env.runtime.media.saveAnalysis(owner, id, 'transcript', {
    model: 'tiny',
    language: 'en',
    text: words.map((w) => w.text).join(' '),
    words,
  });
}

type Found = {
  searched: boolean;
  estimate: { media: number; judgments: number; credits: number; by_kind: Record<string, unknown> };
  warning?: string;
  matches: Record<
    string,
    Array<{
      media_id: string;
      start: number;
      end: number;
      peak_probability: number;
      uri?: string;
      text?: string;
    }>
  >;
  judged: string[];
  skipped: Array<{ media_id: string; route: string; reason: string }>;
};

/** Runs a search to its end and returns its result. */
async function search(c: Awaited<ReturnType<typeof keyed>>, args: Record<string, unknown>) {
  const started = await ok<{ job_id: string; status: string; result?: Found }>(
    c,
    'media.search',
    args,
  );
  if (started.result) return started.result;
  const done = await settled<{ result: Found }>(c, started.job_id);
  return done.result;
}

describe('media.search', () => {
  it('finds moments across videos, images and transcripts, and says what it did not judge', async () => {
    const owner = 'finder';
    const c = await keyed(owner);
    const walk = await seed(owner, 'walk.mp4', 'video', 60, {
      seconds: [0, 10, 20, 30, 40, 50],
      text: ['CAT', 'CAT', 'DOG', 'DOG', 'CAT', 'CAT'],
    });
    await transcript(owner, walk.media_id, [
      [0, 'welcome to the walk today.'],
      [35, 'now about pricing for the plan.'],
    ]);
    const photo = await seed(owner, 'photo.png', 'image', null, { seconds: [0], text: ['DOG'] });
    const song = await seed(owner, 'song.mp3', 'audio', 30);
    const fresh = await seed(owner, 'fresh.mp4', 'video', 20);
    const metered: MeterEntry[] = [];
    const off = env.runtime.onMetered((o, entry) => {
      if (o === owner) metered.push(entry);
    });

    const got = await search(c, {
      looks: { dog: 'a dog' },
      says: { pricing: 'the speaker talks about pricing' },
    });
    off();
    expect(got.searched).toBe(true);
    // Six keyframes of walk.mp4, the photo, and walk.mp4's two passages.
    expect(got.estimate).toMatchObject({ media: 2, judgments: 9 });
    // Most probable first; equal ones by name.
    expect(got.matches.dog).toEqual([
      expect.objectContaining({ media_id: photo.media_id, start: 0, peak_probability: 0.9 }),
      expect.objectContaining({
        media_id: walk.media_id,
        start: 20,
        end: 40,
        peak_probability: 0.9,
      }),
    ]);
    expect(got.matches.dog?.[1]?.uri).toMatch(/^video:\/\/media\/m_\w+\/frames\/500\.webp$/);
    expect(got.matches.pricing).toEqual([
      expect.objectContaining({
        media_id: walk.media_id,
        start: 35,
        text: 'now about pricing for the plan.',
      }),
    ]);
    expect(got.judged.sort()).toEqual([walk.media_id, photo.media_id].sort());
    expect(got.skipped).toEqual(
      expect.arrayContaining([
        { media_id: song.media_id, name: 'song.mp3', route: 'looks', reason: 'no_picture' },
        { media_id: song.media_id, name: 'song.mp3', route: 'says', reason: 'no_transcript' },
        { media_id: fresh.media_id, name: 'fresh.mp4', route: 'looks', reason: 'indexing' },
        { media_id: fresh.media_id, name: 'fresh.mp4', route: 'says', reason: 'no_transcript' },
      ]),
    );
    // One call per keyframe and per passage; each carries only its own route's criteria.
    expect(seen).toHaveLength(9);
    const pictureCall = seen.find((b) => b.assets) as { questions: Record<string, unknown> };
    expect(Object.keys(pictureCall.questions)).toEqual(['dog']);
    // Billed by judgment.
    expect(metered.find((e) => e.tool === 'media.search')?.judgments).toBe(9);
  });

  it('filters for free before anything is judged', async () => {
    const owner = 'filterer';
    const c = await keyed(owner);
    await seed(owner, 'long.mp4', 'video', 60, {
      seconds: [0, 10, 20, 30, 40, 50],
      text: ['CAT', 'CAT', 'DOG', 'DOG', 'CAT', 'CAT'],
    });
    const photo = await seed(owner, 'dog.png', 'image', null, { seconds: [0], text: ['DOG'] });

    const images = await search(c, { looks: { dog: 'a dog' }, kind: ['image'] });
    expect(images.estimate.judgments).toBe(1);
    expect(images.judged).toEqual([photo.media_id]);

    const named = await search(c, { looks: { dog: 'a dog' }, name_contains: 'LONG' });
    expect(named.estimate.judgments).toBe(6);

    // Keyframes whose view overlaps 15 to 35 s: those at 10, 20 and 30.
    const stretch = await search(c, {
      looks: { dog: 'a dog' },
      media_ids: [named.judged[0]],
      from_seconds: 15,
      until_seconds: 35,
    });
    expect(stretch.estimate.judgments).toBe(3);
    expect(stretch.matches.dog).toEqual([expect.objectContaining({ start: 20, end: 40 })]);
  });

  it('runs nothing over 200 judgments until the user agrees, and says what would cut it', async () => {
    const owner = 'spender';
    const c = await keyed(owner);
    const seconds = Array.from({ length: 300 }, (_, i) => i * 2);
    const big = await seed(owner, 'big.mp4', 'video', 600, {
      seconds,
      text: seconds.map((s) => (s === 100 ? 'DOG' : 'CAT')),
    });
    await seed(owner, 'small.png', 'image', null, { seconds: [0], text: ['CAT'] });
    const metered: MeterEntry[] = [];
    const off = env.runtime.onMetered((o, entry) => {
      if (o === owner) metered.push(entry);
    });

    const held = await search(c, { looks: { dog: 'a dog' } });
    expect(held.searched).toBe(false);
    expect(held.estimate).toMatchObject({ media: 2, judgments: 301, credits: 0 });
    expect(held.estimate.by_kind).toEqual({
      video: { media: 1, judgments: 300 },
      image: { media: 1, judgments: 1 },
    });
    expect(held.warning).toMatch(/301 keyframes and passages across 2 media, over the 200/);
    expect(held.warning).toMatch(/Free filters not used yet: kind, media_ids/);
    expect(seen).toHaveLength(0);

    const agreed = await search(c, { looks: { dog: 'a dog' }, cost_override: 'user_confirmed' });
    off();
    expect(agreed.searched).toBe(true);
    expect(agreed.matches.dog).toEqual([
      expect.objectContaining({ media_id: big.media_id, start: 100, end: 102 }),
    ]);
    expect(seen).toHaveLength(301);
    // Judgments are their own entry, beside the job's few seconds of running time.
    expect(metered.filter((e) => e.judgments).map((e) => e.judgments)).toEqual([301]);
  });

  it('needs a Jev key and at most 32 criteria', async () => {
    const bare = await connect(env.runtime, 'nokey');
    const res = await call(bare, 'media.search', { looks: { dog: 'a dog' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structured)).toMatch(/TYPESAFE|TypeSafe/);

    const c = await keyed('limits');
    const none = await call(c, 'media.search', {});
    expect(none.isError).toBe(true);
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, 'a dog']));
    const tooMany = await call(c, 'media.search', { looks: many });
    expect(tooMany.isError).toBe(true);
    expect(JSON.stringify(tooMany.structured)).toMatch(/up to 32 criteria/);

    const empty = await search(c, { looks: { dog: 'a dog' } });
    expect(empty).toMatchObject({
      searched: true,
      estimate: { media: 0, judgments: 0 },
      matches: { dog: [] },
    });
  });
});
