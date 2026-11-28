/// <reference lib="dom" />
// The page functions below run in the browser.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { RECORD_LIMITS, ScoreRecordResult, ScoreRecordTake } from '@cuttingfloor/schema';
import { Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, CDPSession, Frame, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.ts';
import { readMono, stereoWav, stubRenderer } from './record-stub.ts';

// The play-along view (ui://cuttingfloor/record) in a real browser, in a sandboxed frame under a
// small MCP Apps host, against the real server with a stand-in score engine. Taps are dispatched
// at known times on the audio clock and the take's positions are checked against them; a
// microphone take is recorded from a sound played at known times; the tap-along measure recovers
// a delay put in on purpose. RECORD_SHOTS=<dir> saves a screenshot of each state.

const exec = promisify(execFile);
const ffmpegFound = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const chrome = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const browserFound = await exec(chrome, ['--version']).then(
  () => true,
  () => false,
);
if (!browserFound && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error('CUTTINGFLOOR_REQUIRE_ENGINES is set but Chromium is missing');
}
const shots = process.env.RECORD_SHOTS;

type Rec = Record<string, unknown>;

/** The host: the view in a sandboxed frame with the microphone granted, and the host protocol. */
const HOST_PAGE = (
  height: number,
) => `<!doctype html><html><body style="margin:0;background:#111"><iframe id="v" sandbox="allow-scripts allow-same-origin" allow="microphone" style="width:100%;height:${height}px;border:0"></iframe>
<script>
window.__msgs = [];
const f = document.getElementById('v');
window.addEventListener('message', (e) => {
  if (e.source !== f.contentWindow) return;
  const m = e.data;
  const reply = (result) => f.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') return reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '0' }, hostCapabilities: { message: { text: {} } }, hostContext: { theme: 'dark', displayMode: 'inline' } });
  if (m.method === 'ui/notifications/initialized') return f.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: window.RESULT }, '*');
  if (m.method === 'ui/message') { window.__msgs.push(m.params); return reply({}); }
  if (m.id !== undefined) reply({});
});
</script></body></html>`;

describe.skipIf(!browserFound)('the play-along view', () => {
  let runtime: Runtime;
  let http: Server;
  let client: Client;
  let browser: Browser;
  let mic: Browser;
  let base: string;

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
    const dir = await mkdtemp(join(tmpdir(), 'cf-record-view-'));
    runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'local',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [],
      exportsDir: join(dir, 'exports'),
      maxJobs: 2,
      outputUrlTtlMs: 3_600_000,
      maxDownloadBytes: 1024 ** 3,
      allowPrivateUrls: true,
      inlineMaxBytes: 32 * 1024 ** 2,
      motionUrl: null,
    });
    await runtime.start({ sweep: false });
    http = createHttpServer({
      runtime,
      credentials: new LocalCredentialStore({}, false),
      renderScoreDoc: stubRenderer(),
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    (runtime.config as { publicUrl: string }).publicUrl = base;
    client = new Client({ name: 'record-view', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { default: puppeteer } = await import('puppeteer-core');
    const args = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'];
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args });
    // A fake microphone playing a click every half second (120 bpm), for the device test.
    const clicks = new Float32Array(48_000 * 4);
    for (let k = 0; k < 8; k++) {
      for (let i = 0; i < 240; i++)
        clicks[k * 24_000 + i] = 0.8 * Math.exp(-i / 60) * Math.sin(i / 3);
    }
    const wav = join(dir, 'clicks.wav');
    await writeFile(wav, stereoWav(clicks, 48_000, 1));
    mic = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [
        ...args,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
      ],
    });
    if (shots) await mkdir(shots, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await mic?.close();
    await browser?.close();
    await client?.close();
    http?.close();
  });

  /** A score at 120 in 4/4 with a drum kit on a part and a two-bar region. */
  async function drums(): Promise<{ score_id: string; part_id: string }> {
    let { score_id } = (await call('score.create', {
      tempo: 120,
      meter: { beats: 4, unit: 4 },
      sample_rate: 48_000,
    })) as { score_id: string };
    const part = await call('score.add_part', { score_id, name: 'Drums' });
    const part_id = part.part_id as string;
    score_id = (
      await call('score.add_device', { score_id: part.score_id, part_id, name: 'kit_808' })
    ).score_id as string;
    score_id = (await call('score.add_region', { score_id, part_id, at_beats: 0, length_beats: 8 }))
      .score_id as string;
    return { score_id, part_id };
  }

  async function open(
    result: Rec,
    options: { browser?: Browser; width?: number; height?: number } = {},
  ): Promise<{ page: Page; view: Frame; cdp: CDPSession }> {
    const html = (
      (await client.readResource({ uri: 'ui://cuttingfloor/record' })).contents[0] as {
        text: string;
      }
    ).text;
    const page = await (options.browser ?? browser).newPage();
    const width = options.width ?? 360;
    const height = options.height ?? 640;
    await page.setViewport({ width, height });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)));
    // The host's page is a secure context on this server's origin, as a chat app's is on its own.
    await page.goto(`${base}/healthz`);
    await page.setContent(HOST_PAGE(height));
    await page.evaluate(
      (r, h) => {
        Object.assign(window, { RESULT: r });
        (document.getElementById('v') as HTMLIFrameElement).srcdoc = h;
      },
      { content: [], structuredContent: result },
      html,
    );
    const view = await new Promise<Frame>((resolve) => {
      const find = () => page.frames().find((f) => f !== page.mainFrame());
      const f = find();
      if (f) resolve(f);
      else page.once('frameattached', () => resolve(find() as Frame));
    });
    await view.waitForFunction(() => document.readyState === 'complete');
    expect(errors).toEqual([]);
    return { page, view, cdp: await page.createCDPSession() };
  }

  const shot = async (page: Page, name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const ready = (view: Frame) =>
    view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'ready', {
      timeout: 20_000,
    });
  type CfWin = {
    cfRecord: {
      S: {
        state: string;
        R: number;
        applied: { s: number; source: string };
        t: { T0: number; L: number };
        take: Rec;
        ctx: AudioContext;
        cal?: { clicks: number[] };
        mic: unknown;
        session: { loop: { seconds: number } };
      };
    };
  };

  /**
   * The performance time at which the browser is playing out a given context time, by its own
   * getOutputTimestamp, sampled now (the clock the view's taps are placed on).
   */
  /**
   * Presses when the audio clock reads `contextTime`. The performance time for it is worked out
   * from the output timestamp read just before the press, not once for a whole take: on a busy
   * machine the output slips whole render quanta against the performance clock while a take
   * plays, the view follows the slip (it reads the timestamp at each tap), and a time worked out
   * seconds earlier does not. CI measured a tap 10.539 ms from a time predicted that way (four
   * quanta of 2.667 ms), with every other tap within 0.1 ms.
   */
  async function pressWhen(
    view: Frame,
    cdp: CDPSession,
    selector: string,
    contextTime: number,
  ): Promise<void> {
    for (;;) {
      const [at, now] = (await view.evaluate((c) => {
        const ts = (window as unknown as CfWin).cfRecord.S.ctx.getOutputTimestamp();
        return [
          (ts.performanceTime as number) + (c - (ts.contextTime as number)) * 1000,
          performance.now(),
        ];
      }, contextTime)) as [number, number];
      if (at - now > 40) {
        await new Promise((r) => setTimeout(r, at - now - 30));
        continue;
      }
      await press(view, cdp, selector, at);
      return;
    }
  }

  /**
   * Presses at a pad at performance time `at` (ms), stamped with that time: CDP's event timestamp
   * is the touch's own time. The press is sent just after, as a real event reaches a page late.
   */
  async function press(view: Frame, cdp: CDPSession, selector: string, at: number) {
    const box = await (await view.$(selector))?.boundingBox();
    if (!box) throw new Error(`no ${selector}`);
    const [origin, now] = await view.evaluate(() => [performance.timeOrigin, performance.now()]);
    const wait = at - (now as number) + 4;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const timestamp = ((origin as number) + at) / 1000;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
      timestamp,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
      timestamp: timestamp + 0.03,
    });
  }

  async function take(jobId: string) {
    for (let i = 0; i < 100; i++) {
      const job = await call('job.get', { job_id: jobId, wait_seconds: 5 });
      if (job.status !== 'working') {
        if (job.status !== 'completed') throw new Error(JSON.stringify(job.error));
        return ScoreRecordTake.parse(job.result);
      }
    }
    throw new Error('the take never came');
  }

  it('taps dispatched at known times land at those positions in the score', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', {
        score_id,
        part_id,
        input: 'pads',
        velocity: 100,
        length_beats: 0.25,
        pads: ['C2', 'D2', 'D#2', 'F#2'],
        until_beats: 8,
        count_in_beats: 2,
        click: true,
      }),
    );
    const { page, view, cdp } = await open(opened);
    await ready(view);
    await shot(page, '1-pads-ready');
    expect(await view.$$eval('.pad', (els) => els.length)).toBe(4);
    await view.click('#go');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'playing');
    const { T0, L, R, applied } = await view.evaluate(() => {
      const S = (window as unknown as CfWin).cfRecord.S;
      return { T0: S.t.T0, L: S.t.L, R: S.R, applied: S.applied };
    });
    expect(applied).toEqual({ s: R, source: 'reported' });
    // Where each tap is played, as the person hears the loop: on the second count-in click,
    // on beats and off them, on the second pass.
    const targets = [
      { pitch: 38, pass: 0, at: -0.5 },
      { pitch: 36, pass: 0, at: 0.25 },
      { pitch: 42, pass: 0, at: 1.137 },
      { pitch: 36, pass: 0, at: 3.5 },
      { pitch: 39, pass: 1, at: 0.003 },
      { pitch: 42, pass: 1, at: 2.75 },
    ];
    for (const [i, t] of targets.entries()) {
      await pressWhen(view, cdp, `.pad[data-pitch="${t.pitch}"]`, T0 + t.pass * L + t.at);
      if (i === 2) await shot(page, '2-pads-playing');
    }
    await view.click('#go');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'review');
    await shot(page, '3-pads-review');
    await view.click('#send');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'sent');
    await shot(page, '4-pads-sent');
    const said = await page.evaluate(() => (window as unknown as { __msgs: Rec[] }).__msgs);
    expect(JSON.stringify(said)).toContain(`I sent my take (job_id ${opened.job_id}).`);
    const result = await take(opened.job_id);
    expect(result.delay).toEqual({
      output_ms: R * 1000,
      input_ms: 0,
      source: 'reported',
      route: 'other',
    });
    // Each tap's error, in ms: where it landed less where it was played (beats at 120 bpm).
    const errors = (result.taps ?? []).map(
      (tap, i) => (tap.at.beats - ((targets[i]?.pass ?? 0) * 8 + (targets[i]?.at ?? 0) * 2)) * 500,
    );
    process.stdout.write(
      `taps: output delay as reported ${Math.round(R * 1e4) / 10} ms; errors ms ${errors.map((e) => e.toFixed(3)).join(', ')}\n`,
    );
    expect(result.taps?.map((t) => [t.pitch, t.pass])).toEqual(
      targets.map((t) => [t.pitch, t.pass]),
    );
    for (const e of errors) expect(Math.abs(e)).toBeLessThan(TAP_TOLERANCE_MS);
    expect(middle(errors)).toBeLessThan(TAP_TYPICAL_MS);
    expect(result.outside?.length).toBe(3);
    await page.close();
  }, 90_000);

  it('the tap-along measure recovers a delay put in on purpose, and placing uses it', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', {
        score_id,
        part_id,
        input: 'pads',
        velocity: 100,
        length_beats: 0.25,
        pads: ['C2', 'D2', 'D#2', 'F#2'],
        until_beats: 8,
      }),
    );
    const { page, view, cdp } = await open(opened);
    await ready(view);
    const injected = 0.12;
    await view.click('#measure');
    await view.waitForFunction(
      () => (window as unknown as CfWin).cfRecord.S.state === 'calibrating',
    );
    await shot(page, '5-measuring');
    const { clicks, R } = await view.evaluate(() => {
      const S = (window as unknown as CfWin).cfRecord.S;
      return { clicks: S.cal?.clicks ?? [], R: S.R };
    });
    expect(clicks).toHaveLength(8);
    // A person who hears every click 120 ms after the browser says it plays out (Bluetooth),
    // tapping right on what they hear.
    for (const c of clicks) await pressWhen(view, cdp, '#caltap', c + injected);
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'ready', {
      timeout: 10_000,
    });
    const applied = await view.evaluate(() => (window as unknown as CfWin).cfRecord.S.applied);
    expect(applied.source).toBe('measured');
    const recovered = applied.s - R;
    process.stdout.write(
      `measure: put in ${injected * 1000} ms over the reported ${Math.round(R * 1e4) / 10} ms; measured ${(applied.s * 1000).toFixed(3)} ms, so ${(recovered * 1000).toFixed(3)} ms recovered\n`,
    );
    expect(Math.abs(recovered - injected) * 1000).toBeLessThan(MEASURE_TOLERANCE_MS);
    await shot(page, '6-measured');
    // The same person plays: taps placed with the measured delay land where they heard them.
    await view.click('#go');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'playing');
    const { T0, L } = await view.evaluate(() => (window as unknown as CfWin).cfRecord.S.t);
    const targets = [0.5, 1.75, 3.0];
    for (const x of targets) {
      await pressWhen(view, cdp, '.pad[data-pitch="36"]', T0 + x + injected);
    }
    expect(L).toBeCloseTo(4, 6);
    await view.click('#go');
    await view.click('#send');
    const result = await take(opened.job_id);
    expect(result.delay.source).toBe('measured');
    // What is sent is the delay as applied to this take: the reported delay as read when it
    // started, plus the part that was measured.
    const sentWith = await view.evaluate(() => {
      const S = (window as unknown as CfWin).cfRecord.S;
      return { s: S.applied.s, R: S.R };
    });
    expect(result.delay.output_ms).toBeCloseTo(sentWith.s * 1000, 6);
    expect(sentWith.s - sentWith.R).toBeCloseTo(recovered, 9);
    // Each tap is placed with the measured delay, so it carries that measurement's own error:
    // it lands earlier than it was heard by exactly what the measure came out over. (The view
    // reads the browser's reported delay again when the take starts and keeps the measured part
    // on top of it; before it did, a run where the reported delay had moved between the measure
    // and the take put all three taps 0.956, 0.953 and 0.954 ms out.)
    const landed = (result.taps ?? []).map(
      (tap, i) => (tap.at.seconds - ((targets[i] as number) - (recovered - injected))) * 1000,
    );
    process.stdout.write(
      `measure: taps placed with it, errors ms ${landed.map((e) => e.toFixed(3)).join(', ')}\n`,
    );
    expect(landed).toHaveLength(targets.length);
    for (const e of landed) expect(Math.abs(e)).toBeLessThan(TAP_TOLERANCE_MS);
    expect(middle(landed)).toBeLessThan(TAP_TYPICAL_MS);
    await page.close();
  }, 90_000);

  it('a microphone take lands where its sound was played, sample for sample', async () => {
    if (!ffmpegFound) return;
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', {
        score_id,
        part_id,
        input: 'microphone',
        until_beats: 8,
        count_in_beats: 2,
      }),
    );
    const { page, view } = await open(opened, { browser: mic });
    await ready(view);
    await shot(page, '7-mic-ready');
    // The microphone is a sound on the view's own audio clock: a click at known loop positions
    // as the person would make it (on what they hear), through a real MediaStream track.
    await view.evaluate(() => {
      const S = (window as unknown as CfWin).cfRecord.S;
      navigator.mediaDevices.getUserMedia = async () => {
        const dest = S.ctx.createMediaStreamDestination();
        (window as unknown as { __dest: MediaStreamAudioDestinationNode }).__dest = dest;
        return dest.stream;
      };
    });
    await view.click('#mic');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'playing');
    const played = [-0.5, 0.25, 1.5, 3.0, 4.75];
    await view.evaluate((positions) => {
      const S = (window as unknown as CfWin).cfRecord.S;
      const dest = (window as unknown as { __dest: MediaStreamAudioDestinationNode }).__dest;
      const ctx = S.ctx;
      // One buffer holding every click, played once: the clicks keep their distances exactly.
      const first = positions[0] as number;
      const rate = ctx.sampleRate;
      const b = ctx.createBuffer(
        1,
        Math.ceil((positions.at(-1) as number) - first + 1) * rate,
        rate,
      );
      const d = b.getChannelData(0);
      for (const x of positions) {
        const at = Math.round((x - first) * rate);
        for (let i = 0; i < 240; i++) d[at + i] = 0.8 * Math.exp(-i / 60) * Math.sin(i / 3);
      }
      const src = ctx.createBufferSource();
      (window as unknown as { __held: unknown }).__held = src;
      src.buffer = b;
      src.connect(dest);
      // Made by a person on what they hear: x of the loop is heard R after it is scheduled.
      src.start(S.t.T0 + first + S.applied.s);
    }, played);
    // Past the last click (4.75 s into the loop, 1.25 s after Start), with room.
    await new Promise((r) => setTimeout(r, 7000));
    await shot(page, '8-mic-recording');
    await view.click('#mic');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'review');
    await shot(page, '9-mic-review');
    await view.click('#send');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'sent', {
      timeout: 20_000,
    });
    const silent = await view.evaluate(
      () => (window as unknown as CfWin).cfRecord.S.take.silent_blocks,
    );
    const result = await take(opened.job_id);
    expect(result.input).toBe('microphone');
    // The recording as staged: PCM, 48 kHz, mono, 16-bit, and where each click is in it.
    const media = await call('media.get', { media_id: result.media_id as string });
    const wav = readMono(Buffer.from(await (await fetch(media.url as string)).arrayBuffer()));
    expect([wav.rate, wav.channels, wav.bits]).toEqual([48_000, 1, 16]);
    const onsets = findOnsets(wav.data, wav.rate);
    process.stdout.write(
      `microphone: ${wav.data.length / wav.rate} s recorded, clicks at ${onsets.join(', ')} s, starts_at ${result.starts_at_seconds}, blocks the stream gave nothing for ${silent}\n`,
    );
    expect(silent).toBe(0);
    expect(onsets).toHaveLength(played.length);
    const starts = result.starts_at_seconds as number;
    const errors = onsets.map((o, i) => (starts + o - (played[i] as number)) * 1000);
    process.stdout.write(
      `microphone: starts_at ${starts.toFixed(6)} s; click errors ms ${errors.map((e) => e.toFixed(3)).join(', ')}\n`,
    );
    // Every click the same distance from where it was played: the samples are continuous.
    const spread = Math.max(...errors) - Math.min(...errors);
    expect(spread).toBeLessThan(0.05);
    // That distance is the media stream's own delay, which the browser does not report.
    expect(Math.abs(errors[0] as number)).toBeLessThan(MIC_PIPELINE_MS);
    // In the score: the first sample on the beat that was heard.
    expect(result.recording?.at.seconds).toBeCloseTo(starts, 6);
    await page.close();
  }, 90_000);

  it('a fake microphone device: the recording loses and adds no sample between its clicks', async () => {
    if (!ffmpegFound) return;
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', { score_id, part_id, input: 'microphone', until_beats: 8 }),
    );
    const { page, view } = await open(opened, { browser: mic });
    await ready(view);
    await view.click('#mic');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'playing');
    await new Promise((r) => setTimeout(r, 3500));
    await view.click('#mic');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'review');
    await view.click('#send');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'sent', {
      timeout: 20_000,
    });
    const result = await take(opened.job_id);
    const media = await call('media.get', { media_id: result.media_id as string });
    const wav = readMono(Buffer.from(await (await fetch(media.url as string)).arrayBuffer()));
    const onsets = findOnsets(wav.data, wav.rate);
    expect(onsets.length).toBeGreaterThanOrEqual(5);
    const gaps = onsets.slice(1).map((o, i) => (o - (onsets[i] as number)) * wav.rate);
    process.stdout.write(
      `fake device: click gaps in samples ${gaps.join(', ')} (24000 expected)\n`,
    );
    // The recorder must neither lose nor add a sample: a gap is 24,000 samples. The fake device
    // itself can stall, though: it plays its file on a timer in 10 ms buffers, and on a busy
    // runner it resumed one buffer late (CI: 24000, 24000, 24480, 24000, 24000, 24000). That is
    // the microphone pausing, kept faithfully. So a gap may be longer by whole device buffers
    // (480 samples), never shorter and never by anything else, and most gaps are exact.
    const BUFFER = 480;
    const late = gaps.map((g) => g - 24_000);
    for (const d of late) {
      expect(d).toBeGreaterThanOrEqual(-1);
      const buffers = Math.round(d / BUFFER);
      expect(Math.abs(d - buffers * BUFFER)).toBeLessThanOrEqual(1);
      expect(buffers).toBeLessThanOrEqual(5);
    }
    expect(late.filter((d) => Math.abs(d) <= 1).length).toBeGreaterThanOrEqual(gaps.length - 2);
    await page.close();
  }, 90_000);

  it('a microphone take left running ends on the last pass the server takes, and is sent', async () => {
    if (!ffmpegFound) return;
    const { score_id, part_id } = await drums();
    // A short loop, so the 64 passes a take may span go by in seconds.
    const opened = ScoreRecordResult.parse(
      await call('score.record', { score_id, part_id, input: 'microphone', until_beats: 0.25 }),
    );
    const { page, view } = await open(opened, { browser: mic });
    await ready(view);
    await view.click('#mic');
    // Nobody stops it: the view does, when the take has reached its end.
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'review', {
      timeout: 60_000,
    });
    const ended = await view.evaluate(() => {
      const S = (window as unknown as CfWin).cfRecord.S;
      const t = S.take as unknown as { passes: number; starts_at_seconds: number; seconds: number };
      return {
        passes: t.passes,
        ends: t.starts_at_seconds + t.seconds,
        L: S.t.L,
        said: document.querySelector('#say')?.textContent,
      };
    });
    process.stdout.write(
      `take end: ${ended.passes} passes, ends ${ended.ends.toFixed(6)} s of ${(64 * ended.L).toFixed(6)} s; "${ended.said}"\n`,
    );
    // The server takes up to 64 passes. The view stops a moment after the 64th has ended, and
    // the recording had run into a 65th (measured: ends 8.000002 s of 8.000000, 65 passes), so
    // the take was refused whole. It is cut at the boundary now: never past it, and short of it
    // only by the blocks the microphone had not yet delivered when the view stopped (8 ms here).
    expect(ended.passes).toBe(RECORD_LIMITS.passes);
    expect(ended.ends).toBeLessThanOrEqual(RECORD_LIMITS.passes * ended.L);
    expect(ended.ends).toBeGreaterThan(RECORD_LIMITS.passes * ended.L - 0.1);
    expect(ended.said).toMatch(/64 passes/);
    await view.click('#send');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'sent', {
      timeout: 20_000,
    });
    const result = await take(opened.job_id);
    expect(result.input).toBe('microphone');
    await page.close();
  }, 120_000);

  it('a measured delay is dropped when the sound starts going out another way', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', {
        score_id,
        part_id,
        input: 'pads',
        velocity: 100,
        length_beats: 0.25,
        pads: ['C2'],
        until_beats: 8,
      }),
    );
    const { page, view } = await open(opened);
    await ready(view);
    // As after tapping along on Bluetooth headphones: 180 ms the browser does not report.
    const after = await view.evaluate(() => {
      const S = (window as unknown as CfWin).cfRecord.S;
      S.R = 0.03;
      S.applied = { s: 0.21, source: 'measured' };
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
      return { applied: S.applied, said: document.querySelector('#say')?.textContent };
    });
    // Kept, it would have moved every tap on the speaker 180 ms early.
    expect(after.applied).toEqual({ s: 0.03, source: 'reported' });
    expect(after.said).toMatch(/measure it again/);
    await page.close();
  }, 60_000);

  it('a pads take ends by itself at the most taps the server takes, and is sent', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', {
        score_id,
        part_id,
        input: 'pads',
        velocity: 100,
        length_beats: 0.25,
        pads: ['C2'],
        until_beats: 8,
      }),
    );
    const { page, view } = await open(opened);
    await ready(view);
    await view.click('#go');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'playing');
    // Once the loop is sounding (a touch before it starts is not in the take): more touches
    // than a take may hold, as fast as the page takes them.
    await view.waitForFunction(() => {
      const S = (window as unknown as CfWin).cfRecord.S;
      return S.ctx.currentTime > S.t.T0 + 0.3;
    });
    const state = await view.evaluate((n) => {
      const pad = document.querySelector('.pad') as HTMLElement;
      for (let i = 0; i < n; i++) {
        pad.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      }
      const S = (window as unknown as CfWin).cfRecord.S;
      return {
        state: (S as unknown as { state: string }).state,
        taps: (S.take.taps as unknown[]).length,
        said: document.querySelector('#say')?.textContent,
      };
    }, RECORD_LIMITS.taps + 25);
    // One tap more and the server refuses the whole take.
    expect(state.taps).toBe(RECORD_LIMITS.taps);
    expect(state.state).toBe('review');
    expect(state.said).toMatch(new RegExp(`${RECORD_LIMITS.taps} taps`));
    await view.click('#send');
    await view.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'sent', {
      timeout: 30_000,
    });
    const result = await take(opened.job_id);
    expect(result.taps).toHaveLength(RECORD_LIMITS.taps);
    await page.close();
  }, 120_000);

  it('the page behind the url works the same, at a phone’s width', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', {
        score_id,
        part_id,
        input: 'pads',
        velocity: 100,
        length_beats: 0.25,
        pads: ['C2', 'D2', 'D#2', 'F#2'],
        until_beats: 8,
      }),
    );
    const tab = await browser.newPage();
    await tab.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await tab.goto(opened.url);
    await tab.waitForFunction(() => (window as unknown as CfWin).cfRecord.S.state === 'ready', {
      timeout: 20_000,
    });
    expect(await tab.$$eval('.pad', (els) => els.length)).toBe(4);
    // Nothing wider than the phone.
    expect(await tab.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    if (shots) await tab.screenshot({ path: join(shots, '10-page-phone.png'), fullPage: true });
    // The speed slider asks for the loop at another speed.
    await tab.evaluate(() => {
      const s = document.getElementById('speed') as HTMLInputElement;
      s.value = '0.75';
      s.dispatchEvent(new Event('change'));
    });
    await tab.waitForFunction(
      () => {
        const S = (window as unknown as CfWin).cfRecord.S as unknown as {
          state: string;
          speed: number;
        };
        return S.state === 'ready' && S.speed === 0.75;
      },
      { timeout: 20_000 },
    );
    expect(await tab.$eval('#speedv', (el) => el.textContent)).toBe('0.75×');
    await tab.close();
    // In a chat app's small panel the view holds its place too.
    const small = await open(opened, { width: 320, height: 420 });
    await ready(small.view);
    expect(
      await small.view.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await shot(small.page, '11-panel-320');
    await small.page.close();
    await call('job.cancel', { job_id: opened.job_id });
  }, 90_000);

  it('where the host keeps the microphone from the view, it says so and offers the page', async () => {
    const { score_id, part_id } = await drums();
    const opened = ScoreRecordResult.parse(
      await call('score.record', { score_id, part_id, input: 'microphone', until_beats: 8 }),
    );
    const { page, view } = await open(opened);
    await ready(view);
    await view.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
      };
    });
    await view.click('#mic');
    await view.waitForSelector('#page:not([hidden])');
    expect(await view.$eval('#say', (el) => el.textContent)).toMatch(/Open it in the browser/);
    await shot(page, '12-mic-refused');
    await page.close();
    await call('job.cancel', { job_id: opened.job_id });
  }, 60_000);
});

