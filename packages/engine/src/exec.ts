import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { CfError, serverBusy } from '@cuttingfloor/schema';

/** Engine binaries. The image pins them; env vars override for development. */
export const BIN = {
  ffmpeg: process.env.CUTTINGFLOOR_FFMPEG ?? 'ffmpeg',
  ffprobe: process.env.CUTTINGFLOOR_FFPROBE ?? 'ffprobe',
  melt: process.env.CUTTINGFLOOR_MELT ?? 'melt',
  fcScan: 'fc-scan',
  whisper: process.env.CUTTINGFLOOR_WHISPER ?? 'whisper-cli',
  vision: process.env.CUTTINGFLOOR_VISION ?? 'cf-vision',
  segment: process.env.CUTTINGFLOOR_SEGMENT ?? 'cf-segment',
  zip: 'zip',
  tts: process.env.CUTTINGFLOOR_TTS ?? 'sherpa-onnx-offline-tts',
  tar: 'tar',
  fcList: 'fc-list',
};

export interface RunOptions {
  /**
   * A render (melt, an encode, a model): it waits for one of the render slots this process
   * shares, so a busy server queues work instead of running out of memory. The timeout counts
   * from when it starts, not while it waits.
   */
  heavy?: boolean;
  /** While a heavy run waits: how many runs are ahead of it (called again as that changes). */
  onQueue?: (ahead: number) => void;
  signal?: AbortSignal;
  /** Called with each stderr line as it arrives (progress parsing). */
  onLine?: (line: string) => void;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Renders that may run at once in this process: CUTTINGFLOOR_MAX_RENDERS, else half the CPUs. */
let renderLimit = Math.max(
  1,
  Number(process.env.CUTTINGFLOOR_MAX_RENDERS) ||
    Math.max(2, Math.floor(availableParallelism() / 2)),
);
let rendering = 0;
const renderQueue: Array<{ grant: () => void; onQueue?: ((ahead: number) => void) | undefined }> =
  [];

/** Sets how many heavy runs may go at once (the server sets it from its config). */
export function setRenderLimit(limit: number): void {
  renderLimit = Math.max(1, Math.floor(limit));
  while (rendering < renderLimit && renderQueue.length) next();
}

/** Heavy runs going now, the limit, and how many wait. */
export function renderLoad(): { running: number; limit: number; waiting: number } {
  return { running: rendering, limit: renderLimit, waiting: renderQueue.length };
}

function next(): void {
  const first = renderQueue.shift();
  if (!first) return;
  rendering += 1;
  first.grant();
  tellQueue();
}

/** Tells each waiting run how many are ahead of it now. */
function tellQueue(): void {
  for (const [i, w] of renderQueue.entries()) w.onQueue?.(i);
}

/** Waits for a render slot; resolves with its release. */
function renderSlot(
  signal: AbortSignal | undefined,
  onQueue: ((ahead: number) => void) | undefined,
): Promise<() => void> {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rendering -= 1;
    while (rendering < renderLimit && renderQueue.length) next();
  };
  if (rendering < renderLimit && !renderQueue.length) {
    rendering += 1;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const entry = { grant: () => resolve(release), onQueue };
    renderQueue.push(entry);
    onQueue?.(renderQueue.length - 1);
    signal?.addEventListener(
      'abort',
      () => {
        const at = renderQueue.indexOf(entry);
        if (at < 0) return;
        renderQueue.splice(at, 1);
        tellQueue();
        reject(new CfError('cancelled', 'Cancelled'));
      },
      { once: true },
    );
  });
}

/** Who hears about heavy runs waiting for a slot, for work deep inside a job. */
const queueWatch = new AsyncLocalStorage<{
  queued: (ahead: number) => void;
  started: () => void;
}>();

/**
 * Runs `work` so that any heavy run inside it that has to wait reports where it stands
 * (`queued`) and when it gets its slot (`started`): a job's status says it waits for a render.
 */
export function watchRenderQueue<T>(
  watch: { queued: (ahead: number) => void; started: () => void },
  work: () => Promise<T>,
): Promise<T> {
  return queueWatch.run(watch, work);
}

