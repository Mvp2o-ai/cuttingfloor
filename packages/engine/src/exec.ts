import { spawn } from 'node:child_process';
import { CfError } from '@cuttingfloor/schema';

/** Engine binaries. The image pins them; env vars override for development. */
export const BIN = {
  ffmpeg: process.env.CUTTINGFLOOR_FFMPEG ?? 'ffmpeg',
  ffprobe: process.env.CUTTINGFLOOR_FFPROBE ?? 'ffprobe',
  melt: process.env.CUTTINGFLOOR_MELT ?? 'melt',
  fcScan: 'fc-scan',
  fcList: 'fc-list',
};

export interface RunOptions {
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

/** Runs an engine binary with an argument list (never a shell). Rejects with engine_error. */
export function run(bin: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
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
        const hint = timedOut
          ? 'The engine took too long and was stopped'
          : sig === 'SIGKILL'
            ? 'The engine was killed, most likely out of memory: raise the Docker memory limit or run fewer jobs at once (CUTTINGFLOOR_MAX_JOBS)'
            : undefined;
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
