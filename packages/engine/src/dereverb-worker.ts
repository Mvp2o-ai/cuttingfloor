// Room echo removal over a whole file, in a subprocess of its own (sourcepass.ts starts it) so
// the work never sits on the server's thread and a cancel can kill it.
//
//   node dereverb-worker.ts <in.f32> <out.f32> <channels> <rate> <taps> <mix>
//
// Sound is raw 32-bit float, interleaved. The file is worked through in stretches of 20 s, each
// with a second of sound either side for the prediction to start from, crossfaded into the next
// over a quarter second. Progress goes to stderr as "progress <0–1>".

import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { DEREVERB_STFT, dereverbChannel } from './dereverb.ts';

const [input, output, channelsArg, rateArg, tapsArg, mixArg] = process.argv.slice(2);
const channels = Number(channelsArg);
const rate = Number(rateArg);
const options = { ...DEREVERB_STFT, taps: Number(tapsArg), iterations: 3, mix: Number(mixArg) };

const inFd = openSync(input as string, 'r');
const outFd = openSync(output as string, 'w');
const total = Math.floor(fstatSync(inFd).size / 4 / channels);
const STRETCH = 20 * rate;
const PAD = rate;
const FADE = Math.round(rate / 4);
const HALF = FADE / 2;

/** Samples [from, to) of every channel, zero outside the file. */
function read(from: number, to: number): Float32Array[] {
  const a = Math.max(0, from);
  const b = Math.min(total, to);
  const out = Array.from({ length: channels }, () => new Float32Array(to - from));
  if (b <= a) return out;
  const buf = Buffer.alloc((b - a) * channels * 4);
  readSync(inFd, buf, 0, buf.length, a * channels * 4);
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  for (let i = 0; i < b - a; i++)
    for (let c = 0; c < channels; c++)
      (out[c] as Float32Array)[a - from + i] = data[i * channels + c] as number;
  return out;
}

function write(parts: Float32Array[], from: number, to: number): void {
  const n = to - from;
  if (n <= 0) return;
  const data = new Float32Array(n * channels);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < channels; c++)
      data[i * channels + c] = (parts[c] as Float32Array)[from + i] as number;
  writeSync(outFd, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

// Each stretch's output is weighted by a trapezoid that rises over the quarter second centred
// on its start and falls over the one centred on its end, so neighbours sum to the whole.
let carry: Float32Array[] | null = null;
for (let s0 = 0; s0 < total; s0 += STRETCH) {
  const s1 = Math.min(total, s0 + STRETCH);
  const last = s1 >= total;
  const from = s0 - PAD;
  const sound = read(from, s1 + PAD);
  // Mono sound carried on both sides (the usual voice recording) is worked out once.
  const first = sound[0] as Float32Array;
  const same = sound.every((x) => x.every((v, i) => v === first[i]));
  const once = same ? dereverbChannel(first, options) : undefined;
  const cleaned = sound.map((x) => once ?? dereverbChannel(x, options));
  // The part this stretch writes: from HALF before s0 (after the first) to HALF before s1.
  const a = s0 === 0 ? 0 : s0 - HALF;
  const b = last ? s1 : s1 + HALF;
  const parts = cleaned.map((y) => {
    const out = new Float32Array(b - a);
    for (let t = a; t < b; t++) {
      let g = 1;
      if (s0 > 0 && t < s0 + HALF) g = (t - (s0 - HALF) + 0.5) / FADE;
      if (!last && t >= s1 - HALF) g = Math.min(g, (s1 + HALF - t - 0.5) / FADE);
      out[t - a] = (y[t - from] as number) * g;
    }
    return out;
  });
  if (carry)
    for (let c = 0; c < channels; c++) {
      const p = parts[c] as Float32Array;
      const k = carry[c] as Float32Array;
      for (let i = 0; i < k.length; i++) p[i] = (p[i] as number) + (k[i] as number);
    }
  const keep = last ? 0 : FADE;
  write(parts, 0, parts[0] ? (parts[0] as Float32Array).length - keep : 0);
  carry = last ? null : parts.map((p) => p.slice(p.length - keep));
  process.stderr.write(`progress ${(s1 / total).toFixed(3)}\n`);
}
closeSync(inFd);
closeSync(outFd);