/**
 * Runs an engine binary with an argument list (never a shell). Rejects with engine_error, or
 * server_busy when the machine has no memory or processes left for it.
 */
export async function run(
  bin: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (!options.heavy) return spawnRun(bin, args, options);
  const watch = queueWatch.getStore();
  let waited = false;
  const onQueue =
    options.onQueue || watch
      ? (ahead: number) => {
          waited = true;
          options.onQueue?.(ahead);
          watch?.queued(ahead);
        }
      : undefined;
  const release = await renderSlot(options.signal, onQueue);
  if (waited) watch?.started();
  try {
    return await spawnRun(bin, args, options);
  } finally {
    release();
  }
}

function spawnRun(bin: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CfError('cancelled', 'Cancelled'));
      return;
    }
    const child = spawn(bin, args, {
      cwd: options.cwd,
      // MLT's Qt modules (qtblend) refuse to load without a display variable; Qt itself renders
      // offscreen and never connects to it.
      env: { DISPLAY: ':0', ...process.env, QT_QPA_PLATFORM: 'offscreen', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const killer = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', killer, { once: true });
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killer();
        }, options.timeoutMs)
      : undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
      if (options.onLine) {
        pending += chunk;
        const lines = pending.split(/\r|\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) if (line) options.onLine(line);
      }
    });
    child.on('error', (error) => {
      cleanup();
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOMEM' || code === 'EAGAIN') {
        reject(
          serverBusy(
            `No memory or processes left to start ${bin} (${code})`,
            'raise the Docker memory limit, or lower CUTTINGFLOOR_MAX_RENDERS',
          ),
        );
        return;
      }
      reject(
        new CfError('engine_error', `Could not start ${bin}: ${error.message}`, {
          hint: 'The engines ship in the Docker image; run cuttingfloor there',
        }),
      );
    });
    child.on('close', (code, sig) => {
      cleanup();
      if (options.signal?.aborted) {
        reject(new CfError('cancelled', 'Cancelled'));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tail = stderr.trim().split('\n').slice(-6).join('\n');
        // A SIGKILL we didn't send is the kernel's out-of-memory killer.
        if (!timedOut && sig === 'SIGKILL') {
          const busy = serverBusy(
            `${bin} was stopped by the system, most likely out of memory`,
            'raise the Docker memory limit, or lower CUTTINGFLOOR_MAX_RENDERS',
          );
          reject(
            new CfError(busy.code, busy.message, {
              ...(busy.hint ? { hint: busy.hint } : {}),
              detail: { ...busy.detail, stderr: tail },
            }),
          );
          return;
        }
        const hint = timedOut ? 'The engine took too long and was stopped' : undefined;
        reject(
          new CfError('engine_error', `${bin} failed (${sig ?? `exit ${code}`})`, {
            detail: { stderr: tail },
            ...(hint ? { hint } : {}),
          }),
        );
      }
    });
    function cleanup() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', killer);
    }
  });
}

/** Engine versions for the health resource. Missing engines report null. */
export async function engineVersions(): Promise<Record<string, string | null>> {
  const first = async (bin: string, args: string[]) => {
    try {
      const { stdout, stderr } = await run(bin, args, { timeoutMs: 10_000 });
      return (stdout || stderr).split('\n')[0]?.trim() ?? null;
    } catch {
      return null;
    }
  };
  const [ffmpeg, melt] = await Promise.all([
    first(BIN.ffmpeg, ['-version']),
    first(BIN.melt, ['--version']),
  ]);
  return { ffmpeg, melt };
}

let fonts: Promise<string[]> | undefined;

/** Font families installed in the image (what text styles can name), from fontconfig. */
export function installedFonts(): Promise<string[]> {
  fonts ??= run(BIN.fcList, [':', 'family'], { timeoutMs: 30_000 })
    .then(({ stdout }) =>
      [...new Set(stdout.split('\n').flatMap((l) => l.split(',')[0]?.trim() || []))].sort(),
    )
    .catch(() => []);
  return fonts;
}
