/// <reference lib="dom" />
// The page functions below run in the browser.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, Frame, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';

// The editor view (ui://cuttingfloor/editor) on a real export, in a real browser, under a small
// MCP Apps host: the host relays the view's tools/call to this server over MCP and records what
// the view tells the agent.

const exec = promisify(execFile);
const engines = await Promise.all([exec('melt', ['--version']), exec('ffmpeg', ['-version'])]).then(
  () => true,
  () => false,
);
// Docker has Chromium at /usr/bin/chromium; elsewhere CHROME_PATH names a Chrome to use.
const chrome = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const browserFound = await exec(chrome, ['--version']).then(
  () => true,
  () => false,
);
if ((!engines || !browserFound) && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but ffmpeg/melt or Chromium is missing');
}

type Rec = Record<string, unknown>;

/** A host page: the view in a sandboxed frame, and the MCP Apps host side of the protocol. */
const HOST_PAGE = `<!doctype html><html><body style="margin:0"><iframe id="v" sandbox="allow-scripts" style="width:1280px;height:1100px;border:0"></iframe>
<script>
window.__ctx = []; window.__msgs = []; window.__calls = [];
const f = document.getElementById('v');
window.addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data;
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') return reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '0' }, hostCapabilities: window.CAPS, hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline'] } });
  if (m.method === 'ui/notifications/initialized') {
    f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: window.ARGS } }, '*');
    f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.RESULT }, '*');
    return;
  }
  if (m.method === 'tools/call') { window.__calls.push(m.params.name); return reply(await window.mcpCall(m.params.name, m.params.arguments)); }
  if (m.method === 'ui/update-model-context') { window.__ctx.push(m.params); return reply({}); }
  if (m.method === 'ui/message') { window.__msgs.push(m.params); return reply({}); }
  if (m.id !== undefined) reply({});
});
</script></body></html>`;

