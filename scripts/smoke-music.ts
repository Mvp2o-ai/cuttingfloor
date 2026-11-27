// Smoke test for music on a live server, as a client and the phone app reach it.
//
//   node scripts/smoke-music.ts https://api.cuttingfloor.ai
//   node scripts/smoke-music.ts http://127.0.0.1:8787        (local mode: no key)
//
// The maintenance key comes from CF_KEY, else the first key in deploy/hetzner/cuttingfloor.env
// (see smoke-hosted.ts). It builds a two-bar score, renders it with the engine, looks at it,
// then plays a take into it over the two REST calls the phone app uses (record.session and
// record.take). Everything it makes is deleted at the end.
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.argv[2] ?? 'https://api.cuttingfloor.ai').replace(/\/$/, '');
const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(base);
const key =
  process.env.CF_KEY ??
  (await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8').then(
    (env) => /^CUTTINGFLOOR_API_KEYS=[^:,\s]+:([^,\s]+)/m.exec(env)?.[1],
    () => undefined,
  ));
if (!key && !local)
  throw new Error('Set CF_KEY, or CUTTINGFLOOR_API_KEYS in deploy/hetzner/cuttingfloor.env');
const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};

const step = (label: string) => process.stdout.write(`• ${label}\n`);
const failures: string[] = [];
function expect(ok: boolean, label: string) {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures.push(label);
}
type Rec = Record<string, unknown>;

