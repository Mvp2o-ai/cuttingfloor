import { randomBytes } from 'node:crypto';
import { blake3 } from 'hash-wasm';

/** JSON with object keys sorted, so equal documents always hash the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Content address of a timeline document: 128 bits of BLAKE3 over its canonical JSON. */
export async function timelineIdOf(doc: unknown): Promise<string> {
  return `tl_${(await blake3(canonicalJson(doc))).slice(0, 32)}`;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 130 random bits as 26 base32 characters, behind a prefix (`m_`, `j_`). */
export function randomId(prefix: string): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${prefix}${out}`;
}
