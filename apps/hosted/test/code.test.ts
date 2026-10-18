import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { startMotionWorker } from '@cuttingfloor/motion';
import { createServer, Runtime } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';

// code.run against a real sandbox worker (in-process here) and the real server: scripts in each
// language call tools through the SDK, read inputs, write timelines to out/, and fail cleanly.
// Needs no engines; the media paths are covered in the image by e2e.test.ts.

const exec = promisify(execFile);

// Namespaces where the host allows them (Linux), plain processes elsewhere (macOS, docker build).
const namespaces = await exec('unshare', [
  '--user',
  '--map-current-user',
  '--pid',
  '--fork',
  '--net',
  'true',
]).then(
  () => true,
  () => false,
);
if (!namespaces) process.env.CUTTINGFLOOR_CODE_ISOLATION = 'none';
const python = await exec('python3', ['--version']).then(
  () => true,
  () => false,
);

let worker: Server;
let http: Server;
let runtime: Runtime;
const clients: Client[] = [];

async function connect(owner: string): Promise<Client> {
  const server = createServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'code-test', version: '0' });
  await client.connect(b);
  clients.push(client);
  return client;
}

interface Run {
  status: string;
  result?: {
    exit_code: number;
    stdout: string;
    stderr: string;
    outputs: Array<{
      name: string;
      type: string;
      timeline_id?: string;
      media_id?: string;
      url?: string;
      mime_type?: string;
      error?: { code: string; message: string };
    }>;
  };
  error?: { code: string; message: string; detail?: { stdout?: string; stderr?: string } };
}

