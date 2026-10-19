// node verify.mjs <timeline_id> <out.mp4> [preset]
// Exports, downloads, imports the render back and prints its own transcript: read it against the script.
import { writeFileSync } from 'node:fs';
import { call, client, run } from './lib.mjs';

const [tl, out, preset = 'social_9x16_h264'] = process.argv.slice(2);
const ex = await run('export.video', { timeline_id: tl, preset });
writeFileSync(out, Buffer.from(await (await fetch(ex.url)).arrayBuffer()));
const m = await run('media.import', { source: { job_id: ex.job_id } });
await run('media.analyze', { media_id: m.media_id, kind: 'transcript' });
const g = await call('media.get', { media_id: m.media_id, include: ['transcript'] });
console.log(JSON.stringify({ job_id: ex.job_id, media_id: m.media_id, words: g.transcript.words.map((w) => `${w.text}@${w.start.toFixed(2)}`).join(' ') }));
await client.close();
