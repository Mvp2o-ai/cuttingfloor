// Rebuild favicon.ico and apple-icon.png from the mark in public/logos/cuttingfloor-mark.svg.
// Run with: node scripts/regen-icons.ts
// Every check runs before anything is written; a failed check exits non-zero and writes nothing.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const app = resolve(root, 'apps/site/app');
const DARK = { r: 14, g: 13, b: 11, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

// The mark, cropped to the glyph's own bounds (4.4..27.6) so it fills the size asked for.
const mark = readFileSync(resolve(root, 'apps/site/public/logos/cuttingfloor-mark.svg'), 'utf8');
const glyph = (px: number) =>
  Buffer.from(
    mark
      .replace(/viewBox="[^"]*"/, 'viewBox="4.4 4.4 23.2 23.2"')
      .replace(/width="\d+"/, `width="${px}"`)
      .replace(/height="\d+"/, `height="${px}"`),
  );

async function onCanvas(size: number, inset: number, background: typeof DARK) {
  const inner = await sharp(glyph(size - inset * 2))
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: inner, left: inset, top: inset }])
    .png()
    .toBuffer();
}

async function pixel(png: Buffer, x: number, y: number) {
  return sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer();
}

async function size(png: Buffer) {
  const { width, height } = await sharp(png).metadata();
  return [width, height];
}

// An ICO of PNG entries: ICONDIR, one 16-byte ICONDIRENTRY per image, then the PNGs.
function ico(entries: { px: number; png: Buffer }[]) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ px, png }, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(px, at);
    header.writeUInt8(px, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

// apple-icon: 180×180 on the dark ground, glyph 136×136 centred.
const apple = await onCanvas(180, 22, DARK);
assert.deepEqual(await size(apple), [180, 180]);
assert.deepEqual(
  [...(await pixel(apple, 0, 0))].slice(0, 3),
  [14, 13, 11],
  'apple-icon corner is the dark ground',
);

// favicon: 16×16 full bleed, and 32×32 with the glyph 28×28 centred on transparency.
const png16 = await sharp(glyph(16)).png().toBuffer();
const png32 = await onCanvas(32, 2, CLEAR);
assert.deepEqual(await size(png16), [16, 16]);
assert.deepEqual(await size(png32), [32, 32]);
assert.equal((await pixel(png32, 0, 0))[3], 0, '32px corner is transparent');
assert.ok((await pixel(png32, 2, 2))[3] > 0, '32px glyph starts at (2,2)');

writeFileSync(resolve(app, 'apple-icon.png'), apple);
writeFileSync(
  resolve(app, 'favicon.ico'),
  ico([
    { px: 16, png: png16 },
    { px: 32, png: png32 },
  ]),
);
console.log('apple-icon.png and favicon.ico written');
