import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// The renders themselves. These run in a job process the worker starts for each request (job.ts),
// never in the main server: the page is agent-written code.

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
}

export type Report = (fraction: number, message: string) => void;

/** Renders dir/index.html with HyperFrames to dir/out.mov (alpha) or dir/out.mp4. */
export async function renderMotion(dir: string, job: MotionJob, report: Report): Promise<string> {
  // HyperFrames reads its browser and capture settings from the environment.
  process.env.PRODUCER_HEADLESS_SHELL_PATH = CHROMIUM;
  process.env.PRODUCER_FORCE_SCREENSHOT = 'true';
  process.env.PRODUCER_ENABLE_BROWSER_POOL = 'false';
  process.env.PRODUCER_BROWSER_GPU_MODE = 'software';
  process.env.PRODUCER_VERIFY_HYPERFRAME_RUNTIME = 'true';
  const { createRenderJob, executeRenderJob } = await import('@hyperframes/producer');
  const out = join(dir, job.transparent ? 'out.mov' : 'out.mp4');
  const quiet = () => undefined;
  const render = createRenderJob({
    fps: job.fps,
    quality: 'high',
    format: job.transparent ? 'mov' : 'mp4',
    workers: Number(process.env.CUTTINGFLOOR_MOTION_WORKERS ?? 1),
    useGpu: false,
    strictness: 'strict',
    entryFile: 'index.html',
    logger: { error: quiet, warn: quiet, info: quiet, debug: quiet },
  } as Parameters<typeof createRenderJob>[0]);
  await executeRenderJob(render, dir, out, (j, message) =>
    report(Math.min(1, (j.progress ?? 0) / 100), message || j.currentStage),
  );
  return out;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
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
};

const ORIGIN = 'http://still.invalid/';

/** Screenshots dir/index.html at the job size to dir/out.png, transparent where nothing paints. */
export async function renderStill(dir: string, job: MotionJob, report: Report): Promise<string> {
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    userDataDir: join(dir, 'profile'),
    args: [
      `--window-size=${job.width},${job.height}`,
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: job.width, height: job.height, deviceScaleFactor: 1 });
    // Pages load from the job folder only; every other request fails.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return void req.continue();
      if (!url.startsWith(ORIGIN)) return void req.abort('blockedbyclient');
      const rel = normalize(decodeURIComponent(new URL(url).pathname)).replace(/^\/+/, '');
      if (rel.startsWith('..') || rel.startsWith('profile')) return void req.abort('accessdenied');
      readFile(join(dir, rel)).then(
        (body) =>
          req.respond({
            status: 200,
            contentType: TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream',
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
    report(0.2, 'loading');
    await Promise.race([
      page.goto(`${ORIGIN}index.html`, { waitUntil: 'load', timeout: 30_000 }),
      crashed,
    ]);
    // Runs in the page: wait for web fonts, and for window.__ready (a promise the page may set
    // for work it finishes after load) up to ten seconds, before capturing.
    await Promise.race([
      page.evaluate(
        'Promise.race([Promise.all([document.fonts.ready, window.__ready]), new Promise((r) => setTimeout(r, 10000))]).then(() => undefined)',
      ),
      crashed,
    ]);
    report(0.7, 'capturing');
    const out = join(dir, 'out.png');
    await page.screenshot({
      path: out as `${string}.png`,
      type: 'png',
      omitBackground: job.transparent,
      clip: { x: 0, y: 0, width: job.width, height: job.height },
    });
    return out;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
