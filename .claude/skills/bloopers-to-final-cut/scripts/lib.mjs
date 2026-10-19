// cuttingfloor MCP client for the Bloopers to Final Cut scripts.
// Key: CF_KEY, else the first key in deploy/hetzner/cuttingfloor.env (git-ignored), like scripts/smoke-hosted.ts.
// Address: CF_URL, default https://api.cuttingfloor.ai/mcp. Never print the key.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const fromEnvFile = () => {
  try {
    const env = readFileSync(`${root}/deploy/hetzner/cuttingfloor.env`, 'utf8');
    return /^CUTTINGFLOOR_API_KEYS=[^:,\s]+:([^,\s]+)/m.exec(env)?.[1];
  } catch { return undefined; }
};
const key = process.env.CF_KEY ?? fromEnvFile();
if (!key) throw new Error('Set CF_KEY, or CUTTINGFLOOR_API_KEYS in deploy/hetzner/cuttingfloor.env');
export const client = new Client({ name: 'bloopers-to-final-cut', version: '0' });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.CF_URL ?? 'https://api.cuttingfloor.ai/mcp'), {
  requestInit: { headers: { authorization: `Bearer ${key}` } },
}));

/** One tool call; throws the typed error. */
export async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.structuredContent ?? r.content).slice(0, 800)}`);
  return r.structuredContent;
}

/** A long-running call followed to its result. */
export async function run(name, args) {
  const started = await call(name, args);
  if (!started?.job_id) return started;
  for (;;) {
    const j = await call('job.get', { job_id: started.job_id, wait_seconds: 30 });
    if (j.status !== 'working') {
      if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
      return { ...j.result, job_id: started.job_id };
    }
  }
}

/** Every word of a media's transcript (media.analyze transcript must have run). */
export async function words(mediaId) {
  const g = await call('media.get', { media_id: mediaId, include: ['transcript'] });
  return g.transcript.words.map(({ text, start, end }) => ({ text, start, end }));
}
