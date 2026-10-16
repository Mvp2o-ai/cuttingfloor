// The motion sandbox as users run it: compose.yaml's two services, driven over MCP. Checks that
// create.motion and create.still work with Chromium's sandbox on, and that agent-written HTML
// can't reach the network, the host, the main container or its data, and that a fork bomb and
// a memory hog fail cleanly with a typed error and leave the sandbox working (spec §8.1).
//
//   node scripts/smoke-motion.ts [image]      (default ghcr.io/mvp2o-ai/cuttingfloor:latest)
//
// Needs Docker with Compose and Node 24 with the repo's dev dependencies installed.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const image = process.argv[2] ?? 'ghcr.io/mvp2o-ai/cuttingfloor:latest';
const project = `cfmotion${process.pid}`;
const port = 19787 + (process.pid % 1000);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'cf-motion-'));
for (const d of ['media', 'exports']) {
  mkdirSync(join(dir, d));
  chmodSync(join(dir, d), 0o777);
}
const env = {
  ...process.env,
  CUTTINGFLOOR_IMAGE: image,
  CUTTINGFLOOR_NAME: project,
  CUTTINGFLOOR_PORT: String(port),
  CUTTINGFLOOR_MEDIA: join(dir, 'media'),
  CUTTINGFLOOR_EXPORTS: join(dir, 'exports'),
};
const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-p', project, '-f', join(root, 'compose.yaml'), ...args], {
    encoding: 'utf8',
    env,
  }).trim();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const step = (label: string) => process.stdout.write(`• ${label}\n`);

interface Outcome {
  media_id?: string;
  error?: { code: string; message: string };
}

let client: Client;

async function call(tool: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  if (res.isError) throw new Error(`${tool}: ${JSON.stringify(res.structuredContent)}`);
  return res.structuredContent ?? {};
}

