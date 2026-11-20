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

/** A host page: the view in a sandboxed frame, and the MCP Apps host side of the protocol. */
const HOST_PAGE = `<!doctype html><html><body style="margin:0"><iframe id="v" sandbox="allow-scripts" style="width:720px;height:700px;border:0"></iframe>
<script>
window.__msgs = []; window.__calls = [];
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
  if (m.id !== undefined) reply({});
});
</script></body></html>`;

describe.skipIf(!browserFound)('sending a file from a view', () => {
  let runtime: Runtime;
  let http: Server;
  let client: Client;
  let browser: Browser;
  let file: string;
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
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
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
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await client?.close();
    http?.close();
  });

  async function open(uri: string, caps: Rec, result: Rec): Promise<{ page: Page; view: Frame }> {
    const html = ((await client.readResource({ uri })).contents[0] as { text: string }).text;
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 700 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await page.exposeFunction('mcpCall', (name: string, args: Rec) =>
      client.callTool({ name, arguments: args }),
    );
    await page.setContent(HOST_PAGE);
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
});
