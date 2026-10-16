import { TICKS_PER_SECOND, type TimelineDoc } from '@cuttingfloor/schema';
import { flatten, type InterchangeResult, isPlaying, type TextClip, Warnings } from './common.ts';

// SubRip and WebVTT from caption clips in timeline order (title clips when there are no
// captions). The inverse of parseSubtitles: WebVTT carries caption word timings as inline
// `<hh:mm:ss.mmm>` timestamps, which parseSubtitles reads back as words.

interface Timed {
  start: number;
  end: number;
  text: string;
  /** Word starts on the timeline (ticks), with their text, when the caption has words. */
  words?: Array<{ text: string; start: number }>;
}

/** Milliseconds of a tick count, rounded. */
const ms = (ticks: number) => Math.round((ticks * 1000) / TICKS_PER_SECOND);

/** `hh:mm:ss<sep>mmm`; hours grow past two digits when they need to. */
export function cueTime(ticks: number, sep: ',' | '.'): string {
  const total = Math.max(0, ms(ticks));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  return `${two(h)}:${two(m)}:${two(s)}${sep}${String(total % 1000).padStart(3, '0')}`;
}

function cues(doc: TimelineDoc, w: Warnings): Timed[] {
  const { tracks } = flatten(doc, w);
  const all: Array<{ clip: TextClip; order: number }> = [];
  tracks.forEach((t, order) => {
    if (t.kind !== 'video') return;
    for (const c of t.clips) {
      if (!c.enabled || (c.type !== 'caption' && c.type !== 'title')) continue;
      if (!isPlaying(t)) {
        w.add('Text on hidden tracks was left out', t.name);
        continue;
      }
      all.push({ clip: c, order });
    }
  });
  let chosen = all.filter((x) => x.clip.type === 'caption');
  if (!chosen.length && all.length) {
    chosen = all;
    w.add('The timeline has no captions, so its titles were written as cues');
  }
  if (!chosen.length) w.add('The timeline has no captions or titles, so there are no cues');
  chosen.sort((a, b) => a.clip.start - b.clip.start || a.order - b.order);
  return chosen.map(({ clip: c }) => {
    if (c.style) w.add('Text styling was dropped', c.id);
    if (c.transform || c.animation || c.mask)
      w.add('Text placement and animation were dropped', c.id);
    const cue: Timed = { start: c.start, end: c.start + c.duration, text: c.text };
    if (c.type === 'caption' && c.words?.length)
      cue.words = c.words.map((x) => ({ text: x.text, start: c.start + (x.t - c.in) }));
    return cue;
  });
}

/** Cue text: no blank lines (they end a cue), trimmed. */
const body = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

/** Writes caption clips (or titles) as SubRip. */
export function toSrt(doc: TimelineDoc): InterchangeResult {
  const w = new Warnings();
  const out: string[] = [];
  let n = 0;
  for (const c of cues(doc, w)) {
    const text = body(c.text);
    if (!text) continue;
    if (c.words) w.add('SubRip has no word timings; captions were written as plain cues');
    n++;
    out.push(`${n}\n${cueTime(c.start, ',')} --> ${cueTime(c.end, ',')}\n${text}\n`);
  }
  return { text: out.join('\n'), warnings: w.list() };
}

const vttEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Writes caption clips (or titles) as WebVTT, with word timings as inline timestamps. */
export function toVtt(doc: TimelineDoc): InterchangeResult {
  const w = new Warnings();
  const out: string[] = ['WEBVTT\n'];
  for (const c of cues(doc, w)) {
    let text = body(c.text);
    if (!text) continue;
    if (c.words?.length) {
      // A timestamp before each word after the first, strictly inside the cue and increasing.
      let last = ms(c.start);
      const parts: string[] = [];
      for (const word of c.words) {
        const t = ms(word.start);
        const stamp = parts.length && t > last && t < ms(c.end);
        if (stamp) last = t;
        parts.push(`${stamp ? `<${cueTime(word.start, '.')}>` : ''}${vttEscape(word.text)}`);
      }
      text = parts.join(' ');
    } else text = vttEscape(text);
    out.push(`${cueTime(c.start, '.')} --> ${cueTime(c.end, '.')}\n${text}\n`);
  }
  return { text: out.join('\n'), warnings: w.list() };
}
