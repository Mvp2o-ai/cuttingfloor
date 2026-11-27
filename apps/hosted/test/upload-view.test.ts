/// <reference lib="dom" />
// The page functions below run in the browser.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, ElementHandle, Frame, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';

// Sending a file from inside the chat: the upload box (ui://cuttingfloor/upload) on a
// media.upload result and the library's Add (ui://cuttingfloor/library), in a real browser,
// each in a sandboxed frame under a small MCP Apps host, against the real upload url.

const exec = promisify(execFile);
const ffmpegFound = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);

/** A mono 48 kHz WAV of a steady tone: what Chromium's fake microphone plays, over and over. */
function toneWav(hz: number, seconds: number): Buffer {
  const rate = 48_000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(0.25 * 32_767 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + 2 * i);
  }
  return b;
}
// Docker has Chromium at /usr/bin/chromium; elsewhere CHROME_PATH names a Chrome to use.
const chrome = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const browserFound = await exec(chrome, ['--version']).then(
  () => true,
  () => false,
);
if (!browserFound && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but Chromium is missing');
}

type Rec = Record<string, unknown>;

/**
 * A host page: the view in a sandboxed frame, and the MCP Apps host side of the protocol. `allow`
 * is the frame's permissions policy: a host that grants the view the microphone it declares sets
 * `microphone` there, and serves the view from an origin of its own (here the host's: an opaque
 * origin is refused the microphone whatever the policy says); one that does not leaves it out.
 */
const hostPage = (
  allow = '',
  own = Boolean(allow),
) => `<!doctype html><html><body style="margin:0"><iframe id="v" sandbox="allow-scripts${own ? ' allow-same-origin' : ''}" allow="${allow}" style="width:100%;height:700px;border:0"></iframe>
<script>
window.__msgs = []; window.__calls = []; window.__links = [];
const f = document.getElementById('v');
window.addEventListener('message', async (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data;
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') return reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '0' }, hostCapabilities: window.CAPS, hostContext: { theme: 'dark', displayMode: 'inline' } });
  if (m.method === 'ui/notifications/initialized') {
    f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.RESULT }, '*');
    return;
  }
  if (m.method === 'tools/call') { window.__calls.push(m.params.name); return reply(await window.mcpCall(m.params.name, m.params.arguments)); }
  if (m.method === 'ui/message') { window.__msgs.push(m.params); return reply({}); }
  if (m.method === 'ui/open-link') { window.__links.push(m.params.url); return reply({}); }
  if (m.id !== undefined) reply({});
});
</script></body></html>`;
const HOST_PAGE = hostPage();

