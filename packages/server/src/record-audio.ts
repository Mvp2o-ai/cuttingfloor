import { CfError } from '@cuttingfloor/schema';

// The sound files of a record session: WAV read and written exactly (PCM, no encoder in the way,
// so a sample is where it says it is), and the click this server ships, made the same way every
// time from a formula.

export interface Pcm {
  sample_rate: number;
  channels: number;
  /** Frames (samples per channel). */
  frames: number;
  /** One Float32Array per channel, -1 to 1. */
  data: Float32Array[];
}

/** The format of a WAV, from its header: what a take may be. */
export interface WavFormat {
  sample_rate: number;
  channels: number;
  bits: number;
  float: boolean;
  frames: number;
  /** Byte offset and length of the sample data. */
  data: { offset: number; bytes: number };
}

/** Reads a WAV's header (RIFF/WAVE, PCM integer or IEEE float, extensible or not). */
export function wavFormat(buf: Buffer, what = 'The file'): WavFormat {
  const refuse = (why: string) =>
    new CfError('bad_request', `${what} is not a PCM WAV: ${why}`, {
      hint: 'Send the recording as WAV, PCM (16-bit, 48 kHz, mono as recorded), not a compressed format: an encoder adds silence at the start, which moves the take',
    });
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw refuse('no RIFF/WAVE header');
  let at = 12;
  let fmt: Omit<WavFormat, 'frames' | 'data'> | undefined;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    let size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      let tag = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sample_rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID.
      if (tag === 0xfffe && size >= 40) tag = buf.readUInt16LE(body + 24);
      if (tag !== 1 && tag !== 3) throw refuse(`format tag ${tag}`);
      if (tag === 3 && bits !== 32) throw refuse(`${bits}-bit float`);
      if (tag === 1 && ![16, 24, 32].includes(bits)) throw refuse(`${bits}-bit`);
      if (!channels || !sample_rate) throw refuse('no channels or sample rate');
      fmt = { sample_rate, channels, bits, float: tag === 3 };
    } else if (id === 'data') {
      if (!fmt) throw refuse('data before fmt');
      // A recorder that never went back to write the size leaves it 0 or 0xffffffff.
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      const frame = (fmt.bits / 8) * fmt.channels;
      return { ...fmt, frames: Math.floor(size / frame), data: { offset: body, bytes: size } };
    }
    at = body + size + (size % 2);
  }
  throw refuse('no data chunk');
}

/** Reads a WAV's samples. */
export function readWav(buf: Buffer, what?: string): Pcm {
  const f = wavFormat(buf, what);
  const data = Array.from({ length: f.channels }, () => new Float32Array(f.frames));
  const step = f.bits / 8;
  let at = f.data.offset;
  for (let i = 0; i < f.frames; i++) {
    for (let c = 0; c < f.channels; c++) {
      let v: number;
      if (f.float) v = buf.readFloatLE(at);
      else if (f.bits === 16) v = buf.readInt16LE(at) / 32_768;
      else if (f.bits === 24) v = buf.readIntLE(at, 3) / 8_388_608;
      else v = buf.readInt32LE(at) / 2_147_483_648;
      (data[c] as Float32Array)[i] = v;
      at += step;
    }
  }
  return { sample_rate: f.sample_rate, channels: f.channels, frames: f.frames, data };
}

/** Writes PCM 16-bit WAV, `channels` wide (a mono source is copied to each). */
export function wav16(pcm: Pcm, channels = pcm.channels): Buffer {
  const bytes = pcm.frames * channels * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + bytes, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(pcm.sample_rate, 24);
  b.writeUInt32LE(pcm.sample_rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(bytes, 40);
  let at = 44;
  for (let i = 0; i < pcm.frames; i++) {
    for (let c = 0; c < channels; c++) {
      const src = pcm.data[Math.min(c, pcm.channels - 1)] as Float32Array;
      const v = Math.max(-1, Math.min(1, src[i] as number));
      b.writeInt16LE(v < 0 ? Math.round(v * 32_768) : Math.round(v * 32_767), at);
      at += 2;
    }
  }
  return b;
}

/** A WAV as PCM 16-bit stereo at its own rate: as given when it is that already. */
export function asStereo16(buf: Buffer, what?: string): { wav: Buffer; format: WavFormat } {
  const format = wavFormat(buf, what);
  if (!format.float && format.bits === 16 && format.channels === 2) return { wav: buf, format };
  const pcm = readWav(buf, what);
  const wav = wav16(pcm, 2);
  return { wav, format: wavFormat(wav) };
}

/** The mean of a recording's channels. */
export function mono(pcm: Pcm): Float32Array {
  if (pcm.channels === 1) return pcm.data[0] as Float32Array;
  const out = new Float32Array(pcm.frames);
  for (const ch of pcm.data)
    for (let i = 0; i < pcm.frames; i++)
      out[i] = (out[i] as number) + (ch[i] as number) / pcm.channels;
  return out;
}

/**
 * The click: a short burst of a sine, struck at full height and falling away by e every
 * 4 ms, 40 ms long. The accent (bars) is a fifth higher. The same samples every time.
 */
export function clickWav(sampleRate: number, accent: boolean): Buffer {
  const hz = accent ? 1500 : 1000;
  const frames = Math.round(0.04 * sampleRate);
  const data = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    data[i] = 0.7 * Math.exp(-t / 0.004) * Math.sin(2 * Math.PI * hz * t);
  }
  return wav16({ sample_rate: sampleRate, channels: 1, frames, data: [data] }, 2);
}
