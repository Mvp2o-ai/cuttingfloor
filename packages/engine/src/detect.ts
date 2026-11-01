import { BIN, run } from './exec.ts';

// Detection with the caller's settings: what counts as quiet or as a cut is theirs to say.

const INPUT = ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file'];

/** Stretches quieter than `thresholdDb` for at least `minSeconds`, in media seconds. */
export async function detectSilences(
  file: string,
  options: { thresholdDb: number; minSeconds: number; duration?: number; signal: AbortSignal },
): Promise<Array<{ start: number; end: number }>> {
  const { stderr } = await run(
    BIN.ffmpeg,
    [
      ...INPUT,
      '-i',
      `file:${file}`,
      '-vn',
      '-af',
      `silencedetect=n=${options.thresholdDb}dB:d=${options.minSeconds}`,
      '-f',
      'null',
      '-',
    ],
    { signal: options.signal },
  );
  const silences: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    if (e && open !== null) {
      silences.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null && options.duration) silences.push({ start: open, end: options.duration });
  return silences;
}

/**
 * Times where the picture changes by more than `threshold`, with each one's score (FFmpeg
 * scdet: the mean absolute difference from the frame before, in percent of full range, less
 * the difference just before it). Hard cuts between ordinary shots score about 10–30.
 */
export async function detectScenes(
  file: string,
  options: { threshold: number; signal: AbortSignal },
): Promise<Array<{ time: number; score: number }>> {
  const { stderr } = await run(
    BIN.ffmpeg,
    [
      ...INPUT,
      '-i',
      `file:${file}`,
      '-an',
      '-vf',
      `scdet=threshold=${options.threshold}`,
      '-f',
      'null',
      '-',
    ],
    { signal: options.signal },
  );
  // scdet logs each cut as "lavfi.scd.score: 22.793, lavfi.scd.time: 4".
  const cuts = [...stderr.matchAll(/lavfi\.scd\.score: ([\d.]+), lavfi\.scd\.time: ([\d.]+)/g)].map(
    (m) => ({ time: Number(m[2]), score: Math.round(Number(m[1]) * 100) / 100 }),
  );
  return cuts;
}
