import { CfError } from '@cuttingfloor/schema';

// SubRip and WebVTT parsing for caption.add. Times come back in seconds; markup is stripped,
// and WebVTT inline timestamps (karaoke-style `<00:00:01.500>`) become word timings.

export interface Cue {
  start: number;
  end: number;
  text: string;
  words?: Array<{ text: string; start: number; end: number }>;
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;

function seconds(m: RegExpExecArray): number {
  const [, h, min, s, frac] = m;
  return (
    Number(h ?? 0) * 3600 +
    Number(min) * 60 +
    Number(s) +
    Number((frac ?? '0').padEnd(3, '0')) / 1000
  );
}

const stripTags = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();

/** Words timed by WebVTT inline timestamps, if the cue has any. */
function inlineWords(raw: string, start: number, end: number): Cue['words'] {
  if (!/<\d/.test(raw)) return undefined;
  const words: NonNullable<Cue['words']> = [];
  let at = start;
  for (const part of raw.split(/(<(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}>)/)) {
    const ts = TIME.exec(part);
    if (ts && part.startsWith('<')) {
      at = seconds(ts);
      continue;
    }
    for (const w of stripTags(part).split(/\s+/).filter(Boolean))
      words.push({ text: w, start: at, end: at });
  }
  // Each word runs until the next starts; the last until the cue ends.
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as { end: number };
    w.end = words[i + 1]?.start ?? end;
  }
  return words.length ? words : undefined;
}

/** Parses SubRip or WebVTT into cues, in order. */
export function parseSubtitles(content: string, format: 'srt' | 'vtt'): Cue[] {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (format === 'vtt' && !/^WEBVTT/.test(text)) {
    throw new CfError('bad_request', 'WebVTT must start with WEBVTT');
  }
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.length);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [left, right] = (lines[at] as string).split('-->');
    const a = TIME.exec(left ?? '');
    const b = TIME.exec(right ?? '');
    if (!a || !b) {
      throw new CfError('bad_request', `Bad cue timing: ${lines[at]}`, {
        hint: 'Times look like 00:00:01,500 --> 00:00:03,000',
      });
    }
    const start = seconds(a);
    const end = seconds(b);
    const raw = lines.slice(at + 1).join('\n');
    const body = stripTags(raw.replace(/<(?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3}>/g, ''));
    if (!body || end <= start) continue;
    const words = format === 'vtt' ? inlineWords(raw, start, end) : undefined;
    cues.push({ start, end, text: body, ...(words ? { words } : {}) });
  }
  if (!cues.length)
    throw new CfError('bad_request', `No cues found in the ${format.toUpperCase()}`);
  return cues.sort((x, y) => x.start - y.start);
}
