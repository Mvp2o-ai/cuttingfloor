import { readFile } from 'node:fs/promises';
import { CfError } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';

// Advance widths from a font file (TrueType or OpenType: its cmap and hmtx tables), so text can
// be broken into lines here, by the font it renders in. Kerning is left out, which measures a
// line a little wider than libass sets it, never narrower in practice, so a line laid out here
// fits where it is put.

/** Width of a string in ems (multiply by the font size in pixels). */
export type Measure = (text: string) => number;

/** Reads a font file's character widths. */
export function fontMeasure(buf: Buffer): Measure {
  let base = 0;
  // A collection: its first font.
  if (buf.toString('latin1', 0, 4) === 'ttcf') base = buf.readUInt32BE(12);
  const numTables = buf.readUInt16BE(base + 4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    tables.set(buf.toString('latin1', rec, rec + 4), buf.readUInt32BE(rec + 8));
  }
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const cmap = tables.get('cmap');
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) {
    throw new CfError('render_failed', 'The font has no character widths (cmap or hmtx missing)');
  }
  const unitsPerEm = buf.readUInt16BE(head + 18) || 1000;
  const metrics = buf.readUInt16BE(hhea + 34);
  const advance = (glyph: number) =>
    buf.readUInt16BE(hmtx + 4 * Math.min(glyph, Math.max(0, metrics - 1)));
  const glyphOf = charMap(buf, cmap);
  const cache = new Map<number, number>();
  return (text) => {
    let units = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      let w = cache.get(cp);
      if (w === undefined) {
        w = advance(glyphOf(cp));
        cache.set(cp, w);
      }
      units += w;
    }
    return units / unitsPerEm;
  };
}

/** The character to glyph lookup: a Unicode format 12 subtable, else format 4. */
function charMap(buf: Buffer, cmap: number): (cp: number) => number {
  const n = buf.readUInt16BE(cmap + 2);
  let best: { offset: number; format: number } | undefined;
  for (let i = 0; i < n; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = cmap + buf.readUInt32BE(rec + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = buf.readUInt16BE(offset);
    if (format === 12 && best?.format !== 12) best = { offset, format };
    else if (format === 4 && !best) best = { offset, format };
  }
  if (!best) return () => 0;
  const t = best.offset;
  if (best.format === 12) {
    const groups = buf.readUInt32BE(t + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = t + 16 + mid * 12;
        const start = buf.readUInt32BE(g);
        const end = buf.readUInt32BE(g + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return buf.readUInt32BE(g + 8) + (cp - start);
      }
      return 0;
    };
  }
  const segs = buf.readUInt16BE(t + 6) / 2;
  const ends = t + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let s = 0; s < segs; s++) {
      if (cp > buf.readUInt16BE(ends + s * 2)) continue;
      const start = buf.readUInt16BE(starts + s * 2);
      if (cp < start) return 0;
      const delta = buf.readInt16BE(deltas + s * 2);
      const range = buf.readUInt16BE(ranges + s * 2);
      if (!range) return (cp + delta) & 0xffff;
      const at = ranges + s * 2 + range + (cp - start) * 2;
      const glyph = buf.readUInt16BE(at);
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
}

export interface Face {
  family: string;
  bold: boolean;
  italic: boolean;
  /** An imported font's file, which fontconfig doesn't know. */
  file?: string | undefined;
}

export const faceKey = (f: Face) => `${f.family}|${f.bold ? 'b' : ''}|${f.italic ? 'i' : ''}`;

const loaded = new Map<string, Promise<Measure>>();

/** The widths of a face: an imported font's own file, or the file fontconfig picks. */
export function loadFace(face: Face): Promise<Measure> {
  const key = face.file ? `file:${face.file}` : faceKey(face);
  let got = loaded.get(key);
  if (!got) {
    got = (async () => {
      const file =
        face.file ??
        (
          await run(
            BIN.fcMatch,
            [
              '-f',
              '%{file}',
              `${face.family}:weight=${face.bold ? 200 : 80}:slant=${face.italic ? 100 : 0}`,
            ],
            { timeoutMs: 30_000 },
          )
        ).stdout.trim();
      return fontMeasure(await readFile(file));
    })();
    got.catch(() => loaded.delete(key));
    loaded.set(key, got);
  }
  return got;
}
