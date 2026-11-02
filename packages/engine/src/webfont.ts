import { open, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { CfError } from '@cuttingfloor/schema';
import { decompress as woff2Decompress } from 'wawoff2';

// Web fonts (WOFF, WOFF2) are TrueType or OpenType fonts packed for the web. libass and
// fontconfig read only the unpacked kind, so an imported web font is unpacked to its .ttf or
// .otf on import and used as that.

const MAX_FONT_BYTES = 64 * 1024 * 1024;
const WOFF = 0x774f4646; // 'wOFF'
const WOFF2 = 0x774f4632; // 'wOF2'
const OTTO = 0x4f54544f; // CFF outlines: .otf

/**
 * When `path` is a WOFF or WOFF2 font, writes the font it packs into `dir` (font.ttf or
 * font.otf) and returns that path; removes `path` when it is a copy inside `dir`. Undefined for
 * any other file.
 */
export async function unwrapWebFont(path: string, dir: string): Promise<string | undefined> {
  // One open file for the check and the read, so the bytes read are the bytes checked.
  const handle = await open(path, 'r');
  let magic: number;
  let packed: Buffer;
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    if (bytesRead < 4) return undefined;
    magic = head.readUInt32BE(0);
    if (magic !== WOFF && magic !== WOFF2) return undefined;
    if ((await handle.stat()).size > MAX_FONT_BYTES) {
      throw new CfError('limit_exceeded', 'Font files are limited to 64 MB');
    }
    packed = await handle.readFile();
  } finally {
    await handle.close();
  }
  let font: Buffer;
  try {
    font = magic === WOFF ? unwoff(packed) : Buffer.from(await woff2Decompress(packed));
  } catch (error) {
    if (error instanceof CfError) throw error;
    throw new CfError(
      'bad_request',
      `The ${magic === WOFF ? 'WOFF' : 'WOFF2'} font could not be unpacked`,
      { hint: 'Import the .ttf or .otf of the font instead' },
    );
  }
  if (font.length < 12 || font.length > MAX_FONT_BYTES) {
    throw new CfError('bad_request', 'The web font holds no usable font', {
      hint: 'Import the .ttf or .otf of the font instead',
    });
  }
  const out = join(dir, font.readUInt32BE(0) === OTTO ? 'font.otf' : 'font.ttf');
  await writeFile(out, font);
  if (path.startsWith(dir + sep)) await rm(path, { force: true });
  return out;
}

/** WOFF 1.0: a table directory over zlib-compressed tables, back to the sfnt it packs. */
function unwoff(w: Buffer): Buffer {
  const bad = () =>
    new CfError('bad_request', 'The WOFF font is damaged', {
      hint: 'Import the .ttf or .otf of the font instead',
    });
  if (w.length < 44) throw bad();
  const flavor = w.readUInt32BE(4);
  const count = w.readUInt16BE(12);
  if (!count || 44 + count * 20 > w.length) throw bad();
  const tables: Array<{ tag: number; checksum: number; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    const at = 44 + i * 20;
    const tag = w.readUInt32BE(at);
    const offset = w.readUInt32BE(at + 4);
    const compLength = w.readUInt32BE(at + 8);
    const origLength = w.readUInt32BE(at + 12);
    const checksum = w.readUInt32BE(at + 16);
    if (offset + compLength > w.length || origLength > MAX_FONT_BYTES) throw bad();
    const raw = w.subarray(offset, offset + compLength);
    const data =
      compLength < origLength
        ? inflateSync(raw, { maxOutputLength: origLength })
        : Buffer.from(raw);
    if (data.length !== origLength) throw bad();
    tables.push({ tag, checksum, data });
  }
  tables.sort((a, b) => a.tag - b.tag);
  const pad = (n: number) => (n + 3) & ~3;
  const headerLength = 12 + 16 * count;
  const total = headerLength + tables.reduce((n, t) => n + pad(t.data.length), 0);
  const out = Buffer.alloc(total);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= count) {
    pow *= 2;
    log += 1;
  }
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(count, 4);
  out.writeUInt16BE(pow * 16, 6);
  out.writeUInt16BE(log, 8);
  out.writeUInt16BE(count * 16 - pow * 16, 10);
  let offset = headerLength;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    out.writeUInt32BE(t.tag, rec);
    out.writeUInt32BE(t.checksum, rec + 4);
    out.writeUInt32BE(offset, rec + 8);
    out.writeUInt32BE(t.data.length, rec + 12);
    t.data.copy(out, offset);
    offset += pad(t.data.length);
  });
  return out;
}
