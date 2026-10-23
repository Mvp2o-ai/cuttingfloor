// CTC forced alignment, the WhisperX method: a wav2vec2 character model gives, for every 20 ms
// of sound, the log-probability of each letter (and of "no letter", the blank). The Viterbi path
// through the transcript's letters, in order, says when each letter sounds; a word runs from the
// first frame of its first letter to the last frame of its last. Pure functions here; the model
// runs in speech-worker.ts.

/** wav2vec2-base-960h's labels (its vocab.json): index = position. 0 is the CTC blank. */
export const W2V_LABELS = [
  '<pad>',
  '<s>',
  '</s>',
  '<unk>',
  '|',
  'E',
  'T',
  'A',
  'O',
  'N',
  'I',
  'H',
  'S',
  'R',
  'D',
  'L',
  'U',
  'M',
  'W',
  'C',
  'F',
  'G',
  'Y',
  'P',
  'B',
  'V',
  'K',
  "'",
  'X',
  'J',
  'Q',
  'Z',
] as const;
const BLANK = 0;
const SEPARATOR = 4;
const INDEX = new Map<string, number>(W2V_LABELS.map((l, i) => [l, i]));

/** Seconds of sound per model frame: wav2vec2's 320-sample stride at 16 kHz. */
export const FRAME_SECONDS = 0.02;

/** A word's letters as model labels; empty when it has none the model knows (digits, symbols). */
export function wordTokens(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").toUpperCase()) {
    const i = INDEX.get(ch);
    if (i !== undefined && i !== SEPARATOR) out.push(i);
  }
  // A lone apostrophe or one at the edges is punctuation, not a sound.
  while (out[0] === 27) out.shift();
  while (out.at(-1) === 27) out.pop();
  return out;
}

export interface FrameSpan {
  /** First frame (inclusive) and last frame (exclusive) where the word's letters sound. */
  start: number;
  end: number;
  /** Mean probability of the word's letters over their frames, 0–1. */
  score: number;
}

/**
 * Viterbi alignment of words (each a list of labels) to emissions: `logp[t * classes + c]` is
 * the log-probability of label c at frame t. Words are joined by the word separator, which the
 * model emits between words, so the path may also rest on it in pauses. Returns one span per
 * word, or null when the sound is too short to hold the letters.
 */
export function forcedAlign(
  logp: Float32Array,
  frames: number,
  classes: number,
  words: number[][],
): FrameSpan[] | null {
  // The label sequence: word letters with a separator between words. Every letter remembers its
  // word (separators belong to none).
  const labels: number[] = [];
  const owner: number[] = [];
  words.forEach((w, wi) => {
    if (wi > 0) {
      labels.push(SEPARATOR);
      owner.push(-1);
    }
    for (const l of w) {
      labels.push(l);
      owner.push(wi);
    }
  });
  const L = labels.length;
  if (!L) return words.map(() => ({ start: 0, end: 0, score: 0 }));
  // Extended with blanks: blank, l1, blank, l2, ..., lL, blank.
  const S = 2 * L + 1;
  const label = (s: number) => (s % 2 === 0 ? BLANK : (labels[(s - 1) / 2] as number));
  // Minimum frames: one per label, plus a blank between equal neighbours.
  let need = L;
  for (let i = 1; i < L; i++) if (labels[i] === labels[i - 1]) need++;
  if (frames < need) return null;

  const NEG = Number.NEGATIVE_INFINITY;
  let prev = new Float64Array(S).fill(NEG);
  let cur = new Float64Array(S);
  const back = new Uint8Array(frames * S); // 0 stay, 1 from s-1, 2 from s-2
  prev[0] = logp[label(0)] as number;
  prev[1] = logp[label(1)] as number;
  for (let t = 1; t < frames; t++) {
    const row = t * classes;
    // A state can only be reached if enough frames remain for the rest after it, and only
    // states reachable from the start in t frames matter; plain bounds keep it simple.
    for (let s = 0; s < S; s++) {
      let best = prev[s] as number;
      let from = 0;
      if (s >= 1 && (prev[s - 1] as number) > best) {
        best = prev[s - 1] as number;
        from = 1;
      }
      if (s >= 2 && s % 2 === 1 && label(s) !== label(s - 2) && (prev[s - 2] as number) > best) {
        best = prev[s - 2] as number;
        from = 2;
      }
      cur[s] = best === NEG ? NEG : best + (logp[row + label(s)] as number);
      back[t * S + s] = from;
    }
    [prev, cur] = [cur, prev];
  }
  let s = (prev[S - 1] as number) >= (prev[S - 2] as number) ? S - 1 : S - 2;
  if (prev[s] === NEG) return null;

  const spans = words.map(() => ({ start: -1, end: -1, sum: 0, n: 0 }));
  for (let t = frames - 1; t >= 0; t--) {
    if (s % 2 === 1) {
      const w = owner[(s - 1) / 2] as number;
      const span = w >= 0 ? spans[w] : undefined;
      if (span) {
        if (span.end < 0) span.end = t + 1;
        span.start = t;
        span.sum += Math.exp(logp[t * classes + label(s)] as number);
        span.n++;
      }
    }
    if (t > 0) s -= back[t * S + s] as number;
  }
  return spans.map((sp) => ({
    start: Math.max(0, sp.start),
    end: Math.max(0, sp.end),
    score: sp.n ? sp.sum / sp.n : 0,
  }));
}

