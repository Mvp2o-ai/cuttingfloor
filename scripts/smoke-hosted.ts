// Smoke test for a live hosted server, as a client reaches it: over HTTPS with a bearer key.
//
//   CF_KEY=cf_… node scripts/smoke-hosted.ts https://cuttingfloorai.apifunnel.ai
//
// Checks that a request without a key is refused, then that create.still, create.motion and
// code.run work in the server's sandbox (gVisor on Hetzner), media.analyze look answers on the
// server's own TypeSafe key, and an export comes back as a signed link that downloads.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.argv[2] ?? 'https://cuttingfloorai.apifunnel.ai').replace(/\/$/, '');
const key = process.env.CF_KEY;
if (!key) throw new Error('Set CF_KEY to one of the server’s API keys');

const step = (label: string) => process.stdout.write(`• ${label}\n`);
const failures: string[] = [];
function expect(ok: boolean, label: string) {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  if (!ok) failures.push(label);
}

const client = new Client({ name: 'smoke-hosted', version: '0' });

async function call(tool: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  if (res.isError) throw new Error(`${tool}: ${JSON.stringify(res.structuredContent)}`);
  return res.structuredContent ?? {};
}

/** Starts a long-running tool and waits for its job: the result, or the typed error. */
async function run(tool: string, args: Record<string, unknown>) {
  const started = await call(tool, args);
  if (!started.job_id) return { result: started };
  for (let i = 0; i < 600; i++) {
    const job = await call('job.get', { job_id: started.job_id, wait_seconds: 20 });
    if (job.status !== 'working') {
      if (job.error) return { error: job.error as { code: string; message: string } };
      return { result: job.result as Record<string, unknown> };
    }
  }
  throw new Error(`${tool} never finished`);
}

step('a request without a key is refused');
const anon = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
expect(anon.status === 401, `401 without a key (got ${anon.status})`);

await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  }),
);
const { tools } = await client.listTools();
expect(tools.length > 40, `${tools.length} tools with a key`);

step('create.still and create.motion in the sandbox');
const still = await run('create.still', {
  html: '<div style="width:100%;height:100%;background:#fff"></div>',
  width: 320,
  height: 180,
});
expect(Boolean(still.result?.media_id), `create.still ${JSON.stringify(still.error ?? '')}`);
const motion = await run('create.motion', {
  html: '<style>@keyframes in { from { opacity: 0 } }</style><div style="position:absolute;inset:0;background:#e11;animation:in 1s"></div>',
  duration_seconds: 2,
  width: 640,
  height: 360,
});
const mediaId = motion.result?.media_id as string | undefined;
expect(Boolean(mediaId), `create.motion ${JSON.stringify(motion.error ?? '')}`);

step('code.run calls the tools from a script');
const code = await run('code.run', {
  script: `import { cf } from 'cuttingfloor';
const { timeline_id } = await cf.timeline.create({ name: 'smoke', sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } } });
console.log(timeline_id);`,
});
expect(
  /^tl_/.test(String(code.result?.stdout ?? '')),
  `code.run ${JSON.stringify(code.error ?? '')}`,
);

if (mediaId) {
  step('media.analyze look on the server’s TypeSafe key');
  const look = await run('media.analyze', {
    media_id: mediaId,
    kind: 'look',
    at_seconds: [1.5],
    questions: { red: { type: 'noul', instructions: 'Is `frame` filled with red?' } },
  });
  const frame = (look.result?.look as { frames?: Array<{ answers: { red?: { noul: number } } }> })
    ?.frames?.[0];
  expect(
    (frame?.answers.red?.noul ?? 0) >= 0.5,
    `look says red (${JSON.stringify(frame?.answers ?? look.error)})`,
  );

  step('export a review file and download it');
  const tl = await call('timeline.create', {
    name: 'smoke',
    sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } },
  });
  const added = await call('clip.add', {
    timeline_id: tl.timeline_id,
    track_id: 't1',
    media_id: mediaId,
  });
  const exported = await run('export.video', {
    timeline_id: added.timeline_id,
    preset: 'review_h264',
  });
  const url = exported.result?.url as string | undefined;
  expect(Boolean(url), `export.video ${JSON.stringify(exported.error ?? '')}`);
  if (url) {
    const file = await fetch(url);
    const bytes = (await file.arrayBuffer()).byteLength;
    expect(file.ok && bytes > 1000, `signed link downloads (${file.status}, ${bytes} bytes)`);
  }
}

await client.close();
if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