async function run(client: Client, args: Record<string, unknown>): Promise<Run> {
  const started = (await client.callTool({ name: 'code.run', arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  if (started.isError) return { status: 'refused', error: started.structuredContent as never };
  const id = started.structuredContent?.job_id as string;
  for (;;) {
    const got = (await client.callTool({ name: 'job.get', arguments: { job_id: id } })) as {
      structuredContent: Run;
    };
    if (got.structuredContent.status !== 'working') return got.structuredContent;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const seq = { width: 1280, height: 720, fps: { num: 25, den: 1 } };

beforeAll(async () => {
  worker = await startMotionWorker({ port: 0, host: '127.0.0.1' });
  const dir = await mkdtemp(join(tmpdir(), 'cf-code-'));
  runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'local',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 2,
    outputUrlTtlMs: 3_600_000,
    maxDownloadBytes: 1024 ** 3,
    allowPrivateUrls: true,
    inlineMaxBytes: 32 * 1024 ** 2,
    motionUrl: `http://127.0.0.1:${(worker.address() as AddressInfo).port}`,
  });
  await runtime.start({ sweep: false });
  http = createHttpServer({ runtime, credentials: new LocalCredentialStore({}, false) });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
});

/** Downloads a signed link from the HTTP server (the runtime's public URL names no real port). */
async function download(url: string | undefined): Promise<Response> {
  const at = new URL(url ?? '');
  return fetch(
    `http://127.0.0.1:${(http.address() as AddressInfo).port}${at.pathname}${at.search}`,
  );
}

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  worker?.close();
  http?.close();
  runtime?.stop();
});

describe(`code.run (${namespaces ? 'namespaces' : 'no isolation'})`, () => {
  it('calls tools through the SDK and hands a timeline back through out/', async () => {
    const client = await connect('alice');
    const done = await run(client, {
      script: `
import { writeFile } from 'node:fs/promises';
import { cf, out, progress } from 'cuttingfloor';
const { timeline_id } = await cf.timeline.create({ name: 'from code', sequence: ${JSON.stringify(seq)} });
await progress(0.5, 'half way');
const view = await cf.timeline.get({ timeline_id });
view.name = 'renamed in code';
await writeFile(out('edited.timeline.json'), JSON.stringify(view));
try {
  await cf.clip.trim({ timeline_id, clip_id: 'nope', side: 'end', by_frames: 1 });
} catch (e) {
  console.log(JSON.stringify({ timeline_id, code: e.code, hint: Boolean(e.hint) }));
}`,
    });
    expect(done.error).toBeUndefined();
    expect(done.result?.exit_code).toBe(0);
    const printed = JSON.parse(done.result?.stdout.trim().split('\n').pop() ?? '{}');
    // Arguments that fail the tool's schema come back as a typed error too.
    expect(printed.code).toBe('bad_request');
    const [output] = done.result?.outputs ?? [];
    expect(output?.name).toBe('edited.timeline.json');
    const loaded = (await client.callTool({
      name: 'timeline.get',
      arguments: { timeline_id: output?.timeline_id },
    })) as { structuredContent: { name: string } };
    expect(loaded.structuredContent.name).toBe('renamed in code');
    // The script's timeline belongs to the caller, like any other.
    const own = (await client.callTool({
      name: 'timeline.get',
      arguments: { timeline_id: printed.timeline_id },
    })) as { isError?: boolean };
    expect(own.isError).toBeFalsy();
  }, 60_000);

  it('reads inputs and acts only as its owner', async () => {
    const alice = await connect('alice');
    const bob = await connect('bob');
    const made = (await alice.callTool({
      name: 'timeline.create',
      arguments: { name: 'alice only', sequence: seq },
    })) as { structuredContent: { timeline_id: string } };
    const id = made.structuredContent.timeline_id;
    const read = await run(alice, {
      language: 'bash',
      inputs: { timeline_ids: [id] },
      script: `set -e\ngrep -o '"name": "alice only"' "in/${id}.timeline.json"\ncf timeline.get '{"timeline_id":"${id}"}' | grep -c alice`,
    });
    expect(read.error).toBeUndefined();
    expect(read.result?.stdout).toContain('"name": "alice only"');
    // Bob's script can't see Alice's timeline, as an input or through the SDK.
    const asInput = await run(bob, { inputs: { timeline_ids: [id] }, script: 'console.log(1)' });
    expect(['not_found', 'expired']).toContain(asInput.error?.code);
    const viaSdk = await run(bob, {
      script: `import { cf } from 'cuttingfloor';\nawait cf.timeline.get({ timeline_id: '${id}' });`,
    });
    expect(viaSdk.error?.code).toBe('code_failed');
    expect(viaSdk.error?.detail?.stderr).toMatch(/expired|not_found/);
  }, 60_000);

  it.skipIf(!python)(
    'runs Python with the same SDK',
    async () => {
      const client = await connect('alice');
      const done = await run(client, {
        language: 'python',
        script: `from cuttingfloor import cf, CfError
t = cf.timeline.create(name="py", sequence=${JSON.stringify(seq)})
print(t["timeline_id"])
try:
    cf.code.run(script="1")
except CfError as e:
    print(e.code)`,
      });
      expect(done.error).toBeUndefined();
      const [tid, denied] = done.result?.stdout.trim().split('\n') ?? [];
      expect(tid).toMatch(/^tl_/);
      expect(denied).toBe('bad_request');
    },
    60_000,
  );

  it('refuses recursion and fails with logs, a timeout or a bad output', async () => {
    const client = await connect('alice');
    const nested = await run(client, {
      script: `import { cf } from 'cuttingfloor';\nawait cf.code.run({ script: '1' });`,
    });
    expect(nested.error?.code).toBe('code_failed');
    expect(nested.error?.detail?.stderr).toMatch(/can't be called from code.run/);

    const failed = await run(client, {
      language: 'bash',
      script: 'echo working; echo broken >&2; exit 3',
    });
    expect(failed.error).toMatchObject({
      code: 'code_failed',
      message: expect.stringMatching(/3/),
    });
    expect(failed.error?.detail).toMatchObject({ stdout: 'working\n', stderr: 'broken\n' });

    const slow = await run(client, { language: 'bash', script: 'sleep 30', timeout_seconds: 1 });
    expect(slow.error?.code).toBe('limit_exceeded');

    const bad = await run(client, {
      language: 'bash',
      script: 'echo "{not json" > out/bad.timeline.json',
    });
    expect(bad.result?.outputs[0]).toMatchObject({
      name: 'bad.timeline.json',
      error: { code: 'bad_request' },
    });

    // The worker is fine afterwards.
    const after = await run(client, { language: 'bash', script: 'echo ok' });
    expect(after.result?.stdout).toBe('ok\n');
  }, 60_000);

  it('hands back text files with links, and keeps the rest when one file fails', async () => {
    const client = await connect('alice');
    const done = await run(client, {
      language: 'bash',
      script: [
        'printf "WEBVTT\\n\\n00:00.000 --> 00:01.000\\nHi\\n" > out/captions.vtt',
        'echo \'{"a":1}\' > out/notes.json',
        'echo "not a movie" > out/broken.mov',
        'echo still here',
      ].join('\n'),
    });
    expect(done.error).toBeUndefined();
    expect(done.result?.stdout).toBe('still here\n');
    const byName = Object.fromEntries((done.result?.outputs ?? []).map((o) => [o.name, o]));
    expect(byName['captions.vtt']).toMatchObject({ type: 'file', mime_type: 'text/vtt' });
    expect(byName['notes.json']).toMatchObject({ type: 'file', mime_type: 'application/json' });
    const vtt = await download(byName['captions.vtt']?.url);
    expect(vtt.status).toBe(200);
    expect(await vtt.text()).toContain('WEBVTT');
    // The file that could not be imported is marked failed, with its cause and its bytes.
    expect(byName['broken.mov']).toMatchObject({
      type: 'failed',
      error: { code: expect.any(String) },
    });
    expect(await (await download(byName['broken.mov']?.url)).text()).toBe('not a movie\n');
    // A link that was tampered with is refused.
    const forged = new URL(byName['notes.json']?.url ?? '');
    forged.searchParams.set('sig', 'x');
    expect((await download(forged.href)).status).toBe(403);
  }, 60_000);

  it('keeps every out/ file when two owners run scripts at once', async () => {
    const [alice, bob] = [await connect('alice'), await connect('bob')];
    const script = (who: string) => ({
      language: 'bash',
      script: `for i in 1 2 3; do echo ${who}-$i > out/${who}-$i.txt; done`,
    });
    const [a, b] = await Promise.all([run(alice, script('a')), run(bob, script('b'))]);
    for (const [who, r] of [['a', a] as const, ['b', b] as const]) {
      expect(r.error).toBeUndefined();
      expect(r.result?.outputs.map((o) => o.type)).toEqual(['file', 'file', 'file']);
      const text = await (await download(r.result?.outputs[2]?.url)).text();
      expect(text).toBe(`${who}-3\n`);
    }
  }, 60_000);

  it('says which call it waits on, and does not count that queue time against its limit', async () => {
    const client = await connect('alice');
    // Both of the server's job slots are busy with other work.
    const forever = ({ signal }: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('x'))),
      );
    const blockers = [];
    for (const tool of ['export.video', 'qa.check']) {
      const b = await runtime.jobs.store.create({ owner: 'bob', tool });
      runtime.jobs.start(b, forever);
      blockers.push(b);
    }
    const port = (http.address() as AddressInfo).port;
    const started = (await client.callTool({
      name: 'code.run',
      arguments: {
        timeout_seconds: 2,
        script: `import { cf } from 'cuttingfloor';
try { await cf.media.import({ source: { url: 'http://127.0.0.1:${port}/healthz' } }); } catch (e) { console.log(e.code); }
console.log('done');`,
      },
    })) as { structuredContent: { job_id: string } };
    const id = started.structuredContent.job_id;
    let seen = '';
    for (let i = 0; i < 100 && !/waiting on media\.import/.test(seen); i++) {
      await new Promise((r) => setTimeout(r, 50));
      const got = (await client.callTool({ name: 'job.get', arguments: { job_id: id } })) as {
        structuredContent: { status_message?: string };
      };
      seen = got.structuredContent.status_message ?? '';
    }
    expect(seen).toMatch(
      /^running; waiting on media\.import j_\w+: queued: next in line, waiting for a free job slot \(2 run at once on this server; running now: export\.video, qa\.check\)$/,
    );
    // Queued for longer than the script's whole limit, it still finishes.
    await new Promise((r) => setTimeout(r, 3000));
    for (const b of blockers) await runtime.jobs.cancel(b.id, 'bob');
    let done: Run;
    for (;;) {
      const got = (await client.callTool({ name: 'job.get', arguments: { job_id: id } })) as {
        structuredContent: Run;
      };
      done = got.structuredContent;
      if (done.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(done.error).toBeUndefined();
    expect(done.result?.stdout).toMatch(/done\n$/);
  }, 60_000);

  it.skipIf(!namespaces)(
    'has no network and cannot see the worker',
    async () => {
      const client = await connect('alice');
      const done = await run(client, {
        script: `
const port = ${(worker.address() as AddressInfo).port};
const tries = await Promise.all(['http://127.0.0.1:' + port + '/healthz', 'http://example.com/', 'http://1.1.1.1/'].map((u) =>
  fetch(u, { signal: AbortSignal.timeout(3000) }).then(() => 'reached', () => 'blocked')));
let killed = 'no';
try { process.kill(${process.pid}, 0); killed = 'visible'; } catch { killed = 'invisible'; }
console.log(JSON.stringify({ tries, killed }));`,
      });
      expect(done.error).toBeUndefined();
      expect(JSON.parse(done.result?.stdout ?? '{}')).toEqual({
        tries: ['blocked', 'blocked', 'blocked'],
        killed: 'invisible',
      });
    },
    60_000,
  );
});
