import { access, mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CfError } from '@cuttingfloor/schema';
import { BIN, run } from './exec.ts';
import { noAudio, type Range } from './speech.ts';

// Who speaks when (speaker diarisation) with sherpa-onnx on the CPU: pyannote segmentation-3.0
// (MIT, CNRS) finds the speech of up to three voices per 10 s window, 3D-Speaker ERes2Net trained
// on VoxCeleb (Apache-2.0, Alibaba) turns each into a voice embedding, and the embeddings are
// clustered into speakers: into the number given, or by a distance cut-off the caller gives.
// About a third of real time on one core (54.8 s in 18 s on an Apple M-series core), less with
// the four threads it uses. ERes2Net over CAM++: CAM++ merged two distinct voices in testing.

const MODELS = process.env.CUTTINGFLOOR_SPEECH_MODELS ?? '/usr/share/cuttingfloor/models';

/** The model files and the names kept with results, so a model change shows. */
export const SPEAKER_MODELS = {
  segmentation: { file: 'pyannote-segmentation-3.0.onnx', name: 'pyannote-segmentation-3.0' },
  embedding: {
    file: '3dspeaker-eres2net-sv-en-voxceleb-16k.onnx',
    name: '3dspeaker-eres2net-en-voxceleb',
  },
} as const;

export interface SpeakerTurn {
  /** Media seconds. */
  start: number;
  end: number;
  /** 0 for the first voice heard, 1 for the next new one, and so on. */
  speaker: number;
  /** 0–1: how close this stretch's voice sits to its speaker's others. */
  confidence: number | null;
}

export interface Speakers {
  model: string;
  /** How the voices were grouped: the count asked for, or the distance cut-off. */
  speakers_asked: number | null;
  cluster_threshold: number | null;
  speakers: number;
  turns: SpeakerTurn[];
  from?: number;
  until?: number | null;
}

/** Parses the tool's lines: "0.470 -- 8.384 speaker_00 confidence=0.370". */
export function parseTurns(text: string): Array<Omit<SpeakerTurn, 'speaker'> & { label: string }> {
  const out: Array<Omit<SpeakerTurn, 'speaker'> & { label: string }> = [];
  for (const line of text.split('\n')) {
    const m =
      /^\s*(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+(speaker_\d+)(?:\s+confidence=([\d.]+))?/.exec(
        line,
      );
    if (!m) continue;
    out.push({
      start: Number(m[1]),
      end: Number(m[2]),
      label: m[3] as string,
      confidence: m[4] === undefined ? null : Number(m[4]),
    });
  }
  return out;
}

/** Speaker numbers in the order voices are first heard; turns sorted by start. */
export function numberSpeakers(
  turns: Array<Omit<SpeakerTurn, 'speaker'> & { label: string }>,
  shift = 0,
): SpeakerTurn[] {
  const order = new Map<string, number>();
  const sorted = [...turns].sort((a, b) => a.start - b.start || a.end - b.end);
  const r3 = (t: number) => Math.round(t * 1000) / 1000;
  return sorted.map((t) => {
    if (!order.has(t.label)) order.set(t.label, order.size);
    return {
      start: r3(t.start + shift),
      end: r3(t.end + shift),
      speaker: order.get(t.label) as number,
      confidence: t.confidence,
    };
  });
}

async function model(kind: keyof typeof SPEAKER_MODELS): Promise<string> {
  const file = join(MODELS, SPEAKER_MODELS[kind].file);
  try {
    await access(file);
  } catch {
    throw new CfError('engine_error', `The ${SPEAKER_MODELS[kind].name} model is not installed`, {
      hint: 'It ships in the Docker image; run cuttingfloor there',
    });
  }
  return file;
}

/** Who speaks when over a range of the file, in the file's seconds. */
export async function diarize(
  file: string,
  options: Range & {
    /** How many speakers there are, when known. */
    speakers?: number;
    /** Otherwise: how far apart two voices must be to count as two speakers. */
    clusterThreshold?: number;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  },
): Promise<Speakers> {
  const [segmentation, embedding] = await Promise.all([model('segmentation'), model('embedding')]);
  const dir = await mkdtemp(join(tmpdir(), 'cf-speakers-'));
  try {
    const wav = join(dir, 'speech.wav');
    await run(
      BIN.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-protocol_whitelist',
        'file',
        ...(options.from ? ['-ss', String(options.from)] : []),
        ...(options.until !== undefined ? ['-to', String(options.until)] : []),
        '-i',
        `file:${file}`,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-y',
        `file:${wav}`,
      ],
      { timeoutMs: 30 * 60_000, ...(options.signal ? { signal: options.signal } : {}) },
    ).catch((error: unknown) => {
      if (
        /does not contain any stream|matches no streams/i.test(
          String((error as CfError).detail?.stderr ?? ''),
        )
      )
        throw noAudio(options, 'it has no audio stream');
      throw error;
    });
    const threads = String(Math.max(1, Math.min(4, availableParallelism())));
    const clustering =
      options.speakers !== undefined
        ? [`--clustering.num-clusters=${options.speakers}`]
        : [`--clustering.cluster-threshold=${options.clusterThreshold}`];
    const { stdout, stderr } = await run(
      BIN.diarize,
      [
        ...clustering,
        '--clustering.compute-confidence=true',
        `--segmentation.pyannote-model=${segmentation}`,
        `--embedding.model=${embedding}`,
        `--segmentation.num-threads=${threads}`,
        `--embedding.num-threads=${threads}`,
        wav,
      ],
      {
        heavy: true,
        timeoutMs: 6 * 60 * 60_000,
        ...(options.signal ? { signal: options.signal } : {}),
        onLine: (line) => {
          const m = /^progress ([\d.]+)%/.exec(line);
          if (m) options.onProgress?.(Number(m[1]) / 100);
        },
      },
    );
    const turns = numberSpeakers(parseTurns(`${stdout}\n${stderr}`), options.from ?? 0);
    return {
      model: `${SPEAKER_MODELS.segmentation.name} + ${SPEAKER_MODELS.embedding.name}`,
      speakers_asked: options.speakers ?? null,
      cluster_threshold: options.speakers !== undefined ? null : (options.clusterThreshold ?? null),
      speakers: new Set(turns.map((t) => t.speaker)).size,
      turns,
      ...(options.from !== undefined || options.until !== undefined
        ? { from: options.from ?? 0, until: options.until ?? null }
        : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The speaker of each word: the one whose turns overlap the word most; null where no turn does
 * (outside the stretch diarised, or a word in a gap).
 */
export function wordSpeakers(
  words: Array<{ start: number; end: number }>,
  turns: SpeakerTurn[],
): Array<number | null> {
  return words.map((w) => {
    const share = new Map<number, number>();
    const lo = w.start;
    const hi = Math.max(w.end, w.start + 1e-3);
    for (const t of turns) {
      if (t.start >= hi) break;
      const o = Math.min(hi, t.end) - Math.max(lo, t.start);
      if (o > 0) share.set(t.speaker, (share.get(t.speaker) ?? 0) + o);
    }
    let best: number | null = null;
    let most = 0;
    for (const [s, o] of share)
      if (o > most) {
        most = o;
        best = s;
      }
    return best;
  });
}