const client = new Client({ name: 'smoke-music', version: '0' });
async function raw(tool: string, args: Rec) {
  return (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Rec;
    content?: Array<{ type: string }>;
  };
}
async function call(tool: string, args: Rec): Promise<Rec> {
  const res = await raw(tool, args);
  if (res.isError) throw new Error(`${tool}: ${JSON.stringify(res.structuredContent)}`);
  return res.structuredContent ?? {};
}
async function job(jobId: string): Promise<Rec> {
  for (let i = 0; i < 300; i++) {
    const j = await call('job.get', { job_id: jobId });
    if (j.status !== 'working') return j;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`job ${jobId} never finished`);
}
async function rest(op: string, body: Rec): Promise<{ status: number; body: Rec }> {
  const r = await fetch(`${base}/v1/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Rec };
}

await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }),
);
const made: string[] = [];
try {
  step('the music tools are listed');
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const score = [...names].filter((n) => n.startsWith('score.'));
  expect(score.length === 31, `31 score tools (got ${score.length})`);
  for (const n of ['render.spectrogram', 'render.notes', 'score.render', 'score.record'])
    expect(names.has(n), n);

  step('a score is built in one batch, with ops referred to by name');
  const created = await call('score.create', {
    tempo: 120,
    meter: { beats: 4, unit: 4 },
    sample_rate: 48_000,
    fps: { num: 30, den: 1 },
    name: 'smoke music',
  });
  const built = await call('score.batch', {
    score_id: created.score_id,
    ops: [
      { tool: 'score.add_part', as: 'drums', args: { name: 'Drums' } },
      { tool: 'score.add_part', as: 'bass', args: { name: 'Bass', gain_db: -6 } },
      { tool: 'score.add_device', args: { part_id: { $ref: 'drums.part_id' }, name: 'kit_808' } },
      { tool: 'score.add_device', args: { part_id: { $ref: 'bass.part_id' }, name: 'sub_bass' } },
      {
        tool: 'score.add_region',
        args: {
          part_id: { $ref: 'drums.part_id' },
          at_beats: 0,
          length_beats: 8,
          notes: [0, 2, 4, 6].flatMap((b) => [
            { pitch: 'C2', at_beats: b, length_beats: 0.5, velocity: 110 },
            { pitch: 'D2', at_beats: b + 1, length_beats: 0.5, velocity: 100 },
          ]),
        },
      },
      {
        tool: 'score.add_region',
        args: {
          part_id: { $ref: 'bass.part_id' },
          at_beats: 0,
          length_beats: 8,
          notes: [
            { pitch: 'C2', at_beats: 0, length_beats: 3, velocity: 100 },
            { pitch: 'G1', at_beats: 4, length_beats: 3, velocity: 100 },
          ],
        },
      },
    ],
  });
  const scoreId = built.score_id as string;
  const results = built.results as Rec[];
  const drums = results[0]?.part_id as string;
  expect(Boolean(scoreId) && Boolean(drums), 'the batch made a score and its parts');

  step('the engine renders it');
  const started = await call('score.render', { score_id: scoreId });
  const rendered = await job(started.job_id as string);
  const render = (rendered.result as Rec | undefined)?.render as Rec | undefined;
  const mediaId = (rendered.result as Rec | undefined)?.media_id as string | undefined;
  if (mediaId) made.push(mediaId);
  expect(rendered.status === 'completed', `score.render completed (${rendered.status})`);
  expect(Math.abs((render?.length_seconds as number) - 4) < 0.01, 'two bars at 120 are 4 s');
  const lufs = (render?.loudness as Rec | undefined)?.integrated_lufs as number | null;
  expect(typeof lufs === 'number' && lufs > -40, `it is not silent (${lufs} LUFS)`);
  expect(render?.clipped_samples === 0, `nothing clipped (${render?.clipped_samples})`);
  expect((render?.parts_sounded as string[])?.length === 2, 'both parts sounded');
  expect((render?.bars as unknown[])?.length === 2, 'two bars listed');

  step('the same render is the same media');
  const again = await call('score.render', { score_id: scoreId });
  expect(again.media_id === mediaId, 'the recipe cache answered');

  step('the score can be looked at');
  const roll = await raw('render.notes', { score_id: scoreId });
  expect(!roll.isError && Boolean(roll.content?.some((c) => c.type === 'image')), 'render.notes');
  const picture = await raw('render.spectrogram', { score_id: scoreId });
  expect(
    !picture.isError && Boolean(picture.content?.some((c) => c.type === 'image')),
    'render.spectrogram of a score',
  );

  step('a take is played into it over the phone app’s two calls');
  const opened = await call('score.record', {
    score_id: scoreId,
    part_id: drums,
    input: 'pads',
    pads: ['C2', 'D2', 'F#2'],
    velocity: 100,
    length_beats: 0.25,
  });
  const jobId = opened.job_id as string;
  expect(
    (opened.native_view as Rec | undefined)?.component === 'record' &&
      (opened.native_view as Rec | undefined)?.version === 1,
    'native_view {component: record, version: 1}',
  );
  const session = await rest('record.session', { job_id: jobId });
  expect(session.status === 200, `record.session 200 (got ${session.status})`);
  const loop = session.body.loop as Rec | undefined;
  expect(loop?.frames === 192_000 && loop?.sample_rate === 48_000, 'the loop is 4 s at 48 kHz');
  expect((session.body.pads as unknown[])?.length === 3, 'three pads');
  const wav = loop?.url ? await fetch(loop.url as string) : undefined;
  expect(wav?.status === 200, 'the loop downloads from its signed url');
  const take = {
    job_id: jobId,
    speed: 1,
    taps: [
      { pitch: 42, at_seconds: 0.25, pass: 0 },
      { pitch: 42, at_seconds: 0.75, pass: 0 },
    ],
    delay: { output_ms: 20, input_ms: 0, source: 'reported', route: 'wired' },
  };
  const sent = await rest('record.take', take);
  expect(sent.status === 200 && sent.body.ok === true, `record.take ok (got ${sent.status})`);
  const repeat = await rest('record.take', take);
  expect(repeat.status === 200, 'the same take again is ok');
  const other = await rest('record.take', { ...take, taps: take.taps.slice(1) });
  expect(other.status === 409, `a different take after it is refused (got ${other.status})`);
  const taken = await job(jobId);
  const placed = taken.result as Rec | undefined;
  expect(taken.status === 'completed', `the take arrived through the job (${taken.status})`);
  expect((placed?.note_ids as unknown[])?.length === 2, 'two notes placed');
  const view = await call('score.get', { score_id: placed?.score_id as string });
  const hats = (((view.parts as Rec[])[0]?.regions as Rec[] | undefined) ?? [])
    .flatMap((r) => (r.notes as Rec[] | undefined) ?? [])
    .filter((n) => n.pitch === 42)
    .map((n) => (n.at as Rec).beats);
  expect(
    JSON.stringify(hats.sort()) === JSON.stringify([0.5, 1.5]),
    `the taps landed on the beats they were played on (${JSON.stringify(hats)})`,
  );
} finally {
  step('what it made is deleted');
  for (const id of made) {
    const gone = await raw('media.delete', { media_id: id });
    expect(!gone.isError, `media ${id}`);
  }
  await client.close();
}

if (failures.length) {
  process.stdout.write(
    `\n${failures.length} failed:\n${failures.map((f) => `  ${f}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('\nmusic works\n');
