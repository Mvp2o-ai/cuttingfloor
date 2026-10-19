// Smoke test for a live hosted server, as a client reaches it: over HTTPS with a bearer key.
//
//   node scripts/smoke-hosted.ts https://cuttingfloorai.apifunnel.ai
//
// The maintenance key comes from CF_KEY, else the first key in deploy/hetzner/cuttingfloor.env
// (git-ignored, the file up.sh deploys). Keys are for maintenance; clients sign in with OAuth.
//
// Checks that a request without a key is refused, then that create.still, create.motion and
// code.run work in the server's sandbox (gVisor on Hetzner), media.analyze look answers on the
// server's own TypeSafe key, an export comes back as a signed link that downloads, and that file,
// sent back in two parts through media.upload, imports as media; the upload link opens as a drop
// page in a browser, a data: URI imports, and the export link passed as an attached file imports.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.argv[2] ?? 'https://cuttingfloorai.apifunnel.ai').replace(/\/$/, '');
const key =
  process.env.CF_KEY ??
  (await readFile(new URL('../deploy/hetzner/cuttingfloor.env', import.meta.url), 'utf8').then(
    (env) => /^CUTTINGFLOOR_API_KEYS=[^:,\s]+:([^,\s]+)/m.exec(env)?.[1],
    () => undefined,
  ));
if (!key)
  throw new Error('Set CF_KEY, or CUTTINGFLOOR_API_KEYS in deploy/hetzner/cuttingfloor.env');

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

step('a data: URI imports, checked by its SHA-256');
const dot = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const inline = await run('media.import', {
  source: {
    data: `data:image/png;base64,${dot.toString('base64')}`,
    sha256: createHash('sha256').update(dot).digest('hex'),
  },
  name: 'dot.png',
});
expect(
  inline.result?.status === 'ready' && inline.result?.kind === 'image',
  `data: URI imports (${JSON.stringify(inline.error ?? inline.result?.status)})`,
);

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
    const body = Buffer.from(await file.arrayBuffer());
    const bytes = body.length;
    expect(file.ok && bytes > 1000, `signed link downloads (${file.status}, ${bytes} bytes)`);

    step('media.upload: a file sent in two parts imports as media');
    const up = await call('media.upload', { name: 'smoke-upload.mp4', bytes });
    const half = Math.floor(bytes / 2);
    const parts = [
      [0, half],
      [half, bytes],
    ] as const;
    let complete = false;
    for (const [from, to] of parts) {
      const res = await fetch(String(up.url), {
        method: 'PUT',
        headers: { 'content-range': `bytes ${from}-${to - 1}/${bytes}` },
        body: body.subarray(from, to),
      });
      complete = res.headers.get('upload-complete') === 'true';
      expect(res.ok, `part ${from}-${to - 1} accepted (${res.status})`);
    }
    expect(complete, 'upload complete');
    const imported = await run('media.import', { source: { upload_id: up.upload_id } });
    expect(
      imported.result?.status === 'ready' && imported.result?.kind === 'video',
      `uploaded file imports (${JSON.stringify(imported.error ?? imported.result?.status)})`,
    );

    step('the upload link is a drop page in a browser');
    const fresh = await call('media.upload', { name: 'smoke-page.mp4' });
    const page = await fetch(String(fresh.url), { headers: { accept: 'text/html' } });
    const html = await page.text();
    expect(
      page.ok && html.includes(String(fresh.upload_id)) && html.includes('Send a file'),
      `drop page (${page.status})`,
    );

    step('a file the client attached imports from its download URL');
    const attached = await run('media.import', {
      file: {
        download_url: url,
        file_id: 'smoke',
        mime_type: 'video/mp4',
        file_name: 'attached.mp4',
      },
    });
    expect(
      attached.result?.status === 'ready' && attached.result?.name === 'attached.mp4',
      `attached file imports (${JSON.stringify(attached.error ?? attached.result?.status)})`,
    );
  }
}

await client.close();
if (failures.length) {
  process.stdout.write(`\n${failures.length} failed\n`);
  process.exit(1);
}
process.stdout.write('\nall passed\n');
