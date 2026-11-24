// Loads a pack into the sound library (packages/server/src/sound-library.ts): each sound is
// trimmed of silence at its ends, its peak set to -1 dBTP, encoded as FLAC, embedded with CLAP's
// audio encoder, put in the public sounds bucket and recorded in MongoDB. Run in the cuttingfloor
// image (FFmpeg and the CLAP model are there), on a pack a fetch script prepared:
//
//   node --env-file=cuttingfloor.env scripts/sounds/load.ts <pack dir> [--limit N]
//   node --env-file=cuttingfloor.env scripts/sounds/load.ts --builtin
//
// A pack dir holds pack.json ({id, licence, source_url}) and manifest.jsonl, one sound a line:
// {id, file (relative to the dir), name, description, tags, category, author, source_url,
// licence}. --builtin loads the sound effects pack the site serves (sound-effects.ts).
//
// Reads CUTTINGFLOOR_MONGODB_* (or _URI) and _DB for the records, CUTTINGFLOOR_S3_ENDPOINT,
// _REGION and the keys for the bucket, CUTTINGFLOOR_SOUNDS_BUCKET (default cuttingfloor-sounds)
// and CUTTINGFLOOR_SOUNDS_FILES (the bucket's public address; default the Hetzner one). A sound
// already in the library with the same embedding model is skipped, so a run can be repeated.
// Only CC0 and public-domain sounds are taken; anything else in a manifest is refused.
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BIN,
  CLAP_DIMENSIONS,
  CLAP_MODEL,
  clapSounds,
  run,
} from '../../packages/engine/src/index.ts';
import {
  prepareSoundLibrary,
  SOUND_PACKS,
  SOUNDS,
  type SoundDoc,
  type SoundPackDoc,
} from '../../packages/server/src/index.ts';
import { SOUND_EFFECTS, SOUND_EFFECTS_URL } from '../../packages/server/src/sound-effects.ts';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const sdk = require('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');
const { MongoClient } = require('mongodb') as typeof import('mongodb');
const { mongoUri } = (await import(
  '../../packages/core/src/index.ts'
)) as typeof import('../../packages/core/src/index.ts');

interface Entry {
  id: string;
  file: string;
  name: string;
  description: string;
  tags: string[];
  category: string;
  author: string | null;
  source_url: string | null;
  licence: string;
}

const LICENCES = new Set(['CC0', 'Public domain']);
/** Sounds embedded in one CLAP run (one model load). */
const BATCH = 32;
/** The longest sound kept: longer ones are ambiences cut to this. */
const MOST_SECONDS = 120;

