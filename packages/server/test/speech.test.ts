import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { W2V_LABELS } from '@cuttingfloor/engine';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

// Speech and sound facts end to end through the SDK client: speech spans, aligned transcript
// words, loudness, sync offset, timeline sources, qa.check cut facts, and the no_audio errors.
// Needs FFmpeg, melt, espeak-ng and the models the image ships; skipped elsewhere unless
// CUTTINGFLOOR_REQUIRE_ENGINES says they must be there.

const exec = promisify(execFile);
const MODELS = process.env.CUTTINGFLOOR_SPEECH_MODELS ?? '/usr/share/cuttingfloor/models';

async function have(): Promise<boolean> {
  try {
    await exec('ffmpeg', ['-version']);
    await exec('melt', ['--version']);
    await exec('espeak-ng', ['--version']);
    await access(join(MODELS, 'silero-vad-v6.2.3.onnx'));
    await access(join(MODELS, 'wav2vec2-base-960h/model.onnx'));
    return true;
  } catch {
    return false;
  }
}
const ready = await have();
if (!ready && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) {
  throw new Error(
    'CUTTINGFLOOR_REQUIRE_ENGINES is set but FFmpeg, melt, espeak-ng or the speech models are missing',
  );
}

const ff = (args: string[]) => exec('ffmpeg', ['-v', 'error', '-y', ...args]);

/** Stretches of sound louder than -45 dB in a file: where the test speech really is. */
async function soundSpans(file: string): Promise<Array<{ start: number; end: number }>> {
  const { stderr } = await exec('ffmpeg', [
    '-hide_banner',
    '-i',
    file,
    '-af',
    'silencedetect=n=-45dB:d=0.25',
    '-f',
    'null',
    '-',
  ]);
  const quiet: Array<[number, number]> = [];
  let open = 0;
  for (const line of stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    if (e) quiet.push([open, Number(e[1])]);
  }
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < quiet.length; i++) {
    spans.push({
      start: (quiet[i] as [number, number])[1],
      end: (quiet[i + 1] as [number, number])[0],
    });
  }
  return spans;
}

