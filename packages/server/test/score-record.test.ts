import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { ScoreRecordResult } from '@cuttingfloor/schema';
import { createServer, type RenderScoreDoc } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { ok, type TestEnv, testRuntime } from './helpers.ts';

// score.record as a client meets it: the tool, its result against the declared schema, the view
// it shows, and the session's life as a job. The take itself is played through the hosted
// server's two calls (apps/hosted/test/record.test.ts and record-view.test.ts).

let env: TestEnv;
beforeAll(async () => {
  env = await testRuntime();
});

const never: RenderScoreDoc = async () => {
  throw new Error('score.record renders nothing itself: record.session does');
};

async function connect(renderScoreDoc?: RenderScoreDoc): Promise<Client> {
  const server = createServer({
    runtime: env.runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => 'local',
    ...(renderScoreDoc ? { renderScoreDoc } : {}),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'record', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

async function kitScore(client: Client): Promise<{ score_id: string; part_id: string }> {
  let { score_id } = await ok<{ score_id: string }>(client, 'score.create', {
    tempo: 96,
    meter: { beats: 4, unit: 4 },
    sample_rate: 44_100,
  });
  const part = await ok<{ score_id: string; part_id: string }>(client, 'score.add_part', {
    score_id,
  });
  score_id = (
    await ok<{ score_id: string }>(client, 'score.add_device', {
      score_id: part.score_id,
      part_id: part.part_id,
      name: 'kit_909',
    })
  ).score_id;
  score_id = (
    await ok<{ score_id: string }>(client, 'score.add_region', {
      score_id,
      part_id: part.part_id,
      at_beats: 0,
      length_beats: 16,
    })
  ).score_id;
  return { score_id, part_id: part.part_id };
}

describe('score.record', () => {
  it('is listed with its view, inside the description cut, with an output schema', async () => {
    const client = await connect(never);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'score.record');
    expect(tool?.description?.length).toBeLessThanOrEqual(4096);
    expect(tool?.description?.startsWith('Take a performance from the user into a score')).toBe(
      true,
    );
    expect(tool?.outputSchema).toBeDefined();
    expect(tool?._meta).toEqual({ ui: { resourceUri: 'ui://cuttingfloor/record' } });
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(
      [
        'click',
        'count_in_beats',
        'from_beats',
        'input',
        'length_beats',
        'pads',
        'part_id',
        'score_id',
        'until_beats',
        'velocity',
      ].sort(),
    );
    // The size of the tool list every connection pays for (server.test.ts holds the budget).
    process.stdout.write(`tools/list: ${JSON.stringify(tools).length} bytes\n`);
    const view = await client.readResource({ uri: 'ui://cuttingfloor/record' });
    const content = view.contents[0] as unknown as {
      mimeType: string;
      text: string;
      _meta: { ui: Record<string, unknown> };
    };
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(content._meta.ui).toMatchObject({
      permissions: { microphone: {} },
      csp: { connectDomains: ['http://127.0.0.1:8787'] },
    });
    expect(content.text).toContain('const PAGE = null;');
  });

  it('opens a session at once: the url, the job, the pads, and native_view for apps', async () => {
    const client = await connect(never);
    const { score_id, part_id } = await kitScore(client);
    const result = ScoreRecordResult.parse(
      await ok(client, 'score.record', {
        score_id,
        part_id,
        input: 'pads',
        velocity: 90,
        length_beats: 0.5,
        pads: ['C2', 'D2'],
      }),
    );
    expect(result).toMatchObject({
      status: 'working',
      input: 'pads',
      native_view: { component: 'record', version: 1 },
      // Default the score's end: the region's 16 beats, at 96 bpm 10 s.
      loop: { from: { beats: 0 }, until: { beats: 16, seconds: 10 }, length_beats: 16 },
      warnings: [],
    });
    expect(result.pads?.[0]).toEqual({ pitch: 36, name: 'C2', plays: 'kick (C2)' });
    expect(result.url).toMatch(new RegExp(`/record/local/${result.job_id}\\?exp=`));
    expect(result.expiry).toMatch(/^Expires/);
    const job = await ok(client, 'job.get', { job_id: result.job_id });
    expect(job).toMatchObject({ status: 'working', tool: 'score.record' });
    expect(String(job.status_message)).toMatch(/waiting for the user/);
    // Pads named by the agent, on any instrument; a microphone take gets its upload.
    const named = ScoreRecordResult.parse(
      await ok(client, 'score.record', {
        score_id,
        part_id,
        input: 'pads',
        velocity: 90,
        length_beats: 0.5,
        pads: ['C3', 61.5],
        until_beats: 4,
      }),
    );
    expect(named.pads?.map((p) => [p.pitch, p.name])).toEqual([
      [48, 'C3'],
      [61.5, 'D4'],
    ]);
    const mic = ScoreRecordResult.parse(
      await ok(client, 'score.record', { score_id, part_id, input: 'microphone', until_beats: 4 }),
    );
    expect(mic.upload?.url).toMatch(/\/uploads\//);
    expect(mic.pads).toBeUndefined();
    for (const r of [result, named, mic]) await ok(client, 'job.cancel', { job_id: r.job_id });
  });

  it('a session nobody plays ends expired, and is no longer counted as open', async () => {
    const client = await connect(never);
    const { score_id, part_id } = await kitScore(client);
    const opened = ScoreRecordResult.parse(
      await ok(client, 'score.record', { score_id, part_id, input: 'microphone', until_beats: 4 }),
    );
    // A restart leaves it alone: no server runs it, it waits on a person.
    await env.runtime.jobs.recover({ startup: true });
    expect((await ok(client, 'job.get', { job_id: opened.job_id })).status).toBe('working');
    // Past its time, the reaper ends it.
    const store = env.runtime.jobs.store;
    const job = await store.get(opened.job_id, 'local');
    if (!job) throw new Error('no job');
    await store.update(job, {
      meta: { ...job.meta, waits_until: new Date(Date.now() - 1000).toISOString() },
    });
    await env.runtime.jobs.recover({ startup: false });
    const ended = await ok(client, 'job.get', { job_id: opened.job_id });
    expect(ended).toMatchObject({ status: 'failed', error: { code: 'expired' } });
  });
});
