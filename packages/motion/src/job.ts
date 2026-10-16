import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type MotionJob, renderMotion, renderStill } from './render.ts';

// One render in its own process group: node job.ts DIR. The worker kills the whole group after
// it, so a page can't leave Chromium (or anything it started) running. Progress and the outcome
// are JSON lines on stdout.

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: job.ts DIR\n');
  process.exit(2);
}
const say = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

try {
  const job = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')) as MotionJob;
  const report = (fraction: number, message: string) => say({ progress: fraction, message });
  const file =
    job.kind === 'still'
      ? await renderStill(dir, job, report)
      : await renderMotion(dir, job, report);
  say({ done: file });
  process.exit(0);
} catch (error) {
  const e = error as Error & { console?: string[] };
  say({ failed: e.message, ...(e.console?.length ? { console: e.console } : {}) });
  process.exit(1);
}