describe.skipIf(!ready)('speech and sound facts', () => {
  let env: TestEnv;
  let client: Client;
  let speech: string;
  let silent: string;
  let shifted: string;
  let truth: Array<{ start: number; end: number }>;

  async function importFile(path: string): Promise<string> {
    const started = await ok<{ job_id?: string; media_id: string }>(client, 'media.import', {
      source: { path },
    });
    if (started.job_id) {
      const done = await settled(client, started.job_id, 120_000);
      expect(done.status).toBe('completed');
    }
    return started.media_id;
  }

  async function job(name: string, args: Record<string, unknown>) {
    const res = await call(client, name, args);
    if (res.isError) return res;
    const id = res.structured.job_id as string | undefined;
    if (!id) return res;
    const done = await settled<{ result?: Record<string, unknown>; error?: unknown }>(
      client,
      id,
      300_000,
    );
    return done.result
      ? { isError: false, structured: done.result, content: [] }
      : { isError: true, structured: (done.error ?? {}) as Record<string, unknown>, content: [] };
  }

  beforeAll(async () => {
    env = await testRuntime(
      process.env.CUTTINGFLOOR_MODELS ? { modelsDir: process.env.CUTTINGFLOOR_MODELS } : {},
    );
    client = await connect(env.runtime);
    const m = env.mediaDir;
    // Three phrases with known pauses, over faint room noise, as a video with sound.
    const lines = ['Hello there.', 'Cutting floor makes edits.', 'Seriously quick.'];
    for (const [i, text] of lines.entries()) {
      await exec('espeak-ng', ['-s', '150', '-w', join(m, `line${i}.wav`), text]);
    }
    await ff([
      ...lines.flatMap((_, i) => ['-i', join(m, `line${i}.wav`)]),
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=color=pink:amplitude=0.002:sample_rate=22050:duration=30',
      '-filter_complex',
      '[0:a]adelay=500[a0];[1:a]adelay=1200[a1];[2:a]adelay=900[a2];[a0][a1][a2]concat=n=3:v=0:a=1[s];[s][3:a]amix=inputs=2:duration=first:normalize=0[out]',
      '-map',
      '[out]',
      '-ar',
      '48000',
      join(m, 'speech.wav'),
    ]);
    truth = await soundSpans(join(m, 'speech.wav'));
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:size=320x180:rate=25',
      '-i',
      join(m, 'speech.wav'),
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      join(m, 'speech.mp4'),
    ]);
    // The same sound 0.37 s later, quieter, with its own hiss: a second microphone.
    await ff([
      '-i',
      join(m, 'speech.wav'),
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=color=white:amplitude=0.01:sample_rate=48000:duration=30',
      '-filter_complex',
      '[0:a]adelay=370,volume=0.6[d];[d][1:a]amix=inputs=2:duration=first:normalize=0[out]',
      '-map',
      '[out]',
      join(m, 'second-mic.wav'),
    ]);
    await ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:size=320x180:rate=25',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(m, 'silent.mp4'),
    ]);
    speech = await importFile(join(m, 'speech.mp4'));
    shifted = await importFile(join(m, 'second-mic.wav'));
    silent = await importFile(join(m, 'silent.mp4'));
  }, 600_000);

  afterAll(async () => {
    await client?.close();
    env?.runtime.stop();
  });

  it('ships the alignment labels the model was trained with', async () => {
    const vocab = JSON.parse(
      await readFile(join(MODELS, 'wav2vec2-base-960h/vocab.json'), 'utf8'),
    ) as Record<string, number>;
    for (const [label, index] of Object.entries(vocab)) expect(W2V_LABELS[index]).toBe(label);
  });

  it('finds where someone is speaking, at the cut-off given', async () => {
    expect(truth).toHaveLength(3);
    const res = await job('media.analyze', {
      media_id: speech,
      kind: 'speech',
      min_probability: 0.5,
    });
    expect(res.isError).toBe(false);
    const s = res.structured.speech as {
      spans: Array<{ start: number; end: number }>;
      probabilities: number[];
      frame_seconds: number;
      model: string;
    };
    expect(s.model).toBe('silero-vad-v6.2.3');
    expect(s.frame_seconds).toBeCloseTo(0.032, 3);
    expect(s.spans).toHaveLength(3);
    s.spans.forEach((span, i) => {
      expect(Math.abs(span.start - (truth[i]?.start ?? 0))).toBeLessThan(0.15);
      expect(Math.abs(span.end - (truth[i]?.end ?? 0))).toBeLessThan(0.25);
    });
    // Kept with the media: a range and another cut-off answer from it.
    const info = await ok<{ analyses: { speech: { frames: number } } }>(client, 'media.get', {
      media_id: speech,
    });
    expect(info.analyses.speech.frames).toBe(s.probabilities.length);
    const again = await job('media.analyze', {
      media_id: speech,
      kind: 'speech',
      min_probability: 0.5,
      from_seconds: (truth[1]?.start ?? 0) - 0.3,
    });
    const later = (again.structured.speech as { spans: unknown[] }).spans;
    expect(later).toHaveLength(2);
  }, 300_000);

  it('aligns transcript words to where they sound', async () => {
    const res = await job('media.analyze', {
      media_id: speech,
      kind: 'transcript',
      model: 'tiny',
      language: 'en',
    });
    expect(res.isError).toBe(false);
    const t = res.structured.transcript as {
      aligned_by: string;
      words: Array<{ text: string; start: number; end: number; timing_confidence: number | null }>;
    };
    expect(t.aligned_by).toBe('wav2vec2-base-960h');
    // Whisper's tiny model can mishear espeak's voice ("Hello there" as "For load, add") and
    // hears it differently from run to run. A misheard word can't be aligned to sound it
    // doesn't match, so each phrase's edges are checked where whisper heard that edge's word.
    const script = [
      ['hello', 'there'],
      ['cutting', 'edits'],
      ['seriously', 'quick'],
    ];
    const plain = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '');
    let checked = 0;
    truth.forEach((span, i) => {
      const inside = t.words.filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid > span.start - 0.2 && mid < span.end + 0.2;
      });
      const why = JSON.stringify({ phrase: i, span, words: t.words });
      expect(inside.length, why).toBeGreaterThan(0);
      const [first, last] = [inside[0], inside.at(-1)];
      if (first && plain(first.text) === script[i]?.[0]) {
        expect(Math.abs(first.start - span.start), why).toBeLessThan(0.1);
        checked += 1;
      }
      if (last && plain(last.text) === script[i]?.[1]) {
        expect(Math.abs(last.end - span.end), why).toBeLessThan(0.15);
        checked += 1;
      }
    });
    expect(checked, JSON.stringify(t.words)).toBeGreaterThanOrEqual(3);
    const timed = t.words.map((w) => w.timing_confidence ?? 0);
    expect(timed.reduce((sum, c) => sum + c, 0) / timed.length).toBeGreaterThan(0.4);
    // No word reaches into the pauses.
    for (const w of t.words) {
      for (let i = 0; i + 1 < truth.length; i++) {
        const gap = { start: (truth[i]?.end ?? 0) + 0.1, end: (truth[i + 1]?.start ?? 0) - 0.1 };
        expect(w.end <= gap.start || w.start >= gap.end).toBe(true);
      }
    }
  }, 300_000);

  it('measures loudness, over all of it or a range', async () => {
    const all = await job('media.analyze', { media_id: speech, kind: 'loudness' });
    const l = all.structured.loudness as Record<string, number | null>;
    expect(l.integrated_lufs).toBeLessThan(-5);
    expect(l.integrated_lufs).toBeGreaterThan(-45);
    expect(l.true_peak_dbtp).toBeLessThan(1);
    expect(l.loudness_range_lu).not.toBeNull();
    expect(l.noise_floor_dbfs).toBeLessThan(-40);
    // Only the pause before the second phrase: room noise, far quieter.
    const pause = await job('media.analyze', {
      media_id: speech,
      kind: 'loudness',
      from_seconds: (truth[0]?.end ?? 0) + 0.2,
      until_seconds: (truth[1]?.start ?? 0) - 0.2,
    });
    const q = pause.structured.loudness as Record<string, number | null>;
    expect((q.rms_dbfs ?? 0) < (l.rms_dbfs ?? 0) - 15).toBe(true);
  }, 300_000);

  it('finds the sync offset of a second microphone', async () => {
    const res = await job('media.correlate', {
      a: { media_id: speech },
      b: { media_id: shifted },
      max_offset_seconds: 2,
    });
    expect(res.isError).toBe(false);
    expect(res.structured.offset_seconds as number).toBeCloseTo(-0.37, 2);
    expect(res.structured.strength as number).toBeGreaterThan(0.5);
    // A stretch of b against all of a, on b's own clock.
    const part = await job('media.correlate', {
      a: { media_id: speech },
      b: { media_id: shifted, from_seconds: 2, until_seconds: 5 },
      max_offset_seconds: 3,
    });
    expect(part.structured.offset_seconds as number).toBeCloseTo(-0.37, 2);
  }, 300_000);

  it('fails with no_audio naming the side that has no sound', async () => {
    const none = await call(client, 'media.correlate', {
      a: { media_id: speech },
      b: { media_id: silent },
      max_offset_seconds: 1,
    });
    expect(none.isError).toBe(true);
    expect(none.structured.code).toBe('no_audio');
    expect(String(none.structured.message)).toContain(`b (media ${silent})`);
    const past = await call(client, 'media.correlate', {
      a: { media_id: speech, from_seconds: 500 },
      b: { media_id: shifted },
      max_offset_seconds: 1,
    });
    expect(past.structured.code).toBe('no_audio');
    expect(String(past.structured.message)).toContain(`a (media ${speech})`);
    for (const kind of ['speech', 'loudness']) {
      const res = await call(client, 'media.analyze', {
        media_id: silent,
        kind,
        min_probability: 0.5,
      });
      expect(res.structured.code).toBe('no_audio');
      const late = await call(client, 'media.analyze', {
        media_id: speech,
        kind,
        min_probability: 0.5,
        from_seconds: 500,
      });
      expect(late.structured.code).toBe('no_audio');
    }
  }, 120_000);

  it('measures an edit as it plays, in timeline seconds, and lists its cuts', async () => {
    const { timeline_id } = await ok<{ timeline_id: string }>(client, 'timeline.create', {
      name: 'speech',
      sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
      tracks: { video: 1, audio: 1 },
    });
    const f = (s: number) => Math.round(s * 25);
    // Cut in the middle of the second phrase.
    const mid1 = Math.round((((truth[1]?.start ?? 0) + (truth[1]?.end ?? 0)) / 2) * 25);
    // A starts 1 s in and stops in the middle of the second phrase; B is the third phrase,
    // from the pause before it.
    const edit = await ok<{ timeline_id: string }>(client, 'edit.batch', {
      timeline_id,
      preview: 'none',
      ops: [
        {
          tool: 'clip.add',
          args: { track_id: 't1', media_id: speech, at_frame: 25, source: { in: 0, out: mid1 } },
        },
        {
          tool: 'clip.add',
          args: {
            track_id: 't1',
            media_id: speech,
            source: { in: f((truth[2]?.start ?? 0) - 0.4), out: f((truth[2]?.end ?? 0) + 0.3) },
          },
        },
      ],
    });
    const tl = edit.timeline_id;
    const res = await job('media.analyze', {
      timeline_id: tl,
      kind: 'speech',
      min_probability: 0.5,
    });
    expect(res.isError).toBe(false);
    expect(res.structured.timeline_id).toBe(tl);
    const spans = (res.structured.speech as { spans: Array<{ start: number; end: number }> }).spans;
    expect(Math.abs((spans[0]?.start ?? 0) - ((truth[0]?.start ?? 0) + 1))).toBeLessThan(0.15);
    expect(spans).toHaveLength(3);

    const ranged = await job('media.analyze', {
      timeline_id: tl,
      kind: 'loudness',
      from_seconds: 0,
      until_seconds: 0.9,
    });
    // The first second is empty: the mix there is silence, measured, not an error.
    expect((ranged.structured.loudness as { integrated_lufs: null }).integrated_lufs).toBeNull();
    const past = await call(client, 'media.analyze', {
      timeline_id: tl,
      kind: 'loudness',
      from_seconds: 500,
    });
    expect(past.structured.code).toBe('no_audio');
    expect(String(past.structured.message)).toContain(`timeline ${tl}`);
    const picture = await call(client, 'media.analyze', { timeline_id: tl, kind: 'faces' });
    expect(picture.structured.code).toBe('bad_request');

    const qa = await job('qa.check', { timeline_id: tl, speech: { min_probability: 0.5 } });
    expect(qa.isError).toBe(false);
    const cuts = qa.structured.cuts as Array<{
      frame: number;
      in_speech: boolean;
      speech_before: number;
      silence_after_seconds: number;
      edges: Array<{ out_word: { text: string; seconds_cut: number } | null; in_word: unknown }>;
    }>;
    expect(qa.structured.cuts_total).toBe(cuts.length);
    // The one cut between the clips (the timeline's own start and end are not cuts; A's start
    // after the empty first second is).
    const join = cuts.find((c) => c.frame === 25 + mid1);
    expect(join).toBeDefined();
    expect(join?.speech_before).toBeGreaterThan(0.5);
    expect(join?.silence_after_seconds, JSON.stringify(join)).toBeGreaterThan(0.2);
    const word = join?.edges.find((e) => e.out_word)?.out_word;
    expect(word?.seconds_cut).toBeGreaterThan(0);
  }, 600_000);
});