/** Runs a create.* tool to the end: the media it made, or the typed error it failed with. */
async function create(tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const started = await call(tool, args);
  if (!started.job_id) return { media_id: started.media_id as string };
  for (let i = 0; i < 600; i++) {
    const job = await call('job.get', { job_id: started.job_id });
    if (job.status !== 'working') {
      if (job.error) return { error: job.error as Outcome['error'] & object };
      return { media_id: (job.result as { media_id: string }).media_id };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${tool} never finished`);
}

/** The colour of each of `n` equal columns of a media's first frame, as 'white' or 'black'. */
async function columns(mediaId: string, n: number): Promise<string[]> {
  const res = (await client.callTool({
    name: 'render.frames',
    arguments: { media_id: mediaId, frames: [0], layout: 'single', format: 'png' },
  })) as { content: Array<{ type: string; data?: string }> };
  const png = Buffer.from(res.content.find((c) => c.type === 'image')?.data ?? '', 'base64');
  const raw = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--entrypoint',
      'ffmpeg',
      image,
      '-v',
      'error',
      '-i',
      '-',
      '-vf',
      `scale=${n}:1:flags=area,format=rgb24`,
      '-f',
      'rawvideo',
      '-',
    ],
    { input: png },
  );
  return Array.from({ length: n }, (_, i) => ((raw[i * 3] ?? 0) > 128 ? 'white' : 'black'));
}

/** A page that tries each URL with a synchronous request and paints a column per result. */
function probePage(urls: string[]): string {
  return `<div id="probes" class="clip" data-start="0" data-duration="1" data-track-index="0"
  style="position:absolute;inset:0;display:flex"></div>
<script>
  const Request = window['XMLHttp' + 'Request'];
  const probes = document.getElementById('probes');
  for (const url of ${JSON.stringify(urls)}) {
    let reached = false;
    try {
      const x = new Request();
      x.open('GET', url, false);
      x.send();
      reached = x.status > 0;
    } catch (e) {}
    const col = document.createElement('div');
    col.style.cssText = 'flex:1;background:' + (reached ? '#ffffff' : '#000000');
    probes.appendChild(col);
  }
  if (window.gsap) {
    const tl = gsap.timeline({ paused: true });
    tl.to('#probes', { opacity: 1, duration: 1 });
    window.__timelines = { main: tl };
  }
</script>`;
}

const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
  if (!ok) failures.push(what);
};

try {
  step(`compose up (${image})`);
  compose('up', '-d', '--no-build', '--quiet-pull');
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {}
    if (i > 60) throw new Error(`server did not start:\n${compose('logs')}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  client = new Client({ name: 'smoke-motion', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const motion = `${project}-motion`;

  step('the motion container itself');
  const inspect = JSON.parse(docker('inspect', motion))[0] as {
    HostConfig: { CapDrop: string[]; ReadonlyRootfs: boolean; SecurityOpt: string[] };
  };
  expect(inspect.HostConfig.ReadonlyRootfs, 'read-only root');
  expect(inspect.HostConfig.CapDrop.includes('ALL'), 'all capabilities dropped');
  expect(
    inspect.HostConfig.SecurityOpt.some((o) => o.startsWith('seccomp={')),
    'its own seccomp profile',
  );
  expect(docker('exec', motion, 'id', '-u') !== '0', 'not root');
  const os = (code: string) => {
    try {
      return docker('exec', motion, 'node', '-e', code);
    } catch {
      return 'failed';
    }
  };
  expect(
    os(
      "fetch('http://example.com').then(()=>console.log('reached'),()=>console.log('blocked'))",
    ) === 'blocked',
    'no route out from the container',
  );
  const mounts = JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', motion)) as Array<{
    Type: string;
    Destination: string;
  }>;
  expect(
    !mounts.some((m) => m.Type === 'volume' || m.Type === 'bind'),
    `no volumes or host folders (${mounts.map((m) => `${m.Type}:${m.Destination}`).join(', ') || 'none'})`,
  );
  expect(os("console.log(require('fs').readdirSync('/data').length)") === '0', '/data is empty');

  step('create.still and create.motion with Chromium sandboxed');
  const still = await create('create.still', {
    html: '<div style="width:100%;height:100%;background:#ffffff"></div>',
    width: 320,
    height: 180,
  });
  expect(Boolean(still.media_id), `create.still ${JSON.stringify(still.error ?? '')}`);
  const anim = await create('create.motion', {
    html: `<div id="b" class="clip" data-start="0" data-duration="1" data-track-index="0" style="position:absolute;inset:0;background:#fff"></div>
<script>const tl = gsap.timeline({ paused: true }); tl.from('#b', { opacity: 0, duration: 1 }); window.__timelines = { main: tl };</script>`,
    duration_seconds: 1,
    width: 320,
    height: 180,
  });
  expect(Boolean(anim.media_id), `create.motion ${JSON.stringify(anim.error ?? '')}`);

  step('agent HTML reaches nothing');
  const mainIp = docker(
    'inspect',
    '-f',
    `{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k "${project}_motion"}}{{$v.IPAddress}}{{end}}{{end}}`,
    project,
  );
  const targets: Array<[string, string]> = [
    ['its own page (control: must be reached)', 'index.html'],
    ['a public host by name', 'http://example.com/'],
    ['a public host by address', 'http://1.1.1.1/'],
    ['the main container by name', 'http://cuttingfloor:8787/healthz'],
    ['the main container by address', `http://${mainIp}:8787/healthz`],
    ['the host machine', 'http://host.docker.internal:8787/'],
    ['the Docker bridge gateway', 'http://172.17.0.1/'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['the data volume by file URL', 'file:///data/secret.key'],
    ['the container filesystem by file URL', 'file:///etc/passwd'],
  ];
  for (const tool of ['create.motion', 'create.still'] as const) {
    const made = await create(tool, {
      html: probePage(targets.map(([, url]) => url)),
      width: 640,
      height: 64,
      ...(tool === 'create.motion' ? { duration_seconds: 1, fps: 10 } : {}),
    });
    if (!made.media_id) {
      expect(false, `${tool} probe page rendered: ${JSON.stringify(made.error)}`);
      continue;
    }
    const seen = await columns(made.media_id, targets.length);
    targets.forEach(([label], i) => {
      expect(
        seen[i] === (i === 0 ? 'white' : 'black'),
        `${tool}: ${label} → ${seen[i] === 'white' ? 'reached' : 'blocked'}`,
      );
    });
  }

  step('abuse fails cleanly');
  const typed = (o: Outcome) =>
    Boolean(o.error && ['limit_exceeded', 'render_failed'].includes(o.error.code));
  const bomb = await create('create.still', {
    html: `<script>
      const src = URL.createObjectURL(new Blob(['for(;;){try{new Worker(self.location.href)}catch(e){}}']));
      for (;;) { try { new Worker(src); } catch (e) {} }
    </script>`,
    width: 320,
    height: 180,
  });
  expect(typed(bomb), `fork bomb → ${JSON.stringify(bomb.error ?? bomb)}`);
  const hog = await create('create.still', {
    html: `<script>const a = []; for (;;) a.push(new Uint8Array(64 * 1024 * 1024).fill(1));</script>`,
    width: 320,
    height: 180,
  });
  expect(typed(hog), `memory hog → ${JSON.stringify(hog.error ?? hog)}`);
  const after = await create('create.still', {
    html: '<p style="color:#fff">still working</p>',
    width: 320,
    height: 180,
  });
  expect(
    Boolean(after.media_id),
    `the sandbox still renders afterwards ${JSON.stringify(after.error ?? '')}`,
  );
  expect(
    docker('inspect', '-f', '{{.State.Running}}', motion) === 'true',
    'the motion container is still up',
  );

  await client.close();
  if (failures.length)
    throw new Error(`${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  step('motion sandbox OK');
} finally {
  if (process.env.KEEP) process.exit(failures.length ? 1 : 0);
  try {
    compose('down', '-v', '--timeout', '2');
  } catch {}
}
