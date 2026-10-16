// Smoke test for a built image, as a user runs it: one container in local mode, driven over
// Streamable HTTP and over `docker exec -i … cuttingfloor mcp` (stdio).
//
//   node scripts/smoke-image.ts [image]      (default ghcr.io/mvp2o-ai/cuttingfloor:latest)
//
// Needs only Docker and Node 24 with the repo's dev dependencies installed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const image = process.argv[2] ?? 'ghcr.io/mvp2o-ai/cuttingfloor:latest';
const name = `cuttingfloor-smoke-${process.pid}`;
const port = 18787 + (process.pid % 1000);
const dir = mkdtempSync(join(tmpdir(), 'cf-smoke-'));
const media = join(dir, 'media');
const exportsDir = join(dir, 'exports');
mkdirSync(media);
mkdirSync(exportsDir);
mkdirSync(join(dir, 'data'));

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

function step(label: string) {
  process.stdout.write(`• ${label}\n`);
}

async function call(client: Client, tool: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  if (res.isError) throw new Error(`${tool}: ${JSON.stringify(res.structuredContent)}`);
  return res.structuredContent ?? {};
}

async function waitJob(client: Client, jobId: string) {
  for (let i = 0; i < 600; i++) {
    const job = await call(client, 'job.get', { job_id: jobId });
    if (job.status !== 'working') {
      if (job.error) throw new Error(`job ${jobId}: ${JSON.stringify(job.error)}`);
      return job.result as Record<string, unknown>;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`job ${jobId} timed out`);
}

try {
  step(`fixture media (FFmpeg from ${image})`);
  docker(
    'run',
    '--rm',
    '--user',
    `${process.getuid?.() ?? 1000}`,
    '-v',
    `${media}:/out`,
    '--entrypoint',
    'ffmpeg',
    image,
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '/out/clip.mp4',
  );

  step('start the container in local mode');
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--user',
    `${process.getuid?.() ?? 1000}`,
    '-p',
    `127.0.0.1:${port}:8787`,
    '-e',
    'CUTTINGFLOOR_MODE=local',
    '-e',
    `CUTTINGFLOOR_PUBLIC_URL=http://127.0.0.1:${port}`,
    '-v',
    `${media}:/media/videos:ro`,
    '-v',
    `${exportsDir}:/exports`,
    '-v',
    `${join(dir, 'data')}:/data`,
    image,
  );
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {}
    if (i > 60) throw new Error(`server did not start:\n${docker('logs', name)}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  step('HTTP: health, import, edit, export, download');
  const http = new Client({ name: 'smoke-http', version: '0' });
  await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const health = await http.readResource({ uri: 'video://server/health' });
  const body = JSON.parse((health.contents[0] as { text: string }).text) as {
    engines: Record<string, string | null>;
  };
  if (!body.engines.melt || !body.engines.ffmpeg)
    throw new Error(`engines missing: ${JSON.stringify(body.engines)}`);
  process.stdout.write(`  ${body.engines.ffmpeg}\n  ${body.engines.melt}\n`);
  const started = await call(http, 'media.import', { source: { path: '/media/videos/clip.mp4' } });
  await waitJob(http, started.job_id as string);
  const sample = await call(http, 'media.import', { source: { path: '/samples/sample.mp4' } });
  const sampleInfo = await waitJob(http, sample.job_id as string);
  if (sampleInfo.status !== 'ready') throw new Error('bundled sample did not import');
  const created = await call(http, 'timeline.create', {
    name: 'Smoke',
    sequence: { width: 1280, height: 720, fps: { num: 25, den: 1 } },
  });
  const edited = await call(http, 'clip.add', {
    timeline_id: created.timeline_id,
    track_id: 't1',
    media_id: started.media_id,
    preview: 'inline',
  });
  const exported = await call(http, 'export.video', {
    timeline_id: edited.timeline_id,
    preset: 'web_1080p_h264',
  });
  const output = await waitJob(http, exported.job_id as string);
  const download = await fetch(output.url as string);
  if (!download.ok) throw new Error(`download failed: ${download.status}`);
  const bytes = (await download.arrayBuffer()).byteLength;
  const file = join(exportsDir, String(output.file).split('/').pop() ?? '');
  if (bytes !== output.bytes || statSync(file).size !== bytes)
    throw new Error('download and exports folder disagree');
  process.stdout.write(`  exported ${output.frames} frames, ${bytes} bytes → ${file}\n`);
  await http.close();

  step('stdio via docker exec: shares the serving process');
  const stdio = new Client({ name: 'smoke-stdio', version: '0' });
  await stdio.connect(
    new StdioClientTransport({
      command: 'docker',
      args: ['exec', '-i', name, 'cuttingfloor', 'mcp'],
    }),
  );
  const jobs = await call(stdio, 'job.list', {});
  if (!(jobs.jobs as unknown[]).length) throw new Error('stdio client does not see the HTTP jobs');
  const view = await call(stdio, 'timeline.get', { timeline_id: edited.timeline_id });
  process.stdout.write(
    `  stdio sees ${(jobs.jobs as unknown[]).length} jobs and a ${view.duration}-frame timeline\n`,
  );
  await stdio.close();

  step('restart: jobs and timelines survive, nothing is lost');
  docker('restart', name);
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {}
    if (i > 60) throw new Error('server did not come back');
    await new Promise((r) => setTimeout(r, 500));
  }
  const again = new Client({ name: 'smoke-again', version: '0' });
  await again.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const job = await call(again, 'job.get', { job_id: exported.job_id });
  if (job.status !== 'completed') throw new Error(`job after restart: ${JSON.stringify(job)}`);
  await again.close();
  process.stdout.write('smoke test passed\n');
} catch (error) {
  process.stderr.write(`smoke test FAILED: ${(error as Error).message}\n`);
  try {
    process.stderr.write(docker('logs', name));
  } catch {}
  process.exitCode = 1;
} finally {
  try {
    docker('rm', '-f', name);
  } catch {}
}