/**
 * How close a tap lands to where it was dispatched, in ms. The tap's time is its event's own
 * timestamp (CDP sets it exactly). What remains is the browser's output timestamp: it moves in
 * render quanta (128 frames, 2.667 ms at 48 kHz), the view reads it at each tap, and the test
 * reads it just before each tap. On a quiet machine the two readings agree to about 0.1 ms. On a
 * busy runner the output slips a quantum between them, and the view follows the slip: that is
 * right, and it puts that one tap a quantum from where the test expected it. Measured on CI:
 *   0.074, 0.104, -0.080, 0.112, -2.538, 0.005 ms   (one tap, one quantum)
 *   one tap 10.539 ms out, when every time was worked out once before the take (four quanta
 *   over seconds; since then each time is worked out just before its tap)
 *   one tap 3.177 ms out in the measured-delay test: one quantum, plus the 0.364 ms by which
 *   that run's measurement differed from the delay put in, which every tap then carries.
 * So two things are held. The middle tap of a take is within TAP_TYPICAL_MS: no slip explains
 * that one being out, and it is what a wrong clock mapping would move. And no tap is further
 * out than two quanta, which a wrong delay or a wrong pass (tens of ms and more) would be.
 */
const QUANTUM_MS = (128 / 48_000) * 1000;
const TAP_TOLERANCE_MS = 2 * QUANTUM_MS + 0.5;
/**
 * How close the tap-along measure comes to the delay put in. It is taken from eight taps, so a
 * tap that slipped a quantum moves it by a third of a millisecond. CI has measured it 0.347,
 * 0.529, 0.443 and 0.364 ms out; this Mac under 0.11.
 */
const MEASURE_TOLERANCE_MS = 1;
/**
 * The middle tap of a take: no slip explains this one being out. On the image runner the taps
 * print within 0.2 ms; this is under half a quantum, with room for a runner that is not quiet.
 */
const TAP_TYPICAL_MS = 1;
const middle = (errors: number[]) => {
  const sorted = errors.map(Math.abs).sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] as number;
};
/**
 * How far a recorded sound may sit from where it was played, in ms: the delay of the media stream
 * the test plays into (a destination node of the view's own context, then its microphone input),
 * which the browser does not report as the track's latency. Measured at 10.69 to 10.71 ms
 * (about 514 samples) over twelve runs; every click of a take is off by the same amount, to
 * within 0.05 ms.
 */
const MIC_PIPELINE_MS = 15;

/** Where clicks start in a recording: the first sample over 0.3 after 50 ms of quiet. */
function findOnsets(data: Float32Array, rate: number): number[] {
  const out: number[] = [];
  let quiet = rate;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i] as number) > 0.3) {
      if (quiet >= 0.05 * rate) out.push(i / rate);
      quiet = 0;
    } else quiet += 1;
  }
  return out;
}