describe('speech and sound facts: arguments and empty sources', () => {
  let env: TestEnv;
  let client: Client;
  let timeline: string;

  beforeAll(async () => {
    env = await testRuntime();
    client = await connect(env.runtime);
    timeline = (
      await ok<{ timeline_id: string }>(client, 'timeline.create', {
        name: 'empty',
        sequence: { width: 320, height: 180, fps: { num: 25, den: 1 } },
      })
    ).timeline_id;
  });

  afterAll(async () => {
    await client?.close();
    env?.runtime.stop();
  });

  it('asks for the cut-off speech needs, and refuses kinds that read pictures', async () => {
    const speech = await call(client, 'media.analyze', { timeline_id: timeline, kind: 'speech' });
    expect(speech.structured.code).toBe('bad_request');
    expect(String(speech.structured.message)).toMatch(/min_probability/);
    const faces = await call(client, 'media.analyze', { timeline_id: timeline, kind: 'faces' });
    expect(faces.structured.code).toBe('bad_request');
    const both = await call(client, 'media.analyze', { kind: 'loudness' });
    expect(both.isError).toBe(true);
  });

  it('fails with no_audio, naming the source, on an edit with nothing in it', async () => {
    const loud = await call(client, 'media.analyze', { timeline_id: timeline, kind: 'loudness' });
    expect(loud.structured.code).toBe('no_audio');
    expect(String(loud.structured.message)).toContain(`timeline ${timeline}`);
    const sync = await call(client, 'media.correlate', {
      a: { timeline_id: timeline },
      b: { timeline_id: timeline },
      max_offset_seconds: 1,
    });
    expect(sync.structured.code).toBe('no_audio');
    expect(String(sync.structured.message)).toContain(`a (timeline ${timeline})`);
    const range = await call(client, 'media.correlate', {
      a: { timeline_id: timeline, from_seconds: 2, until_seconds: 1 },
      b: { timeline_id: timeline },
      max_offset_seconds: 1,
    });
    expect(range.structured.code).toBe('no_audio');
    expect(String(range.structured.message)).toMatch(/range is empty/);
  });
});
