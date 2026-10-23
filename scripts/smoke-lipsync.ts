// Manual smoke test for create.lipsync against the real sync. labs API, as a client reaches a
// running server. It spends a few seconds of the key's credit, so it runs only when SYNC_API_KEY
// is set, and never in CI.
//
//   SYNC_API_KEY=… node scripts/smoke-lipsync.ts                       # local, http://127.0.0.1:8787
//   SYNC_API_KEY=… CF_KEY=cf_… node scripts/smoke-lipsync.ts https://api.cuttingfloor.ai
//
// Hosted, the key goes in the X-Cuttingfloor-Key-Sync header. Locally the server reads its own
// .env, so put SYNC_API_KEY there too (docker compose up -d after). The talking video is
// LIPSYNC_VIDEO (a URL, or locally a path under the media roots; default /samples/sample.mp4); the
// new words are a create.voiceover. Only the first LIPSYNC_SECONDS (default 3) are sent.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const key = process.env.SYNC_API_KEY;
if (!key) {
  process.stdout.write('SYNC_API_KEY is not set: skipping the lip-sync smoke test\n');
  process.exit(0);
}
const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const video = process.env.LIPSYNC_VIDEO ?? '/samples/sample.mp4';
const seconds = Number(process.env.LIPSYNC_SECONDS ?? 3);

const client = new Client({ name: 'smoke-lipsync', version: '0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: {
      headers: {
        'X-Cuttingfloor-Key-Sync': key,
        ...(process.env.CF_KEY ? { authorization: `Bearer ${process.env.CF_KEY}` } : {}),
      },
    },
  }),
);

type Structured = Record<string, unknown>;
async function call(tool: string, args: Structured): Promise<Structured> {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Structured;
  };
  if (res.isError) throw new Error(`${tool}: ${JSON.stringify(res.structuredContent)}`);
  return res.structuredContent ?? {};
}

async function finish(started: Structured, label: string): Promise<Structured> {
  const until = Date.now() + 30 * 60_000;
  let last = '';
  for (;;) {
    const job = await call('job.get', { job_id: started.job_id });
    if (job.status_message !== last) process.stdout.write(`  ${label}: ${job.status_message}\n`);
    last = String(job.status_message ?? '');
    if (job.status === 'completed') return job.result as Structured;
    if (job.status !== 'working') throw new Error(`${label}: ${JSON.stringify(job.error)}`);
    if (Date.now() > until) throw new Error(`${label}: still working after 30 minutes`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const health = JSON.parse(
  String(
    ((await client.readResource({ uri: 'video://server/health' })).contents[0] as { text: string })
      .text,
  ),
);
process.stdout.write(`• ${base}: sync key ${JSON.stringify(health.providers.sync)}\n`);

const source = /^https?:/.test(video) ? { url: video } : { path: video };
const talk = await finish(await call('media.import', { source }), 'import');
const line = await finish(
  await call('create.voiceover', { text: 'This line was changed with lip sync.' }),
  'voiceover',
);
process.stdout.write(`• lip-syncing the first ${seconds} s of ${talk.media_id}\n`);
const synced = await finish(
  await call('create.lipsync', {
    video: talk.media_id,
    audio: line.media_id,
    range: { start_seconds: 0, end_seconds: seconds },
  }),
  'lipsync',
);
process.stdout.write(
  `✓ ${synced.media_id}: ${synced.duration_seconds} s, ${synced.width}×${synced.height}, sound ${synced.has_audio}\n`,
);
await client.close();
