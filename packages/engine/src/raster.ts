import { crc32, deflateSync } from 'node:zlib';

// Pictures drawn in this process: an 8-bit RGB buffer, rectangles, and text in a 5×7 pixel font
// held here, so a chart needs no image library, no font file and no host dependency. PNG is
// written here (zlib): lossless, so a picture's colours read back as drawn.

export type Rgb = readonly [number, number, number];

export interface Raster {
  width: number;
  height: number;
  /** RGB, 3 bytes a pixel, rows top to bottom. */
  data: Uint8Array;
}

export function newRaster(width: number, height: number, fill: Rgb): Raster {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
  }
  return { width, height, data };
}

/** One pixel's RGB. */
export function pixelAt(img: Raster, x: number, y: number): Rgb {
  const i = (y * img.width + x) * 3;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

/** Paints a pixel, mixed over what is there by `alpha` (0–1). Off the picture: nothing. */
export function plot(img: Raster, x: number, y: number, c: Rgb, alpha = 1): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 3;
  const d = img.data;
  if (alpha >= 1) {
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    return;
  }
  d[i] = Math.round((d[i] ?? 0) + (c[0] - (d[i] ?? 0)) * alpha);
  d[i + 1] = Math.round((d[i + 1] ?? 0) + (c[1] - (d[i + 1] ?? 0)) * alpha);
  d[i + 2] = Math.round((d[i + 2] ?? 0) + (c[2] - (d[i + 2] ?? 0)) * alpha);
}

/** A filled rectangle (whole pixels, clipped to the picture). */
export function fillRect(
  img: Raster,
  x: number,
  y: number,
  w: number,
  h: number,
  c: Rgb,
  alpha = 1,
): void {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(img.width, Math.round(x + w));
  const y1 = Math.min(img.height, Math.round(y + h));
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) plot(img, px, py, c, alpha);
}

// Printable ASCII from space to ~, 7 rows each of 5 bits (left pixel is the high bit), packed in
// base 32. Anything else draws as a hollow box.
const FONT =
  '00000004444404aaa0000aavavaa4fke5u4op248j3cik8lid44800002488842842224804lel40044v4400000c48000v00000000cc01248g0ehjlphe4c4444eeh1248vv2421he26aiv22vgu11he68guhhev124888ehhehheehhf12c0cc0cc00cc0c48248g84200v0v008421248eh12404eh1dlleehhvhhhuhhuhhuehggghesihhhisvgguggvvggugggehgnhhfhhhvhhhe44444e72222ichikokihggggggvhrllhhhhhpljhhehhhhheuhhugggehhhliduhhukihfgge11uv444444hhhhhhehhhhha4hhhlllahha4ahhhhha444v1248gve88888e0g84210e22222e4ah0000000000v842000000e1fhfggmphhu00egghe11djhhf00ehvge698s8880fhhf1eggmphhh40c444e20622icggikokic44444e00qllhh00mphhh00ehhhe00uhugg00djf1100mpggg00ege1u88s889600hhhjd00hhha400hhlla00ha4ah00hhf1e00v248v244844244444448442448008l200';
const BOX = [31, 17, 17, 17, 17, 17, 31];

function glyph(ch: string): number[] {
  const code = ch.charCodeAt(0);
  if (code < 32 || code > 126) return BOX;
  const at = (code - 32) * 7;
  return Array.from({ length: 7 }, (_, r) => Number.parseInt(FONT[at + r] ?? '0', 32));
}

/** Text size at a scale: 6 pixels a character across (one of them space) and 7 high, times scale. */
export function textWidth(text: string, scale: number): number {
  return Math.max(0, [...text].length * 6 - 1) * scale;
}

export function textHeight(scale: number): number {
  return 7 * scale;
}

/** Draws text with its top-left corner at (x, y). */
export function drawText(img: Raster, x: number, y: number, text: string, c: Rgb, scale = 1): void {
  let cx = Math.round(x);
  const top = Math.round(y);
  for (const ch of text) {
    const rows = glyph(ch);
    for (let r = 0; r < 7; r++) {
      const bits = rows[r] ?? 0;
      for (let col = 0; col < 5; col++) {
        if (bits & (16 >> col)) fillRect(img, cx + col * scale, top + r * scale, scale, scale, c);
      }
    }
    cx += 6 * scale;
  }
}

/** The picture as a PNG (8-bit RGB). */
export function encodePng(img: Raster): Buffer {
  const { width, height, data } = img;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter "up" on every row but the first: flat charts pack far smaller.
    const out = y * (stride + 1);
    raw[out] = y ? 2 : 0;
    for (let i = 0; i < stride; i++) {
      const v = data[y * stride + i] ?? 0;
      raw[out + 1 + i] = y ? (v - (data[(y - 1) * stride + i] ?? 0)) & 0xff : v;
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