describe.skipIf(!engines || !browserFound)('editor view', () => {
  let runtime: Runtime;
  let http: Server;
  let client: Client;
  let browser: Browser;
  let editorHtml: string;
  let timelineId: string;
  let tracks: Array<{ id: string; name: string; clips: Array<{ id: string; start: number }> }>;
  let exportResult: Rec;

  async function call(name: string, args: Rec): Promise<Rec> {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Rec;
      content: unknown;
    };
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
    return r.structuredContent ?? {};
  }
  async function waitJob(jobId: string): Promise<Rec> {
    for (const until = Date.now() + 240_000; Date.now() < until; ) {
      const job = await call('job.get', { job_id: jobId });
      if (job.status !== 'working') return job;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`job ${jobId} still working`);
  }

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-editor-'));
    const mediaDir = join(dir, 'media');
    await mkdir(mediaDir, { recursive: true });
    await exec('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=30:d=12',
      '-f',
      'lavfi',
      '-i',
      'sine=f=330:d=12',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      join(mediaDir, 'av.mp4'),
    ]);
    runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'local',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [mediaDir],
      exportsDir: join(dir, 'exports'),
      maxJobs: 2,
      outputUrlTtlMs: 3_600_000,
      maxDownloadBytes: 1024 ** 3,
      allowPrivateUrls: true,
      inlineMaxBytes: 32 * 1024 ** 2,
      motionUrl: null,
    });
    await runtime.start({ sweep: false });
    http = createHttpServer({ runtime, credentials: new LocalCredentialStore({}, false) });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    (runtime.config as { publicUrl: string }).publicUrl = base;
    client = new Client({ name: 'editor-view', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));

    const imported = await call('media.import', { source: { path: join(mediaDir, 'av.mp4') } });
    if (imported.job_id) await waitJob(String(imported.job_id));
    const created = await call('timeline.create', {
      name: 'Editor view test',
      sequence: { width: 640, height: 360, fps: { num: 30, den: 1 } },
    });
    let id = String(created.timeline_id);
    const v1 = (created.tracks as Array<{ id: string; kind: string }>).find(
      (t) => t.kind === 'video',
    )?.id;
    const edit = async (tool: string, args: Rec) => {
      const r = await call(tool, { timeline_id: id, preview: 'none', ...args });
      id = String(r.timeline_id);
      return r;
    };
    await edit('clip.add', {
      track_id: v1,
      media_id: imported.media_id,
      source: { in: 0, out: 90 },
    });
    const second = await edit('clip.add', {
      track_id: v1,
      media_id: imported.media_id,
      source: { in: 150, out: 300 },
    });
    // The last edit, which the view names and outlines.
    await edit('clip.trim', { clip_id: second.clip_id, edge: 'end', to_frame: 210 });
    timelineId = id;
    tracks = (await call('timeline.get', { timeline_id: id })).tracks as typeof tracks;

    // A client without Tasks gets a job handle: the view follows it with job.get.
    const started = await call('export.video', { timeline_id: id, preset: 'review_h264' });
    exportResult = started;
    expect((await waitJob(String(started.job_id))).status).toBe('completed');

    editorHtml = (
      (await client.readResource({ uri: 'ui://cuttingfloor/editor' })).contents[0] as {
        text: string;
      }
    ).text;
    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      // Tests run as root inside docker build, where Chromium's sandbox has no user namespaces.
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });
  }, 400_000);

  afterAll(async () => {
    await browser?.close();
    await client?.close();
    http?.close();
  });

  async function open(caps: Rec): Promise<{ page: Page; view: Frame }> {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1100 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await page.exposeFunction('mcpCall', (name: string, args: Rec) =>
      client.callTool({ name, arguments: args }),
    );
    await page.setContent(HOST_PAGE);
    await page.evaluate(
      (c, args, result, html) => {
        Object.assign(window, { CAPS: c, ARGS: args, RESULT: result });
        (document.getElementById('v') as HTMLIFrameElement).srcdoc = html;
      },
      caps,
      { timeline_id: timelineId, preset: 'review_h264' },
      { content: [], structuredContent: exportResult },
      editorHtml,
    );
    const view = await new Promise<Frame>((resolve) => {
      const find = () => page.frames().find((f) => f !== page.mainFrame());
      const f = find();
      if (f) resolve(f);
      else page.once('frameattached', () => resolve(find() as Frame));
    });
    // The export plays once the view has followed the job to its file.
    await view.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && v.readyState >= 1;
      },
      { timeout: 60_000 },
    );
    expect(errors).toEqual([]);
    return { page, view };
  }

  const host = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __ctx: Rec[]; __msgs: Rec[]; __calls: string[] };
      return { ctx: w.__ctx, msgs: w.__msgs, calls: w.__calls };
    });

  it('plays the export over its timeline and seeks the file to the playhead', async () => {
    const { page, view } = await open({
      serverTools: {},
      message: { text: {} },
      updateModelContext: {},
    });
    await view.waitForSelector('#lanes .clip');
    const clips = tracks.flatMap((t) => t.clips);
    expect(await view.$$eval('#lanes .clip', (els) => els.length)).toBe(clips.length);
    expect(await view.$eval('#tlName', (el) => el.textContent)).toBe('Editor view test');
    // It followed the job, then read the timeline, its last edit and what that changed.
    expect((await host(page)).calls).toEqual(
      expect.arrayContaining(['job.get', 'timeline.get', 'timeline.history', 'timeline.diff']),
    );
    await view.waitForFunction(() => !document.getElementById('lastEdit')?.hidden);
    expect(await view.$eval('#lastEdit', (el) => el.textContent)).toContain('clip.trim');

    // The next cut is where the second clip starts: the file seeks into that frame.
    await view.click('#nextCut');
    const cut = tracks.flatMap((t) => t.clips.map((c) => c.start)).filter((s) => s > 0)[0] ?? 0;
    await view.waitForFunction(
      (want) => {
        const v = document.querySelector('video');
        return v && !v.seeking && Math.abs(v.currentTime - want) < 0.02;
      },
      { timeout: 10_000 },
      (cut + 0.5) / 30,
    );
    expect(await view.$eval('#tc', (el) => el.textContent)).toContain('0:03.00');
    await page.close();
  });

  it('tells the agent where the person stopped, not while they scrub, and sends their note', async () => {
    const { page, view } = await open({
      serverTools: {},
      message: { text: {} },
      updateModelContext: {},
    });
    await view.waitForSelector('#lanes .clip');
    // The view settles once on opening.
    await page.waitForFunction(() => (window as unknown as { __ctx: Rec[] }).__ctx.length === 1);
    const ruler = await view.$('#ruler');
    const box = await ruler?.boundingBox();
    if (!box) throw new Error('no ruler');
    await page.mouse.move(box.x + 300, box.y + 10);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(box.x + 300 + i * 40, box.y + 10);
      await new Promise((r) => setTimeout(r, 60));
    }
    await page.mouse.up();
    expect((await host(page)).ctx).toHaveLength(1);
    await page.waitForFunction(() => (window as unknown as { __ctx: Rec[] }).__ctx.length === 2, {
      timeout: 5000,
    });
    const settled = (await host(page)).ctx[1] as { structuredContent: Rec; content: Rec[] };
    const frame = (settled.structuredContent.playhead as { frame: number }).frame;
    expect(settled.structuredContent.timeline_id).toBe(timelineId);
    expect(frame).toBeGreaterThan(0);
    expect(String(settled.content[0]?.text)).toContain(`frame ${frame}`);

    // Selecting a clip is a settled moment too.
    const first = tracks.flatMap((t) => t.clips)[0];
    await view.click(`#lanes .clip[data-id="${first?.id}"]`);
    await page.waitForFunction(() => (window as unknown as { __ctx: Rec[] }).__ctx.length === 3, {
      timeout: 5000,
    });
    const selected = (await host(page)).ctx[2] as { structuredContent: Rec };
    expect(selected.structuredContent.selected_clip).toMatchObject({ id: first?.id });

    // A note is the one thing that starts a turn.
    expect((await host(page)).msgs).toEqual([]);
    await view.click('#sendAgent');
    await view.type('#note', 'This cut is a beat late');
    await view.click('#sendNote');
    await page.waitForFunction(() => (window as unknown as { __msgs: Rec[] }).__msgs.length === 1);
    const [msg] = (await host(page)).msgs as Array<{ role: string; content: Rec[] }>;
    expect(msg?.role).toBe('user');
    expect(String(msg?.content[0]?.text)).toMatch(/^This cut is a beat late\n\n\(.*timeline /);
    expect(String(msg?.content[0]?.text)).toContain(`clip ${first?.id}`);
    await page.close();
  });

  it('resizes the picture from the divider and hides the editor down to the player', async () => {
    const { page, view } = await open({ serverTools: {} });
    await view.waitForSelector('#lanes .clip');
    const height = (sel: string) =>
      view.$eval(sel, (el) => Math.round(el.getBoundingClientRect().height));
    const before = await height('#stage');
    const box = await (await view.$('#split'))?.boundingBox();
    if (!box) throw new Error('no divider');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 6 });
    await page.mouse.up();
    expect(await height('#stage')).toBe(before + 120);

    // Hidden, only the picture, its controls and a seek bar are left; the seek bar seeks.
    await view.click('#miniBtn');
    expect(await height('#scroller')).toBe(0);
    expect(await height('.inspector')).toBe(0);
    const bar = await (await view.$('#mscrubBar'))?.boundingBox();
    if (!bar) throw new Error('no seek bar');
    await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height / 2);
    expect(await view.$eval('#tc', (el) => el.textContent)).toContain('0:03.');
    await view.click('#miniBtn');
    expect(await height('#scroller')).toBeGreaterThan(0);
    expect(await height('#mscrub')).toBe(0);
    await page.close();
  });

  it('lists what is on the floor under its own name and previews a pick', async () => {
    const listed = await call('media.list', {});
    const libraryHtml = (
      (await client.readResource({ uri: 'ui://cuttingfloor/library' })).contents[0] as {
        text: string;
      }
    ).text;
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1100 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await page.exposeFunction('mcpCall', (name: string, args: Rec) =>
      client.callTool({ name, arguments: args }),
    );
    await page.setContent(HOST_PAGE);
    await page.evaluate(
      (result, html) => {
        Object.assign(window, {
          CAPS: { serverTools: {}, message: { text: {} } },
          ARGS: {},
          RESULT: result,
        });
        (document.getElementById('v') as HTMLIFrameElement).srcdoc = html;
      },
      { content: [], structuredContent: listed },
      libraryHtml,
    );
    await new Promise((r) => setTimeout(r, 200));
    const view = page.frames().find((f) => f !== page.mainFrame()) as Frame;
    await view.waitForSelector('#list .row');
    expect(await view.$eval('.wm', (el) => el.textContent)).toBe('cuttingfloorai');
    const media = listed.media as Array<{ media_id: string; kind: string }>;
    expect(await view.$$eval('#list .row', (els) => els.length)).toBe(media.length);

    // A pick plays from media.get's signed file.
    const video = media.find((m) => m.kind === 'video');
    await view.click(`#list .row[data-key="${video?.media_id}"]`);
    await view.waitForFunction(
      () => {
        const v = document.querySelector('#preview video') as HTMLVideoElement | null;
        return v && v.readyState >= 1;
      },
      { timeout: 20_000 },
    );
    expect((await host(page)).calls).toContain('media.get');

    // Use in chat hands the pick to the agent as the person's message.
    await view.click('[data-act="chat"]');
    await page.waitForFunction(() => (window as unknown as { __msgs: Rec[] }).__msgs.length === 1);
    const [msg] = (await host(page)).msgs as Array<{ content: Rec[] }>;
    expect(String(msg?.content[0]?.text)).toContain(`media_id ${video?.media_id}`);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('still plays the file in a host that will not relay tool calls', async () => {
    // Without serverTools the view can't follow a job, so this host hands it the finished file.
    const done = await call('job.get', { job_id: String(exportResult.job_id) });
    const saved = exportResult;
    exportResult = done.result as Rec;
    try {
      const { page, view } = await open({});
      await view.waitForFunction(() => !document.getElementById('tlNote')?.hidden);
      expect(await view.$eval('#tlNote', (el) => el.textContent)).toContain(
        'does not let the view',
      );
      expect((await host(page)).calls).toEqual([]);
      // No agent features the host doesn't offer; a ruler over the file still scrubs it.
      expect(await view.$eval('#ctx', (el) => (el as HTMLElement).hidden)).toBe(true);
      await view.waitForSelector('#ruler .tick');
      await page.close();
    } finally {
      exportResult = saved;
    }
  });
});
