import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beatsToSeconds, secondsToBeats } from '@cuttingfloor/core';
import type { ScoreDoc } from '@cuttingfloor/schema';
import type { RenderScoreDoc } from '@cuttingfloor/server';

// A stand-in for the score engine, for score.record's tests: a real WAV (PCM 16-bit stereo at
// the score's rate) of a click on every beat of the document it is given, each beat a different
// pitch so a stretch of it is found in one place only, and for a pad (one part, with a tail) a
// tone at the note's pitch. Renders at the document's own tempo map, so a copy at a speed
// renders at that speed.

export interface StubCall {
  from_seconds: number;
  until_seconds: number;
  parts?: string[];
  tail_db?: number;
  tempo: number[];
}

/** Seconds the stub's pads ring past their note. */
export const STUB_TAIL = 0.05;

export function stubRenderer(calls: StubCall[] = []): RenderScoreDoc {
  return async (_owner, doc: ScoreDoc, opts) => {
    calls.push({
      from_seconds: opts.from_seconds,
      until_seconds: opts.until_seconds,
      ...(opts.parts ? { parts: opts.parts } : {}),
      ...(opts.tail_db !== undefined ? { tail_db: opts.tail_db } : {}),
      tempo: doc.tempo.map((t) => t.bpm),
    });
    const rate = doc.sample_rate;
    const pad = opts.parts !== undefined && opts.tail_db !== undefined;
    const seconds = opts.until_seconds - opts.from_seconds + (pad ? STUB_TAIL : 0);
    const frames = Math.round(seconds * rate);
    const data = new Float32Array(frames);
    if (pad) {
      const note = Object.values(doc.sources)[0]?.notes[0];
      const hz = 440 * 2 ** (((note?.pitch ?? 69) - 69) / 12);
      for (let i = 0; i < frames; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
    } else {
      const first = Math.ceil(secondsToBeats(doc.tempo, opts.from_seconds) - 1e-9);
      for (let b = first; ; b++) {
        const at = beatsToSeconds(doc.tempo, b) - opts.from_seconds;
        if (at >= seconds) break;
        const hz = 400 + 150 * (((b % 8) + 8) % 8);
        const start = Math.round(at * rate);
        for (let i = 0; i < Math.round(0.03 * rate) && start + i < frames; i++) {
          const t = i / rate;
          data[start + i] = 0.8 * Math.exp(-t / 0.008) * Math.sin(2 * Math.PI * hz * t);
        }
      }
    }
    const dir = await mkdtemp(join(tmpdir(), 'cf-stub-render-'));
    const file = join(dir, 'render.wav');
    await writeFile(file, stereoWav(data, rate));
    return {
      wav: file,
      sample_rate: rate,
      frames,
      parts_sounded: opts.parts ?? doc.parts.map((p) => p.id),
      done: () => rm(dir, { recursive: true, force: true }),
    };
  };
}

/** PCM 16-bit WAV of one channel, `channels` wide. */
export function stereoWav(data: Float32Array, rate: number, channels = 2): Buffer {
  const bytes = data.length * 2 * channels;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(Math.max(-1, Math.min(1, data[i] as number)) * 32_767);
    for (let c = 0; c < channels; c++) b.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return b;
}

/** A WAV's samples as one channel of floats (the first), and its header facts. */
export function readMono(buf: Buffer): {
  rate: number;
  channels: number;
  bits: number;
  data: Float32Array;
} {
  const rate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bits = buf.readUInt16LE(34);
  const n = buf.readUInt32LE(40) / (2 * channels);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = buf.readInt16LE(44 + i * 2 * channels) / 32_768;
  return { rate, channels, bits, data };
}
