// node scripts/smoke-motion-load.ts [https://api.cuttingfloor.ai] [renders=4] [seconds=12] [opaque|alpha]
// Fires several 1080x1920 create.motion renders at once on the hosted server and checks that
// every one completes: a busy sandbox queues them; it must not fail or restart under them.
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.argv[2] ?? 'https://api.cuttingfloor.ai').replace(/\/$/, '');
const renders = Number(process.argv[3] ?? 4);
const seconds = Number(process.argv[4] ?? 12);
const transparent = process.argv[5] === 'alpha';
const key =
  process.env.CF_KEY ??
  (await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8').then(
    (env) => /^CUTTINGFLOOR_API_KEYS=[^:,\s]+:([^,\s]+)/m.exec(env)?.[1],
    () => undefined,
  ));
if (!key)
  throw new Error('Set CF_KEY, or CUTTINGFLOOR_API_KEYS in deploy/hetzner/cuttingfloor.env');

const client = new Client({ name: 'smoke-motion-load', version: '0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  }),
);

async function call(tool: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: unknown;
  };
  if (res.isError)
    throw new Error(`${tool}: ${JSON.stringify(res.structuredContent ?? res.content)}`);
  return res.structuredContent ?? {};
}

// A page with real work per frame: gradients, text and a moving blur, like a Shorts caption card.
// A fresh page each run: an identical one comes back from the cache without rendering.
const run = Date.now().toString(36);
const html = (n: number) => `<style>
body{margin:0;background:${transparent ? 'transparent' : '#111'};font:700 120px system-ui;color:#fff}
.b{position:absolute;width:600px;height:600px;border-radius:50%;filter:blur(40px);
background:radial-gradient(#f0a,#0af);animation:m 3s linear infinite alternate}
@keyframes m{from{transform:translate(0,0)}to{transform:translate(480px,1300px)}}
h1{position:absolute;top:800px;width:100%;text-align:center;animation:p 1s ease-in-out infinite alternate}
@keyframes p{from{transform:scale(1)}to{transform:scale(1.2)}}
</style><div class="b"></div><h1>Render ${n}</h1><!-- ${run} -->`;

const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: renders }, async (_, n) => {
    const started = await call('create.motion', {
      html: html(n),
      duration_seconds: seconds,
      width: 1080,
      height: 1920,
      fps: 30,
      transparent,
    });
    let last = '';
    for (;;) {
      const job = await call('job.get', { job_id: started.job_id, wait_seconds: 20 });
      const said = `${job.status} ${JSON.stringify(job.progress ?? '')}`;
      if (said !== last) process.stdout.write(`  ${n}: ${said}\n`);
      last = said;
      if (job.status !== 'working') {
        const secs = Math.round((Date.now() - t0) / 1000);
        return job.error
          ? { n, secs, error: job.error as { code: string; message: string } }
          : { n, secs, ok: true };
      }
    }
  }),
);
await client.close();
for (const r of results)
  process.stdout.write(
    `${r.ok ? '✓' : '✗'} render ${r.n} in ${r.secs} s ${r.error ? JSON.stringify(r.error) : ''}\n`,
  );
if (results.some((r) => !r.ok)) process.exit(1);
