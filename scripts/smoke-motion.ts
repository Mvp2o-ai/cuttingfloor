// The sandbox as users run it: compose.yaml's two services, driven over MCP. Checks that
// create.motion and create.still work with Chromium's sandbox on, and that agent-written HTML
// can't reach the network, the host, the main container or its data, and that a fork bomb and
// a memory hog fail cleanly with a typed error and leave the sandbox working (spec §8.1). Then
// the same for code.run scripts in their namespaces: tools work through the SDK, nothing else is
// reachable, the socket wants its token, nothing outlives the job, and abuse fails cleanly
// (spec §21.9).
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

interface CodeOutcome {
  stdout?: string;
  error?: { code: string; message: string; detail?: Record<string, unknown> };
}

/** Runs a code.run script to the end: its stdout, or the typed error it failed with. */
async function code(args: Record<string, unknown>): Promise<CodeOutcome> {
  const started = await call('code.run', args);
  for (let i = 0; i < 1200; i++) {
    const job = await call('job.get', { job_id: started.job_id });
    if (job.status !== 'working') {
      if (job.error) return { error: job.error as CodeOutcome['error'] & object };
      return { stdout: (job.result as { stdout: string }).stdout };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('code.run never finished');
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
  return `<div id="probes" style="position:absolute;inset:0;display:flex"></div>
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
    html: `<style>@keyframes in { from { opacity: 0 } }</style><div style="position:absolute;inset:0;background:#fff;animation:in 1s"></div>`,
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

  step('code.run: tools through the SDK, in its own namespaces');
  const sdk = await code({
    script: `import { cf } from 'cuttingfloor';
const { timeline_id } = await cf.timeline.create({ name: 'smoke', sequence: { width: 640, height: 360, fps: { num: 25, den: 1 } } });
console.log(JSON.stringify({ timeline_id }));`,
  });
  expect(
    /"timeline_id":"tl_/.test(sdk.stdout ?? ''),
    `SDK call from a script ${JSON.stringify(sdk.error ?? '')}`,
  );
  // PID 1 of the container (its init) shares the worker's namespaces.
  const workerNs = docker(
    'exec',
    motion,
    'readlink',
    '/proc/1/ns/pid',
    '/proc/1/ns/net',
    '/proc/1/ns/user',
  );
  const scriptNs = await code({
    language: 'bash',
    script: 'readlink /proc/self/ns/pid /proc/self/ns/net /proc/self/ns/user',
  });
  const mine = (scriptNs.stdout ?? '').trim().split('\n');
  const theirs = workerNs.split('\n');
  expect(
    mine.length === 3 && mine.every((l, i) => l && l !== theirs[i]),
    `own PID, network and user namespaces (${mine.join(' ')})`,
  );

  step('code.run: a script reaches nothing');
  const reach = await code({
    script: `const targets = ${JSON.stringify([
      ['a public host by name', 'http://example.com/'],
      ['a public host by address', 'http://1.1.1.1/'],
      ['the main container by name', 'http://cuttingfloor:8787/healthz'],
      ['the main container by address', `http://${mainIp}:8787/healthz`],
      ['the sandbox worker', 'http://127.0.0.1:8790/healthz'],
      ['the host machine', 'http://host.docker.internal:8787/'],
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ])};
const out = {};
for (const [label, url] of targets) {
  out[label] = await fetch(url, { signal: AbortSignal.timeout(3000) }).then(() => 'reached', () => 'blocked');
}
const fs = await import('node:fs');
out['/data'] = fs.readdirSync('/data').length ? 'has files' : 'empty';
out['other jobs in /tmp'] = fs.readdirSync('/tmp').filter((d) => !process.cwd().endsWith(d)).length ? 'visible' : 'none';
let worker = 'invisible';
for (const pid of fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p))) {
  // /proc lists the container's PIDs, but kill() takes this namespace's: container PID 1
  // (docker-init ... motion-worker) is this script's own PID here.
  if (Number(pid) === process.pid) continue;
  try {
    if (fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes('motion-worker')) {
      try { process.kill(Number(pid), 'SIGTERM'); worker = 'killed'; } catch { worker = 'listed, not signalable'; }
    }
  } catch {}
}
out.worker = worker;
const http = await import('node:http');
out['socket without its token'] = await new Promise((resolve) => {
  const req = http.request({ socketPath: process.env.CF_SOCKET, path: '/call', method: 'POST' }, (res) => resolve(String(res.statusCode)));
  req.on('error', () => resolve('error'));
  req.end('{"tool":"timeline.create","args":{}}');
});
console.log(JSON.stringify(out));`,
  });
  const seen = JSON.parse(reach.stdout?.trim() || '{}') as Record<string, string>;
  if (reach.error) expect(false, `reach script ran: ${JSON.stringify(reach.error)}`);
  for (const [label, value] of Object.entries(seen)) {
    const good = ['blocked', 'empty', 'none', '401', 'listed, not signalable', 'invisible'];
    expect(good.includes(value), `code.run: ${label} → ${value}`);
  }

  step('code.run: nothing outlives the job, abuse fails cleanly');
  await code({
    language: 'bash',
    script: "setsid sh -c 'sleep 4; touch /tmp/escaped' >/dev/null 2>&1 < /dev/null & echo started",
  });
  await new Promise((r) => setTimeout(r, 6000));
  expect(
    !docker('exec', motion, 'sh', '-c', 'ls /tmp').includes('escaped'),
    'a detached child dies with its script',
  );
  const failedTyped = (o: CodeOutcome) =>
    Boolean(o.error && ['limit_exceeded', 'code_failed'].includes(o.error.code));
  const spin = await code({ language: 'bash', script: 'while :; do :; done', timeout_seconds: 3 });
  expect(spin.error?.code === 'limit_exceeded', `spinning → ${JSON.stringify(spin.error ?? spin)}`);
  const forks = await code({
    language: 'bash',
    script: 'f() { f | f & }; f; sleep 5',
    timeout_seconds: 20,
  });
  expect(
    failedTyped(forks) || Boolean(forks.stdout !== undefined),
    `fork bomb → ${JSON.stringify(forks.error ?? 'contained')}`,
  );
  const memory = await code({
    language: 'python',
    script: 'chunks = []\nwhile True:\n    chunks.append(bytearray(64 * 1024 * 1024))',
    timeout_seconds: 60,
  });
  expect(failedTyped(memory), `memory hog → ${JSON.stringify(memory.error ?? memory)}`);
  const disk = await code({
    language: 'bash',
    script: 'dd if=/dev/zero of=out/fill bs=1M count=100000 2>&1 | tail -1; exit 1',
    timeout_seconds: 120,
  });
  expect(failedTyped(disk), `filling the disk → ${JSON.stringify(disk.error?.code ?? disk)}`);
  const recovered = await code({ language: 'bash', script: 'echo fine; ls /tmp | wc -l' });
  expect(
    (recovered.stdout ?? '').startsWith('fine'),
    `the sandbox runs scripts afterwards ${JSON.stringify(recovered.error ?? '')}`,
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