/** Log-softmax of logits over classes, in place. */
export function logSoftmax(values: Float32Array, frames: number, classes: number): Float32Array {
  for (let t = 0; t < frames; t++) {
    const row = t * classes;
    let max = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < classes; c++) max = Math.max(max, values[row + c] as number);
    let sum = 0;
    for (let c = 0; c < classes; c++) sum += Math.exp((values[row + c] as number) - max);
    const log = max + Math.log(sum);
    for (let c = 0; c < classes; c++) values[row + c] = (values[row + c] as number) - log;
  }
  return values;
}

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface AlignGroup {
  /** Indexes into the words: the ones this group times. */
  first: number;
  last: number;
  /** Indexes of the neighbours aligned with it for context (their times are not kept). */
  from: number;
  to: number;
  /** Seconds of sound to align against. */
  start: number;
  end: number;
}

/**
 * Splits words into groups to align one at a time: up to `maxSeconds` of rough times each,
 * with one alignable neighbour either side for context, so a neighbour's sound in the window is
 * claimed by that neighbour rather than stretching this group's edge words.
 */
export function alignGroups(
  words: TimedWord[],
  duration: number,
  options: { maxSeconds: number; pad: number },
): AlignGroup[] {
  const ok = words.map((w) => wordTokens(w.text).length > 0);
  const groups: AlignGroup[] = [];
  let i = 0;
  while (i < words.length) {
    if (!ok[i]) {
      i++;
      continue;
    }
    const first = i;
    let last = i;
    while (
      last + 1 < words.length &&
      ((words[last + 1] as TimedWord).end - (words[first] as TimedWord).start <=
        options.maxSeconds ||
        last === first)
    )
      last++;
    let from = first - 1;
    while (from >= 0 && !ok[from]) from--;
    let to = last + 1;
    while (to < words.length && !ok[to]) to++;
    const lo = from >= 0 ? (words[from] as TimedWord).start : (words[first] as TimedWord).start;
    const hi = to < words.length ? (words[to] as TimedWord).end : (words[last] as TimedWord).end;
    groups.push({
      first,
      last,
      from: Math.max(0, from),
      to: Math.min(words.length - 1, to),
      start: Math.max(0, lo - options.pad),
      end: Math.min(duration, Math.max(hi, lo) + options.pad),
    });
    i = last + 1;
  }
  return groups;
}
