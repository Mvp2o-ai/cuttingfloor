// Loads a pack into the sound library (packages/server/src/sound-library.ts): each sound's file,
// exactly as its pack published it, goes to the public sounds bucket; its length, channels,
// loudness and true peak are measured, it is embedded with CLAP's audio encoder, and it is
// recorded in MongoDB. Run in the cuttingfloor
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
import { extname, join, resolve } from 'node:path';
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
const BATCH = 64;
/** Sounds prepared, and stored, at once (CUTTINGFLOOR_SOUNDS_JOBS). */
const JOBS = Math.max(1, Number(process.env.CUTTINGFLOOR_SOUNDS_JOBS) || 4);
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
      '-t',
      String(MOST_SECONDS),
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

interface Ready {
  entry: Entry;
  file: string;
  seconds: number;
  channels: number;
  lufs: number | null;
  peak: number;
  bytes: number;
}

/** Audio types by extension, for the bucket. */
const TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
};

/** Runs the tasks, at most `jobs` at once; results in their order. */
async function pool<T>(tasks: Array<() => Promise<T>>, jobs: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await (tasks[i] as () => Promise<T>)();
      }
    }),
  );
  return out;
}

let loaded = 0;
let skipped = 0;

/**
 * One sound as its pack published it: its length, channels, loudness and true peak measured,
 * the file itself untouched. Undefined when it holds no sound.
 */
async function prepare(entry: Entry): Promise<Ready | undefined> {
  const file = resolve(base, entry.file);
  if (!file.startsWith(`${base}/`)) throw new Error(`${entry.id}: file outside the pack`);
  try {
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
        `file:${file}`,
      ],
      { timeoutMs: 60_000 },
    );
    const channels = Number(probe.stdout.trim()) || 1;
    const facts = await measure(file);
    if (facts.seconds <= 0 || facts.peak === null) {
      skipped++;
      process.stderr.write(`skip ${entry.id}: no sound in it\n`);
      return undefined;
    }
    return {
      entry,
      file,
      seconds: Math.round(facts.seconds * 100) / 100,
      channels,
      // Integrated loudness needs 0.4 s of sound; FFmpeg reports its floor, -70, for less.
      lufs: facts.lufs === null || facts.lufs <= -70 ? null : Math.round(facts.lufs * 10) / 10,
      peak: Math.round(facts.peak * 10) / 10,
      bytes: (await stat(file)).size,
    };
  } catch (error) {
    skipped++;
    process.stderr.write(`skip ${entry.id}: ${(error as Error).message.slice(0, 200)}\n`);
    return undefined;
  }
}

const prepareBatch = async (batch: Entry[]) =>
  (
    await pool(
      batch.map((e) => () => prepare(e)),
      JOBS,
    )
  ).filter((r): r is Ready => !!r);

// While one batch is embedded and stored, the next is prepared.
let preparing = prepareBatch(todo.slice(0, BATCH));
for (let at = 0; at < todo.length; at += BATCH) {
  const ready = await preparing;
  preparing = prepareBatch(todo.slice(at + BATCH, at + 2 * BATCH));
  if (!ready.length) continue;
  const embeddings = await clapSounds(
    ready.map((r) => r.file),
    { signal: new AbortController().signal },
  );
  await pool(
    ready.map((r, i) => async () => {
      const id = `${pack.id}-${r.entry.id}`;
      const ext = extname(r.file).toLowerCase();
      const key = `${pack.id}/${r.entry.id}${ext}`;
      await s3.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(r.file),
          ContentLength: r.bytes,
          ContentType: TYPES[ext] ?? 'application/octet-stream',
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
          peak_dbtp: r.peak,
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
      loaded++;
    }),
    JOBS,
  );
  process.stdout.write(
    `${pack.id}: ${loaded} loaded, ${skipped} skipped, ${Math.max(0, todo.length - at - BATCH)} left\n`,
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
