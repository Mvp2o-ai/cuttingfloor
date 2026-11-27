// A spectrogram drawn in a process of its own (spectrogram.ts starts it), so the transform's
// seconds of arithmetic never hold up the server.
//
//   node spectrogram-worker.ts <job json> <out.png>
//     job: {file, start, from, until, longEdge, grid}: the file's sound from `start` seconds is
//     read (with spectrogramPad() either side of [from, until) where the file has it), drawn,
//     and written as a PNG. stdout: one JSON line, the picture's size, layout, bars and peak.

import { writeFile } from 'node:fs/promises';
import { encodePng } from './raster.ts';
import type { Grid } from './sound-axes.ts';
import { decodeMono, drawSpectrogram, spectrogramPad } from './spectrogram.ts';

const [jobText, out] = process.argv.slice(2);
if (!jobText || !out) {
  process.stderr.write('usage: spectrogram-worker.ts <job json> <out.png>\n');
  process.exit(2);
}
const job = JSON.parse(jobText) as {
  file: string;
  start: number;
  from: number;
  until: number;
  longEdge: number;
  grid: Grid | null;
};
const pad = spectrogramPad();
// The file's own time is `start` at its first sample; read from a little before the range.
const readFrom = Math.max(job.start, job.from - pad);
const samples = await decodeMono(job.file, readFrom - job.start, job.until + pad - job.start);
const s = drawSpectrogram(samples, readFrom, {
  from: job.from,
  until: job.until,
  longEdge: job.longEdge,
  grid: job.grid,
});
await writeFile(out, encodePng(s.image));
process.stdout.write(
  `${JSON.stringify({
    width: s.image.width,
    height: s.image.height,
    layout: s.layout,
    bars: s.bars,
    beatLines: s.beatLines,
    peakDb: Number.isFinite(s.peakDb) ? s.peakDb : null,
  })}\n`,
);
