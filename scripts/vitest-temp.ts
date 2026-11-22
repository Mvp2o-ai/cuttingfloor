import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test run gets a temp folder of its own: TMPDIR points into it for the run (the workers
// and the servers, engines and scripts they start inherit it), and it goes when the run ends,
// whether tests passed, failed or were cut short by a failure. Tests and the code under test
// still clean up after themselves; this catches what one leaves (a failed test's folder, a
// killed engine's scratch). CUTTINGFLOOR_KEEP_TEST_TMP=1 keeps it and says what was left.

export default function setup(): () => void {
  const before = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), 'cf-run-'));
  process.env.TMPDIR = root;
  return () => {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    if (process.env.CUTTINGFLOOR_KEEP_TEST_TMP === '1') {
      const left = readdirSync(root);
      process.stderr.write(`test temp folder kept: ${root} (${left.length} entries)\n`);
      return;
    }
    rmSync(root, { recursive: true, force: true });
  };
}
