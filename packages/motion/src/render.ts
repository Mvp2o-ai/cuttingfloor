import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import { clockScript } from './clock.ts';
import { libraryPath } from './document.ts';

// The renders themselves: a page stepped a frame at a time on a virtual clock (clock.ts), each
// frame captured by Chromium and piped to FFmpeg. These run in a job process the worker starts
// for each request, or inside a code.run job, never in the main server: the page is agent code.

/** Chromium, through a wrapper that keeps its sandbox on and its network off (tools/motion). */
export const CHROMIUM = process.env.CUTTINGFLOOR_CHROMIUM ?? '/usr/local/bin/cf-chromium';

export interface MotionJob {
  kind: 'motion' | 'still';
  width: number;
  height: number;
  fps: number;
  /** Seconds (motion). */
  duration: number;
  transparent: boolean;
  /** Seeds Math.random in the page. */
  seed?: number;
}

export type Report = (fraction: number, message: string) => void;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

const ORIGIN = 'http://page.invalid/';

/** Loads root/entry in a fresh browser, with only root's files and lib/ answering requests. */
async function openPage(
  root: string,
  entry: string,
  job: MotionJob,
  profile: string,
  logs: string[],
): Promise<{ browser: Browser; page: Page; cdp: CDPSession; crashed: Promise<never> }> {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    // Talk over a pipe, not a loopback port: code jobs run with no network at all.
    pipe: true,
    userDataDir: profile,
    args: [
      `--window-size=${job.width},${job.height}`,
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: job.width, height: job.height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(clockScript(job.seed ?? 1));
    // The page's own errors, for the failure detail.
    page.on('pageerror', (e) => logs.push(String((e as Error).message ?? e).slice(0, 300)));
    page.on('console', (m) => {
      if (m.type() === 'error') logs.push(m.text().slice(0, 300));
    });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return void req.continue();
      if (!url.startsWith(ORIGIN)) return void req.abort('blockedbyclient');
      const rel = normalize(decodeURIComponent(new URL(url).pathname)).replace(/^\/+/, '');
      if (rel.startsWith('..')) return void req.abort('accessdenied');
      const file = (rel.startsWith('lib/') && libraryPath(rel.slice(4))) || join(root, rel);
      readFile(file).then(
        (body) =>
          req.respond({
            status: 200,
            contentType: TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream',
            headers: { 'access-control-allow-origin': '*' },
            body,
          }),
        () => req.respond({ status: 404, body: '' }),
      );
    });
    // A page that crashes (out of memory, too many workers) fails now rather than at the timeout.
    const crashed = new Promise<never>((_, reject) =>
      page.on('error', (e) => reject(new Error(`The page crashed: ${e.message}`))),
    );
    crashed.catch(() => undefined);
    await Promise.race([
      page.goto(`${ORIGIN}${entry}`, { waitUntil: 'load', timeout: 30_000 }),
      crashed,
    ]);
    // First frame, then web fonts and window.__ready (a promise the page may set for work it
    // finishes after load), for up to ten real seconds.
    await Promise.race([page.evaluate('window.__cf.seek(0)'), crashed]);
    await Promise.race([
      page.evaluate('Promise.all([document.fonts.ready, window.__ready]).then(() => undefined)'),
      new Promise((r) => setTimeout(r, 10_000)),
      crashed,
    ]);
    const cdp = await page.createCDPSession();
    if (job.transparent) {
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 },
      });
    }
    return { browser, page, cdp, crashed };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function capture(cdp: CDPSession, job: MotionJob): Promise<Buffer> {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    optimizeForSpeed: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: job.width, height: job.height, scale: 1 },
  });
  return Buffer.from(data, 'base64');
}

const withLogs = (e: unknown, logs: string[]) =>
  Object.assign(e instanceof Error ? e : new Error(String(e)), { console: logs.slice(-10) });

export interface RenderOptions {
  /** Page to load, relative to the folder. Default index.html. */
  entry?: string;
  /** Output file. Default out.mov (transparent), out.mp4 or out.png in the folder. */
  out?: string;
  /** Browser profile folder. Default profile/ in the folder. */
  profile?: string;
}

/**
 * Renders dir/index.html frame by frame: ProRes 4444 with alpha (transparent) or H.264, at the
 * job's size, rate and length.
 */
export async function renderMotion(
  dir: string,
  job: MotionJob,
  report: Report,
  options: RenderOptions = {},
): Promise<string> {
  const out = options.out ?? join(dir, job.transparent ? 'out.mov' : 'out.mp4');
  const total = Math.max(1, Math.round(job.duration * job.fps));
  report(0, 'loading');
  const logs: string[] = [];
  const { browser, page, cdp, crashed } = await openPage(
    dir,
    options.entry ?? 'index.html',
    job,
    options.profile ?? join(dir, 'profile'),
    logs,
  ).catch((e) => {
    throw withLogs(e, logs);
  });
  const codec = job.transparent
    ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p'];
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(job.fps),
      '-c:v',
      'png',
      '-i',
      '-',
      '-vf',
      `scale=out_color_matrix=bt709:out_range=tv,format=${job.transparent ? 'yuva444p10le' : 'yuv420p'}`,
      ...codec,
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-r',
      String(job.fps),
      ...(out.endsWith('.mp4') ? ['-movflags', '+faststart'] : []),
      out,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let ffmpegErr = '';
  ffmpeg.stderr.on('data', (d: Buffer) => {
    ffmpegErr = (ffmpegErr + d.toString()).slice(-2000);
  });
  const finished = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`FFmpeg failed: ${ffmpegErr.trim()}`)),
    );
  });
  finished.catch(() => undefined);
  try {
    for (let i = 0; i < total; i++) {
      await Promise.race([page.evaluate(`window.__cf.seek(${i / job.fps})`), crashed]);
      const png = await Promise.race([capture(cdp, job), crashed]);
      if (!ffmpeg.stdin.write(png)) {
        await new Promise<void>((resolve, reject) => {
          ffmpeg.stdin.once('drain', resolve);
          finished.catch(reject);
        });
      }
      if (i % 5 === 0) report(i / total, `frame ${i + 1} of ${total}`);
    }
    ffmpeg.stdin.end();
    await finished;
    report(1, 'encoded');
    return out;
  } catch (e) {
    throw withLogs(e, logs);
  } finally {
    if (!ffmpeg.stdin.writableEnded) ffmpeg.stdin.destroy();
    if (ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    await browser.close().catch(() => undefined);
  }
}

/** Screenshots dir/index.html at the job size to dir/out.png, transparent where nothing paints. */
export async function renderStill(
  dir: string,
  job: MotionJob,
  report: Report,
  options: RenderOptions = {},
): Promise<string> {
  report(0.2, 'loading');
  const logs: string[] = [];
  const { browser, cdp, crashed } = await openPage(
    dir,
    options.entry ?? 'index.html',
    job,
    options.profile ?? join(dir, 'profile'),
    logs,
  ).catch((e) => {
    throw withLogs(e, logs);
  });
  try {
    report(0.7, 'capturing');
    const out = options.out ?? join(dir, 'out.png');
    await writeFile(out, await Promise.race([capture(cdp, job), crashed]));
    return out;
  } catch (e) {
    throw withLogs(e, logs);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
