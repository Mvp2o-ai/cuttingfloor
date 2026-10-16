// Writes tools/motion/seccomp.json: Docker's default seccomp profile (moby/profiles, pinned) plus
// clone, unshare and chroot without CAP_SYS_ADMIN/CAP_SYS_CHROOT, so Chromium can make the user
// and PID namespaces its sandbox lives in and chroot into them. Nothing else is loosened.
// Run with: node scripts/motion-seccomp.ts
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const COMMIT = '4b8214fc4971e06172938a1f1554ccff6647ee80';
const URL = `https://raw.githubusercontent.com/moby/profiles/${COMMIT}/seccomp/default.json`;
const SHA256 = '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6';

const res = await fetch(URL);
if (!res.ok) throw new Error(`${URL}: ${res.status}`);
const text = await res.text();
const digest = createHash('sha256').update(text).digest('hex');
if (digest !== SHA256) throw new Error(`${URL}: sha256 ${digest}, expected ${SHA256}`);
const profile = JSON.parse(text) as { syscalls: Array<{ names: string[]; action: string }> };
profile.syscalls.push({ names: ['clone', 'unshare', 'chroot'], action: 'SCMP_ACT_ALLOW' });
await writeFile(
  new globalThis.URL('../tools/motion/seccomp.json', import.meta.url),
  `${JSON.stringify(profile, null, 2)}\n`,
);
process.stdout.write(
  `tools/motion/seccomp.json from moby/profiles@${COMMIT.slice(0, 12)} (sha256 verified)\n`,
);
