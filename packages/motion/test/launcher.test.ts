import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Sandbox,
  type SandboxEngine,
  sandboxSlots,
  startMotionLauncher,
} from '../src/index.ts';

// The launcher in front of the sandboxes: a fresh one per render, as many at once as it is
// allowed, the rest waiting with their place, and one render's failure never another's. A fake
// engine starts each "sandbox" as a small HTTP server that answers like a motion worker.

type Behaviour = 'ok' | 'crash' | 'refuse';

class FakeEngine implements SandboxEngine {
  started = 0;
  live = new Set<Server>();
  /** Renders in progress at once, at most. */
  peak = 0;
  #rendering = 0;
  behaviours: Behaviour[] = [];
  /** How long each fake render takes. */
  renderMs = 150;

  async capacity() {
    return { cpus: 8, memoryBytes: 32 * 1024 ** 3 };
  }

  async sweep() {}

  async start(): Promise<Sandbox> {
    const behaviour = this.behaviours[this.started] ?? 'ok';
    this.started += 1;
    const id = randomBytes(12).toString('hex');
    const server = createServer((req, res) => {
      if (req.url === '/healthz') return void res.end('{"ok":true}');
      if (req.url === '/render') {
        if (behaviour === 'refuse') {
          res.writeHead(400, { 'content-type': 'application/json' });
          return void res.end(
            JSON.stringify({ error: { code: 'bad_request', message: 'bad page' } }),
          );
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ progress: 0.5, message: 'rendering' })}\n`);
        this.#rendering += 1;
        this.peak = Math.max(this.peak, this.#rendering);
        setTimeout(() => {
          this.#rendering -= 1;
          if (behaviour === 'crash') return void res.destroy();
          res.end(`${JSON.stringify({ done: { id, type: 'video/mp4', bytes: 4 } })}\n`);
        }, this.renderMs);
        return;
      }
      if (req.url === `/jobs/${id}`) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '4' });
        return void res.end('mp4!');
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    this.live.add(server);
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      stop: async () => {
        this.live.delete(server);
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }
}

const opened: Server[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

async function launcher(engine: FakeEngine, max: number) {
  const server = await startMotionLauncher({
    port: 0,
    host: '127.0.0.1',
    engine,
    share: { cpus: 1.5, memoryBytes: 3 * 1024 ** 3 },
    max,
    heartbeatMs: 50,
  });
  opened.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Sends one render and reads every line back, then fetches the file when it is done. */
async function render(base: string) {
  const res = await fetch(`${base}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'motion', html: '<p>hi</p>' }),
  });
  const lines = (await res.text())
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, any>);
  const done = lines.find((l) => 'done' in l)?.done as { id: string } | undefined;
  const file = done ? await (await fetch(`${base}/jobs/${done.id}`)).text() : undefined;
  return { lines, done, file, error: lines.find((l) => 'error' in l)?.error };
}

describe('motion launcher', () => {
  it('sizes itself from the machine: cores and memory, each over what a render takes', () => {
    const share = { cpus: 1.5, memoryBytes: 3 * 1024 ** 3 };
    expect(sandboxSlots({ cpus: 8, memoryBytes: 32 * 1024 ** 3 }, share)).toBe(5);
    expect(sandboxSlots({ cpus: 96, memoryBytes: 256 * 1024 ** 3 }, share)).toBe(51);
    // Memory short of cores: memory decides.
    expect(sandboxSlots({ cpus: 32, memoryBytes: 16 * 1024 ** 3 }, share)).toBe(3);
    expect(sandboxSlots({ cpus: 1, memoryBytes: 1024 ** 3 }, share)).toBe(1);
  });

  it('renders in a fresh sandbox, passes the file through, and removes the sandbox after', async () => {
    const engine = new FakeEngine();
    const base = await launcher(engine, 2);
    const first = await render(base);
    const second = await render(base);
    expect(first.file).toBe('mp4!');
    expect(second.file).toBe('mp4!');
    expect(first.lines.some((l) => l.message === 'rendering')).toBe(true);
    expect(engine.started).toBe(2);
    expect(engine.live.size).toBe(0);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ running: 0, max: 2 });
  });

  it('runs up to its limit at once; the rest wait, hearing their place', async () => {
    const engine = new FakeEngine();
    const base = await launcher(engine, 2);
    const all = await Promise.all([render(base), render(base), render(base), render(base)]);
    expect(all.every((r) => r.file === 'mp4!')).toBe(true);
    expect(engine.peak).toBe(2);
    const waited = all.flatMap((r) => r.lines).filter((l) => /^queued: /.test(l.message ?? ''));
    expect(waited.length).toBeGreaterThan(0);
    expect(String(waited[0]?.message)).toMatch(/this server runs 2 at once/);
    expect(engine.live.size).toBe(0);
  });

  it('frees a render’s slot when it finishes, before its file is fetched', async () => {
    const engine = new FakeEngine();
    const base = await launcher(engine, 1);
    const res = await fetch(`${base}/render`, { method: 'POST', body: '{}' });
    const done = (await res.text()).includes('"done"');
    expect(done).toBe(true);
    // Not fetched: the next render still starts at once, and the first file is still there.
    const next = await render(base);
    expect(next.lines.some((l) => /^queued/.test(l.message ?? ''))).toBe(false);
    expect(next.file).toBe('mp4!');
    expect(engine.live.size).toBe(1);
  });

  it('fails only the render whose sandbox crashed, and frees its slot', async () => {
    const engine = new FakeEngine();
    engine.behaviours = ['crash', 'ok', 'ok'];
    const base = await launcher(engine, 1);
    const [crashed, a, b] = await Promise.all([render(base), render(base), render(base)]);
    expect(crashed.error).toMatchObject({ code: 'server_busy' });
    expect(String(crashed.error?.hint)).toMatch(/Only this render/);
    expect(a.file).toBe('mp4!');
    expect(b.file).toBe('mp4!');
    expect(engine.live.size).toBe(0);
  });

  it('passes a sandbox’s refusal on as the render’s error', async () => {
    const engine = new FakeEngine();
    engine.behaviours = ['refuse'];
    const base = await launcher(engine, 1);
    const refused = await render(base);
    expect(refused.error).toEqual({ code: 'bad_request', message: 'bad page' });
    expect(engine.live.size).toBe(0);
    expect((await render(base)).file).toBe('mp4!');
  });
});
