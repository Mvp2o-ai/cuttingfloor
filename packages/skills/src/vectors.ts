import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { EMBED_MODEL, type Embedder } from './embed.ts';
import type { Skill } from './library.ts';

// The skills' vectors, computed when the image is built (scripts/write-vectors.ts) and shipped
// in it as one JSON file, so a server embeds only the query. Each vector carries a hash of the
// text it embeds: one whose skill has changed since is ignored and recomputed in memory.

/** packages/skills/vectors.json; git-ignored, written per build. */
export const vectorsFile = (): string =>
  process.env.CUTTINGFLOOR_SKILLS_VECTORS ??
  join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors.json');

export interface StoredVector {
  /** SHA-256 of the embedded text (contractText). */
  hash: string;
  vector: Float32Array;
}

const VectorsFile = z.object({
  model: z.string(),
  dimensions: z.number().int().positive(),
  /** By slug. The vector is little-endian float32, base64: exact, and a quarter of the size. */
  skills: z.record(z.string(), z.object({ hash: z.string(), vector: z.string() })),
});

/** What a skill is for, embedded: its name in words, then its description. */
export const contractText = (s: Pick<Skill, 'name' | 'description'>): string =>
  `${s.name.replace(/-/g, ' ')}. ${s.description}`;

export const textHash = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function encode(v: Float32Array): string {
  const bytes = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) bytes.writeFloatLE(v[i] as number, i * 4);
  return bytes.toString('base64');
}

function decode(b64: string, dimensions: number): Float32Array | null {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.byteLength !== dimensions * 4) return null;
  const v = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) v[i] = bytes.readFloatLE(i * 4);
  return v;
}

/** Embeds every skill's contract and writes the file. Returns how many it wrote. */
export async function writeVectors(
  skills: Skill[],
  embedder: Embedder,
  file: string = vectorsFile(),
): Promise<number> {
  const texts = skills.map(contractText);
  const vectors = await embedder.embed(texts);
  const dimensions = vectors[0]?.length ?? 0;
  const out: z.infer<typeof VectorsFile> = { model: EMBED_MODEL, dimensions, skills: {} };
  for (const [i, skill] of skills.entries()) {
    const vector = vectors[i] as Float32Array;
    if (vector.length !== dimensions) throw new Error(`${skill.slug}: vector length differs`);
    out.skills[skill.slug] = { hash: textHash(texts[i] as string), vector: encode(vector) };
  }
  await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
  return skills.length;
}

/**
 * The stored vectors by slug; empty when the file is missing, unreadable or from another model.
 * Whether one still fits its skill is the caller's check (the hash).
 */
export function readVectors(file: string = vectorsFile()): Map<string, StoredVector> {
  const out = new Map<string, StoredVector>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  const parsed = VectorsFile.safeParse(raw);
  if (!parsed.success || parsed.data.model !== EMBED_MODEL) return out;
  for (const [slug, { hash, vector }] of Object.entries(parsed.data.skills)) {
    const v = decode(vector, parsed.data.dimensions);
    if (v) out.set(slug, { hash, vector: v });
  }
  return out;
}