describe.skipIf(!browserFound)('sending a file from a view', () => {
  let runtime: Runtime;
  let http: Server;
  let client: Client;
  let browser: Browser;
  let file: string;
  /** A second Chromium whose microphone is the tone. */
  let mic: Browser;
  let base: string;
  const bytes = 300_000;

  async function call(name: string, args: Rec): Promise<Rec> {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Rec;
      content: unknown;
    };
    if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
    return r.structuredContent ?? {};
  }

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-upload-view-'));
    file = join(dir, 'Beach Day.mov');
    await writeFile(file, randomBytes(bytes));
    runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'local',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [],
      exportsDir: join(dir, 'exports'),
      maxJobs: 1,
      outputUrlTtlMs: 3_600_000,
      maxDownloadBytes: 1024 ** 3,
      allowPrivateUrls: true,
      inlineMaxBytes: 32 * 1024 ** 2,
      motionUrl: null,
    });
    await runtime.start({ sweep: false });
    http = createHttpServer({ runtime, credentials: new LocalCredentialStore({}, false) });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    (runtime.config as { publicUrl: string }).publicUrl = base;
    client = new Client({ name: 'upload-view', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      // Tests run as root inside docker build, where Chromium's sandbox has no user namespaces.
      args: ['--no-sandbox'],
    });
    const wav = join(dir, 'tone440.wav');
    await writeFile(wav, toneWav(440, 10));
    mic = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      // The fake microphone reads its file from inside Chromium's sandbox only without one.
      args: [
        '--no-sandbox',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await mic?.close();
    await browser?.close();
    await client?.close();
    http?.close();
  });

  async function open(
    uri: string,
    caps: Rec,
    result: Rec,
    host: { browser?: Browser; page?: string; width?: number } = {},
  ): Promise<{ page: Page; view: Frame }> {
    const html = ((await client.readResource({ uri })).contents[0] as { text: string }).text;
    const page = await (host.browser ?? browser).newPage();
    await page.setViewport({ width: host.width ?? 720, height: 700 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await page.exposeFunction('mcpCall', (name: string, args: Rec) =>
      client.callTool({ name, arguments: args }),
    );
    // A chat app's page is a secure context (https), which the microphone needs: this server's
    // own origin (loopback) is one; a blank page is not.
    if (host.browser) await page.goto(`${base}/healthz`);
    await page.setContent(host.page ?? HOST_PAGE);
    await page.evaluate(
      (c, r, h) => {
        Object.assign(window, { CAPS: c, RESULT: r });
        (document.getElementById('v') as HTMLIFrameElement).srcdoc = h;
      },
      caps,
      { content: [], structuredContent: result },
      html,
    );
    const view = await new Promise<Frame>((resolve) => {
      const find = () => page.frames().find((f) => f !== page.mainFrame());
      const f = find();
      if (f) resolve(f);
      else page.once('frameattached', () => resolve(find() as Frame));
    });
    expect(errors).toEqual([]);
    return { page, view };
  }

  /** Picks the file on one of a view's file inputs, as the person would. */
  async function choose(view: Frame, selector: string): Promise<void> {
    const input = (await view.$(selector)) as ElementHandle<HTMLInputElement> | null;
    if (!input) throw new Error(`no ${selector}`);
    await input.uploadFile(file);
  }

  const host = (page: Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __msgs: Rec[]; __calls: string[] };
      return { msgs: w.__msgs, calls: w.__calls };
    });
  const said = (msgs: Rec[]) =>
    msgs.map((m) => (m.content as Array<{ text: string }>)[0]?.text ?? '');
  const staged = async () =>
    (await call('media.list', {})).uploads as Array<{
      upload_id: string;
      name: string;
      bytes: number;
      complete: boolean;
    }>;

  it('sends the picked file to the upload in the result and says so in the chat', async () => {
    const upload = await call('media.upload', {});
    const { page, view } = await open(
      'ui://cuttingfloor/upload',
      { message: { text: {} } },
      upload,
    );
    await view.waitForSelector('#drop:not([hidden])');
    expect(await view.$eval('#limit', (el) => el.textContent)).toContain('Up to');
    // The first button asks for video and pictures, which is what brings up a phone's camera roll.
    expect(await view.$eval('#pick', (el) => (el as HTMLInputElement).accept)).toBe(
      'video/*,image/*',
    );
    expect(await view.$eval('#other', (el) => (el as HTMLInputElement).accept)).toBe('');
    await choose(view, '#pick');
    await view.waitForFunction(() => document.querySelector('#state')?.textContent === 'Sent', {
      timeout: 30_000,
    });
    const mine = (await staged()).find((u) => u.upload_id === upload.upload_id);
    expect(mine).toMatchObject({ name: 'Beach Day.mov', bytes, complete: true });
    expect(said((await host(page)).msgs)).toEqual([
      `I sent “Beach Day.mov” to cuttingfloor (upload_id ${upload.upload_id}). Import it.`,
    ]);
    expect(await view.$eval('#note', (el) => el.textContent)).toContain('The chat carries on');
    await page.close();

    // Shown again, the same result finds the file already in and takes no second one.
    const again = await open('ui://cuttingfloor/upload', {}, upload);
    await again.view.waitForFunction(
      () => document.querySelector('#state')?.textContent === 'Sent',
    );
    expect(await again.view.$eval('#drop', (el) => (el as HTMLElement).hidden)).toBe(true);
    await again.page.close();
  }, 60_000);

  it('says to tell the chat where the host takes no message from a view', async () => {
    const upload = await call('media.upload', {});
    const { page, view } = await open('ui://cuttingfloor/upload', {}, upload);
    await view.waitForSelector('#drop:not([hidden])');
    await choose(view, '#other');
    await view.waitForFunction(() => document.querySelector('#state')?.textContent === 'Sent', {
      timeout: 30_000,
    });
    expect(await view.$eval('#note', (el) => el.textContent)).toBe(
      'It is in. Tell the chat you sent it.',
    );
    expect((await host(page)).msgs).toEqual([]);
    await page.close();
  }, 60_000);

  it('adds a file from the library: asks for an upload, sends it, lists it', async () => {
    const before = (await staged()).map((u) => u.upload_id);
    const { page, view } = await open(
      'ui://cuttingfloor/library',
      { serverTools: {}, message: { text: {} } },
      await call('media.list', {}),
    );
    await view.waitForSelector('#add:not([hidden])');
    await choose(view, '#add input');
    await view.waitForFunction(() => document.querySelector('#upSay')?.textContent === 'Sent', {
      timeout: 30_000,
    });
    const added = (await staged()).filter((u) => !before.includes(u.upload_id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: 'Beach Day.mov', bytes, complete: true });
    const seen = await host(page);
    expect(seen.calls).toEqual(['media.upload', 'media.list']);
    await view.waitForFunction(
      (id) => !!document.querySelector(`.row[data-key="${id}"][aria-selected="true"]`),
      {},
      added[0]?.upload_id,
    );
    await page.waitForFunction(
      () => (window as unknown as { __msgs: unknown[] }).__msgs.length === 1,
    );
    expect(said((await host(page)).msgs)).toEqual([
      `I sent “Beach Day.mov” to cuttingfloor (upload_id ${added[0]?.upload_id}). Import it.`,
    ]);
    await page.close();
  }, 60_000);

  /** Records `seconds` in a view or page showing the recorder, listens back, and sends it. */
  async function recordAndSend(view: Frame, seconds: number): Promise<void> {
    await view.click('#record');
    await view.waitForSelector('.cfr[data-state="recording"]', { timeout: 10_000 });
    // The level meter moves: the tone is reaching the recorder.
    await view.waitForFunction(
      () =>
        Number.parseFloat((document.querySelector('.cfr-level i') as HTMLElement)?.style.width) >
        20,
      { timeout: 5_000 },
    );
    await new Promise((r) => setTimeout(r, seconds * 1000));
    await view.click('.cfr button.stop');
    await view.waitForSelector('.cfr[data-state="review"]');
    // Listen back decodes it in the browser: the length it shows is the recording's.
    await view.waitForFunction(
      () => !(document.querySelector('.cfr-row button') as HTMLButtonElement)?.disabled,
    );
    await view.click('.cfr button.go');
  }

  /** Imports a staged upload and measures it: kind, length, and the pitch of its middle second. */
  async function measure(uploadId: string) {
    const started = await call('media.import', { source: { upload_id: uploadId } });
    for (let i = 0; i < 200; i++) {
      const job = await call('job.get', { job_id: started.job_id as string });
      if (job.status === 'failed') throw new Error(JSON.stringify(job.error));
      if (job.status !== 'working') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const media = await call('media.get', { media_id: started.media_id as string });
    const res = await fetch(media.url as string);
    const dir = await mkdtemp(join(tmpdir(), 'cf-recorded-'));
    const got = join(dir, 'got');
    await writeFile(got, Buffer.from(await res.arrayBuffer()));
    const { stdout } = await exec(
      'ffmpeg',
      ['-v', 'error', '-i', got, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );
    const pcm = new Int16Array(stdout.buffer, stdout.byteOffset, stdout.length >> 1);
    const mid = pcm.subarray(
      Math.floor(pcm.length / 2) - 24_000,
      Math.floor(pcm.length / 2) + 24_000,
    );
    let crossings = 0;
    for (let i = 1; i < mid.length; i++)
      if ((mid[i - 1] ?? 0) < 0 !== (mid[i] ?? 0) < 0) crossings++;
    return { media, hz: crossings / 2 / (mid.length / 48_000) };
  }

  it('records the microphone where the host grants it, and stages it as a picked file is', async () => {
    const upload = await call('media.upload', {});
    const { page, view } = await open(
      'ui://cuttingfloor/upload',
      { message: { text: {} } },
      upload,
      { browser: mic, page: hostPage('microphone'), width: 360 },
    );
    await view.waitForSelector('#drop:not([hidden])');
    // Record sits beside Choose a file; choosing a file is untouched.
    expect(await view.$eval('#pick', (el) => (el as HTMLInputElement).accept)).toBe(
      'video/*,image/*',
    );
    await recordAndSend(view, 3);
    await view.waitForFunction(() => document.querySelector('#state')?.textContent === 'Sent', {
      timeout: 30_000,
    });
    const mine = (await staged()).find((u) => u.upload_id === upload.upload_id);
    expect(mine?.complete).toBe(true);
    expect(mine?.name).toMatch(/^recording-\d{4}-\d\d-\d\d-\d{4}\.webm$/);
    expect(said((await host(page)).msgs)).toEqual([
      `I sent “${mine?.name}” to cuttingfloor (upload_id ${upload.upload_id}). Import it.`,
    ]);
    await page.close();
    if (!ffmpegFound) return;
    // What arrives is the tone the microphone heard, for as long as it was recorded.
    const { media, hz } = await measure(upload.upload_id as string);
    expect(media).toMatchObject({ kind: 'audio', status: 'ready' });
    expect(media.duration_seconds as number).toBeGreaterThan(2.5);
    expect(media.duration_seconds as number).toBeLessThan(4.5);
    expect(hz).toBeGreaterThan(430);
    expect(hz).toBeLessThan(450);
  }, 90_000);

  it('where the host keeps the microphone from the box, opens the upload page, which records to the same upload', async () => {
    const upload = await call('media.upload', {});
    // No `allow` on the frame: the host did not grant the microphone.
    const { page, view } = await open(
      'ui://cuttingfloor/upload',
      { message: { text: {} } },
      upload,
      { browser: mic, width: 360 },
    );
    await view.waitForSelector('#drop:not([hidden])');
    await view.click('#record');
    await view.waitForSelector('.cfr[data-state="refused"]');
    expect(await view.$eval('.cfr-say', (el) => el.textContent)).toContain('The upload page can');
    await view.click('.cfr button.go');
    await page.waitForFunction(
      () => (window as unknown as { __links: string[] }).__links.length === 1,
    );
    const [link] = (await host(page).then(() =>
      page.evaluate(() => (window as unknown as { __links: string[] }).__links),
    )) as string[];
    expect(link).toBe(`${upload.url}#record`);
    await page.close();
    // A host that allows the microphone but frames the view without an origin of its own: the
    // browser refuses it all the same, and the box says so the same way.
    const opaque = await open('ui://cuttingfloor/upload', {}, upload, {
      browser: mic,
      page: hostPage('microphone', false),
      width: 360,
    });
    await opaque.view.waitForSelector('#drop:not([hidden])');
    await opaque.view.click('#record');
    await opaque.view.waitForSelector('.cfr[data-state="refused"]');
    expect(await opaque.view.$eval('.cfr button.go', (el) => el.textContent)).toBe(
      'Record on the upload page',
    );
    await opaque.page.close();

    // The link, in the browser: the same upload, and the microphone works there.
    const tab = await mic.newPage();
    await tab.setViewport({ width: 390, height: 800 });
    await tab.goto(link as string);
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe('record');
    await recordAndSend(tab.mainFrame(), 3);
    await tab.waitForFunction(() => document.getElementById('status')?.className === 'done', {
      timeout: 30_000,
    });
    const mine = (await staged()).find((u) => u.upload_id === upload.upload_id);
    expect(mine?.complete).toBe(true);
    expect(mine?.name).toMatch(/^recording-.*\.webm$/);
    await tab.close();
    if (!ffmpegFound) return;
    const { media, hz } = await measure(upload.upload_id as string);
    expect(media).toMatchObject({ kind: 'audio', status: 'ready' });
    expect(hz).toBeGreaterThan(430);
    expect(hz).toBeLessThan(450);
  }, 90_000);

  it('on the upload page, a refused microphone says how to allow it and sends nothing', async () => {
    const upload = await call('media.upload', {});
    const origin = new URL(upload.url as string).origin;
    const context = await mic.createBrowserContext();
    await context.setPermission(origin, { permission: { name: 'microphone' }, state: 'denied' });
    const tab = await context.newPage();
    await tab.goto(upload.url as string);
    await tab.click('#record');
    await tab.waitForSelector('.cfr[data-state="refused"]');
    expect(await tab.$eval('.cfr-say', (el) => el.textContent)).toContain('Allow it for this page');
    expect(await tab.$eval('.cfr button.go', (el) => el.textContent)).toBe('Try again');
    // Back: the drop and Record, as they were; nothing was sent.
    await tab.click('.cfr button.quiet');
    expect(await tab.$eval('#drop', (el) => (el as HTMLElement).hidden)).toBe(false);
    const mine = (await staged()).find((u) => u.upload_id === upload.upload_id);
    expect(mine?.complete).toBe(false);
    await context.close();
  }, 60_000);
});
