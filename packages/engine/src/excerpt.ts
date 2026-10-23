import { BIN, run } from './exec.ts';

// Pieces of media cut out for a provider: a span of picture as H.264 (upright, no sound) or a
// span of sound as WAV. Frame-accurate: the input is decoded from the start of the span.

export interface Span {
  start: number;
  end: number;
}

const INPUT = ['-hide_banner', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-y'];

const spanArgs = (span: Span | undefined) =>
  span ? ['-ss', span.start.toFixed(6), '-t', (span.end - span.start).toFixed(6)] : [];

/** The picture of `src` (over `span`, in seconds) as an H.264 MP4 without sound. */
export async function excerptPicture(
  src: string,
  dest: string,
  span?: Span,
  signal?: AbortSignal,
): Promise<void> {
  await run(
    BIN.ffmpeg,
    [
      ...INPUT,
      '-i',
      `file:${src}`,
      ...spanArgs(span),
      '-map',
      '0:v:0',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      dest,
    ],
    { heavy: true, ...(signal ? { signal } : {}) },
  );
}

/** The sound of `src` (over `span`, in seconds) as 16-bit WAV. */
export async function excerptSound(
  src: string,
  dest: string,
  span?: Span,
  signal?: AbortSignal,
): Promise<void> {
  await run(
    BIN.ffmpeg,
    [
      ...INPUT,
      '-i',
      `file:${src}`,
      ...spanArgs(span),
      '-map',
      '0:a:0',
      '-vn',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '48000',
      dest,
    ],
    signal ? { signal } : {},
  );
}
