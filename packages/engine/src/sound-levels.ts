import { BIN, run } from './exec.ts';

/**
 * A sound file's integrated loudness and true peak (FFmpeg's EBU R128 meter) over its first
 * `seconds`. Null where it can't say: loudness needs 0.4 s of sound (FFmpeg reports its floor,
 * -70, for less), and silence has no peak.
 */
export async function soundLevels(
  file: string,
  options: { seconds: number; signal?: AbortSignal },
): Promise<{ loudness_lufs: number | null; peak_dbtp: number | null }> {
  const { stderr } = await run(
    BIN.ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-nostats',
      '-protocol_whitelist',
      'file',
      '-t',
      String(options.seconds),
      '-i',
      `file:${file}`,
      '-map',
      '0:a:0',
      '-af',
      'ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 5 * 60_000, ...(options.signal ? { signal: options.signal } : {}) },
  );
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const num = (v: string | undefined) => (v && v !== '-inf' ? Number(v) : null);
  const lufs = num(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]);
  const peak = num(/True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1]);
  return {
    loudness_lufs: lufs === null || lufs <= -70 ? null : Math.round(lufs * 10) / 10,
    peak_dbtp: peak === null ? null : Math.round(peak * 10) / 10,
  };
}
