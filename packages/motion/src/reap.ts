import { readdir, readFile } from 'node:fs/promises';

/**
 * Kills every process carrying this job's environment marker. Chromium starts in its own session
 * (Puppeteer launches it detached) and scripts may start their own, so a job's process group
 * alone doesn't reach everything; the marker does.
 */
export async function reap(marker: string): Promise<void> {
  const needle = Buffer.from(`${marker}\0`);
  let pids: string[];
  try {
    pids = (await readdir('/proc')).filter((p) => /^\d+$/.test(p));
  } catch {
    return; // No /proc (macOS): the process group kill is all there is.
  }
  await Promise.all(
    pids.map(async (pid) => {
      if (Number(pid) === process.pid) return;
      try {
        if ((await readFile(`/proc/${pid}/environ`)).includes(needle))
          process.kill(Number(pid), 'SIGKILL');
      } catch {
        // Gone, or not ours to read.
      }
    }),
  );
}
