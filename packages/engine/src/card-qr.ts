import { writeFile } from 'node:fs/promises';
import QRCode from 'qrcode';

// The QR code on a review copy's cards: it opens the file's release page, where its owner signs in
// and removes the watermark. Dark modules on the cards' warm white, with the cut-square mark on a
// dark badge in the middle (error correction H carries the modules the badge covers). Drawn
// straight to a PPM, which ffmpeg overlays on the card, so no image library is needed.

export type CardShape = 'landscape' | 'portrait' | 'square';

/**
 * Where the code sits on each card, in the card's own pixels (scripts/build-cards.ts draws the
 * warm white tile around it and the caption under it): the square's left, top and side.
 */
export const CARD_QR: Record<CardShape, { x: number; y: number; size: number }> = {
  landscape: { x: 1384, y: 380, size: 320 },
  portrait: { x: 380, y: 1400, size: 320 },
  square: { x: 776, y: 744, size: 220 },
};

const BG = [0x08, 0x0a, 0x09] as const;
const INK = [0xf7, 0xf4, 0xee] as const;
const GREEN = [0x2b, 0xd6, 0x65] as const;

/** Writes the code for `text` as a `size`-pixel square PPM: two modules of quiet zone around it. */
export async function writeCardQr(text: string, size: number, path: string): Promise<void> {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size;
  const quiet = 2;
  const cell = size / (n + 2 * quiet);
  // The badge: about a fifth of the code's side, centred, on whole modules.
  const badge = Math.round(n / 5) | 1;
  const b0 = (n - badge) / 2;
  const pixels = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = x / cell - quiet;
      const my = y / cell - quiet;
      let colour: readonly number[] = INK;
      const inCode = mx >= 0 && my >= 0 && mx < n && my < n;
      if (inCode && mx >= b0 && my >= b0 && mx < b0 + badge && my < b0 + badge) {
        // The mark, as in the brand's 32-unit square: a green triangle top left, an ink one
        // bottom right, on the dark badge.
        const u = ((mx - b0) / badge) * 32;
        const v = ((my - b0) / badge) * 32;
        colour = BG;
        if (u >= 4.4 && v >= 4.4 && u + v <= 28.8) colour = GREEN;
        else if (u <= 27.6 && v <= 27.6 && u + v >= 35.2) colour = INK;
      } else if (inCode && qr.modules.get(Math.floor(my), Math.floor(mx))) {
        colour = BG;
      }
      pixels.set(colour, (y * size + x) * 3);
    }
  }
  await writeFile(path, Buffer.concat([Buffer.from(`P6\n${size} ${size}\n255\n`), pixels]));
}
