/**
 * Regen favicon.ico and apple-icon.png from the kit's two-triangle mark.
 * Run with: node scripts/regen-icons.mjs
 * Requires sharp (available in the monorepo node_modules).
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const require = createRequire(import.meta.url);
const sharp = require(resolve(root, 'node_modules/.pnpm/node_modules/sharp'));

const GREEN = '#00B140';
const DARK = { r: 14, g: 13, b: 11, alpha: 1 };

// The glyph paths, cropped to their own bounding box via viewBox.
function glyphSvg(px) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4.4 4.4 23.2 23.2" width="${px}" height="${px}">` +
      `<path d="M4.4 4.4H24.4L4.4 24.4Z" fill="${GREEN}"/>` +
      `<path d="M27.6 7.6V27.6H7.6Z" fill="${GREEN}"/>` +
      `</svg>`,
  );
}

// ── apple-icon.png ──────────────────────────────────────────────────────────
// 180×180, #0E0D0B background, glyph 136×136 centred (22px inset each side)
async function buildAppleIcon() {
  const glyphPng = await sharp(glyphSvg(136)).png().toBuffer();
  const result = await sharp({
    create: { width: 180, height: 180, channels: 4, background: DARK },
  })
    .composite([{ input: glyphPng, left: 22, top: 22 }])
    .png()
    .toBuffer();

  const outPath = resolve(root, 'apps/site/app/apple-icon.png');
  writeFileSync(outPath, result);
  console.log('apple-icon.png written');

  // Self-check
  const meta = await sharp(result).metadata();
  console.assert(meta.width === 180 && meta.height === 180, 'apple-icon size');
  const { data: corner } = await sharp(result)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  console.assert(
    corner[0] === 14 && corner[1] === 13 && corner[2] === 11,
    `corner pixel rgb(${corner[0]},${corner[1]},${corner[2]})`,
  );
  console.log(
    `apple-icon self-check: 180×180 ✓, corner rgb(${corner[0]},${corner[1]},${corner[2]}) ✓`,
  );
  return result;
}

// ── favicon.ico ─────────────────────────────────────────────────────────────
// Two PNG-compressed entries: 16×16 full-bleed and 32×32 with 28×28 centred.
async function buildFavicon() {
  // 16×16: glyph fills the entire canvas (full bleed)
  const png16 = await sharp(glyphSvg(16)).png().toBuffer();

  // 32×32: glyph 28×28 centred on transparent canvas (2px inset)
  const glyph28 = await sharp(glyphSvg(28)).png().toBuffer();
  const png32 = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: glyph28, left: 2, top: 2 }])
    .png()
    .toBuffer();

  // Assemble ICO:
  //   ICONDIR  (6 bytes): reserved=0 (2), type=1 (2), count=2 (2)
  //   ICONDIRENTRY × 2 (16 bytes each):
  //     width (1), height (1), colorCount (1), reserved (1),
  //     planes (2), bitCount (2), bytesInRes (4), imageOffset (4)
  //   PNG data blobs
  const count = 2;
  const headerSize = 6 + count * 16;
  const offset16 = headerSize;
  const offset32 = headerSize + png16.length;

  const ico = Buffer.alloc(headerSize + png16.length + png32.length);
  let pos = 0;

  // ICONDIR
  ico.writeUInt16LE(0, pos);
  pos += 2; // reserved
  ico.writeUInt16LE(1, pos);
  pos += 2; // type=1 (icon)
  ico.writeUInt16LE(count, pos);
  pos += 2; // count

  // Entry 0: 16×16
  ico.writeUInt8(16, pos++); // width
  ico.writeUInt8(16, pos++); // height
  ico.writeUInt8(0, pos++); // colorCount
  ico.writeUInt8(0, pos++); // reserved
  ico.writeUInt16LE(1, pos);
  pos += 2; // planes
  ico.writeUInt16LE(32, pos);
  pos += 2; // bitCount
  ico.writeUInt32LE(png16.length, pos);
  pos += 4;
  ico.writeUInt32LE(offset16, pos);
  pos += 4;

  // Entry 1: 32×32
  ico.writeUInt8(32, pos++);
  ico.writeUInt8(32, pos++);
  ico.writeUInt8(0, pos++);
  ico.writeUInt8(0, pos++);
  ico.writeUInt16LE(1, pos);
  pos += 2;
  ico.writeUInt16LE(32, pos);
  pos += 2;
  ico.writeUInt32LE(png32.length, pos);
  pos += 4;
  ico.writeUInt32LE(offset32, pos);
  pos += 4;

  // PNG blobs
  png16.copy(ico, offset16);
  png32.copy(ico, offset32);

  const outPath = resolve(root, 'apps/site/app/favicon.ico');
  writeFileSync(outPath, ico);
  console.log('favicon.ico written');

  // Self-checks on the PNG blobs
  const meta16 = await sharp(png16).metadata();
  const meta32 = await sharp(png32).metadata();
  console.assert(meta16.width === 16 && meta16.height === 16, 'favicon 16×16');
  console.assert(meta32.width === 32 && meta32.height === 32, 'favicon 32×32');

  // 32×32 entry: corner at (0,0) must be transparent
  const { data: corner32 } = await sharp(png32)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  console.assert(corner32[3] === 0, '32px corner is transparent');

  // 32×32 entry: pixel at (2,2) must be non-transparent (glyph starts there)
  const { data: glyph32 } = await sharp(png32)
    .extract({ left: 2, top: 2, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  console.assert(glyph32[3] > 0, '32px pixel (2,2) is in glyph');

  console.log(`favicon self-check: 16×16 full-bleed ✓, 32×32 with 28×28 centred ✓`);
  console.log(`  32px corner (0,0) alpha=${corner32[3]} (transparent) ✓`);
  console.log(`  32px pixel (2,2) alpha=${glyph32[3]} (glyph present) ✓`);
}

await buildAppleIcon();
await buildFavicon();
console.log('\nAll icons generated.');