const env = (name: string, fallback?: string) => {
  const v = process.env[name]?.trim() || fallback;
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const args = process.argv.slice(2);
const builtin = args.includes('--builtin');
const limitAt = args.indexOf('--limit');
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Number.POSITIVE_INFINITY;
const dir = builtin
  ? undefined
  : args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');
if (!builtin && !dir) throw new Error('Name a pack dir, or --builtin');

const bucket = env('CUTTINGFLOOR_SOUNDS_BUCKET', 'cuttingfloor-sounds');
const filesAt = env(
  'CUTTINGFLOOR_SOUNDS_FILES',
  `https://${bucket}.fsn1.your-objectstorage.com`,
).replace(/\/+$/, '');
const s3 = new sdk.S3Client({
  endpoint: env('CUTTINGFLOOR_S3_ENDPOINT'),
  region: env('CUTTINGFLOOR_S3_REGION', 'fsn1'),
  credentials: {
    accessKeyId: env('CUTTINGFLOOR_S3_ACCESS_KEY_ID'),
    secretAccessKey: env('CUTTINGFLOOR_S3_SECRET_ACCESS_KEY'),
  },
  forcePathStyle: process.env.CUTTINGFLOOR_S3_PATH_STYLE === '1',
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const uri =
  process.env.CUTTINGFLOOR_MONGODB_URI?.trim() ||
  mongoUri({
    host: env('CUTTINGFLOOR_MONGODB_HOST'),
    user: env('CUTTINGFLOOR_MONGODB_USER'),
    password: env('CUTTINGFLOOR_MONGODB_PASSWORD'),
  });
const mongo = new MongoClient(uri, { appName: 'cuttingfloor-sounds' });
await mongo.connect();
const db = mongo.db(process.env.CUTTINGFLOOR_MONGODB_DB?.trim() || 'cuttingfloor');
await prepareSoundLibrary(db, CLAP_DIMENSIONS);
const sounds = db.collection<SoundDoc>(SOUNDS);

// The pack and its sounds.
let pack: { id: string; licence: string; source_url: string | null };
let entries: Entry[];
let base: string;
const work = await mkdtemp(join(tmpdir(), 'cf-sound-load-'));
if (builtin) {
  pack = { id: 'cuttingfloor', licence: 'CC0', source_url: 'https://cuttingfloor.ai/sounds' };
  base = work;
  entries = [];
  for (const [name, s] of Object.entries(SOUND_EFFECTS)) {
    const response = await fetch(`${SOUND_EFFECTS_URL}/${name}.wav`);
    if (!response.ok) throw new Error(`${name}.wav: HTTP ${response.status}`);
    await writeFile(join(work, `${name}.wav`), Buffer.from(await response.arrayBuffer()));
    entries.push({
      id: name,
      file: `${name}.wav`,
      name: name.replaceAll('-', ' '),
      description: s.use,
      tags: ['meme', 'hype', ...name.split('-')],
      category: 'Meme and hype',
      author: null,
      source_url: `${SOUND_EFFECTS_URL}/${name}.wav`,
      licence: 'CC0',
    });
  }
} else {
  base = resolve(dir as string);
  pack = JSON.parse(await readFile(join(base, 'pack.json'), 'utf8'));
  entries = (await readFile(join(base, 'manifest.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
}
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(pack.id)) throw new Error(`Bad pack id ${pack.id}`);
await db.collection<SoundPackDoc>(SOUND_PACKS).updateOne(
  { _id: pack.id },
  {
    $set: { licence: pack.licence, source_url: pack.source_url },
    $setOnInsert: { added_at: new Date() },
  },
  { upsert: true },
);

const done = new Set(
  (
    await sounds
      .find({ pack: pack.id, embedding_model: CLAP_MODEL }, { projection: { _id: 1 } })
      .toArray()
  ).map((d) => d._id),
);
const todo = entries
  .filter((e) => {
    if (!LICENCES.has(e.licence)) {
      process.stderr.write(`skip ${e.id}: licence ${e.licence}\n`);
      return false;
    }
    return !done.has(`${pack.id}-${e.id}`);
  })
  .slice(0, limit);
process.stdout.write(
  `${pack.id}: ${entries.length} sounds, ${done.size} loaded, ${todo.length} to load\n`,
);

/** FFmpeg's ebur128 summary (integrated loudness and true peak) and the length. */
async function measure(
  file: string,
): Promise<{ lufs: number | null; peak: number | null; seconds: number }> {
  const { stderr } = await run(
    BIN.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-i',
      `file:${file}`,
      '-af',
      'ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 10 * 60_000 },
  );
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufs = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1];
  const peak = /True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1];
  const { stdout } = await run(
    BIN.ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', `file:${file}`],
    { timeoutMs: 60_000 },
  );
  const num = (v: string | undefined) => (v && v !== '-inf' ? Number(v) : null);
  return { lufs: num(lufs), peak: num(peak), seconds: Number(stdout.trim()) || 0 };
}

let loaded = 0;
let skipped = 0;
for (let at = 0; at < todo.length; at += BATCH) {
  const batch = todo.slice(at, at + BATCH);
  const ready: Array<{
    entry: Entry;
    flac: string;
    seconds: number;
    channels: number;
    lufs: number | null;
    bytes: number;
  }> = [];
  for (const entry of batch) {
    const source = resolve(base, entry.file);
    if (!source.startsWith(`${base}/`)) throw new Error(`${entry.id}: file outside the pack`);
    const trimmed = join(work, `${entry.id}.trim.wav`);
    const flac = join(work, `${entry.id}.flac`);
    try {
      // Silence off both ends (below -60 dBFS), at most two channels, the longest kept length.
      await run(
        BIN.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          `file:${source}`,
          '-vn',
          '-map',
          '0:a:0',
          '-t',
          String(MOST_SECONDS),
          '-af',
          'silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.05,areverse',
          '-ac',
          '2',
          '-c:a',
          'pcm_f32le',
          '-y',
          trimmed,
        ],
        { timeoutMs: 10 * 60_000 },
      );
      const probe = await run(
        BIN.ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=channels',
          '-of',
          'csv=p=0',
          `file:${source}`,
        ],
        { timeoutMs: 60_000 },
      );
      const channels = Math.min(2, Number(probe.stdout.trim()) || 1);
      const before = await measure(trimmed);
      if (before.seconds < 0.05 || before.peak === null || before.peak < -70) {
        skipped++;
        process.stderr.write(`skip ${entry.id}: silent or empty\n`);
        continue;
      }
      const gain = -1 - before.peak;
      await run(
        BIN.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-i',
          `file:${trimmed}`,
          '-af',
          `volume=${gain.toFixed(2)}dB`,
          '-ac',
          String(channels),
          '-c:a',
          'flac',
          '-sample_fmt',
          's16',
          '-y',
          flac,
        ],
        { timeoutMs: 10 * 60_000 },
      );
      ready.push({
        entry,
        flac,
        seconds: Math.round(before.seconds * 100) / 100,
        channels,
        lufs: before.lufs === null ? null : Math.round((before.lufs + gain) * 10) / 10,
        bytes: (await stat(flac)).size,
      });
    } catch (error) {
      skipped++;
      process.stderr.write(`skip ${entry.id}: ${(error as Error).message.slice(0, 200)}\n`);
    } finally {
      await rm(trimmed, { force: true });
    }
  }
  if (!ready.length) continue;
  const embeddings = await clapSounds(
    ready.map((r) => r.flac),
    { signal: new AbortController().signal },
  );
  for (const [i, r] of ready.entries()) {
    const id = `${pack.id}-${r.entry.id}`;
    const key = `${pack.id}/${r.entry.id}.flac`;
    await s3.send(
      new sdk.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(r.flac),
        ContentLength: r.bytes,
        ContentType: 'audio/flac',
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    await sounds.replaceOne(
      { _id: id },
      {
        name: r.entry.name,
        description: r.entry.description,
        tags: r.entry.tags,
        category: r.entry.category,
        pack: pack.id,
        seconds: r.seconds,
        channels: r.channels,
        loudness_lufs: r.lufs,
        url: `${filesAt}/${key}`,
        licence: r.entry.licence,
        author: r.entry.author,
        source_url: r.entry.source_url,
        key,
        bytes: r.bytes,
        embedding: embeddings[i] as number[],
        embedding_model: CLAP_MODEL,
        added_at: new Date(),
      },
      { upsert: true },
    );
    await rm(r.flac, { force: true });
    loaded++;
  }
  process.stdout.write(
    `${pack.id}: ${loaded} loaded, ${skipped} skipped, ${todo.length - at - batch.length} left\n`,
  );
}
await rm(work, { recursive: true, force: true });
const total = await sounds.countDocuments({ pack: pack.id });
const bytes = await sounds
  .aggregate<{ b: number }>([
    { $match: { pack: pack.id } },
    { $group: { _id: null, b: { $sum: '$bytes' } } },
  ])
  .toArray();
process.stdout.write(
  `${pack.id}: done. ${loaded} loaded, ${skipped} skipped; ${total} sounds, ${((bytes[0]?.b ?? 0) / 1024 ** 3).toFixed(2)} GB in the pack\n`,
);
await mongo.close();
