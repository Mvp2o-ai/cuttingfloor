import {
  type FrameRate,
  type StoredClip,
  TEXT_DEFAULTS,
  type TextStyle,
} from '@cuttingfloor/schema';
import type { Measure } from './fontmetrics.ts';

// Titles and captions as ASS scripts for libass (MLT's avfilter.ass with alpha on, over a
// transparent layer). Sizes and positions are fractions of the frame, turned into pixels at
// the render's own size, so a preview and an export lay out the same.

type TextClip = Extract<StoredClip, { type: 'title' | 'caption' }>;

export interface AssOptions {
  width: number;
  height: number;
  fps: FrameRate;
  tpf: number;
  /** Frames the clip renders before its first frame (transitions). */
  head: number;
  /** Frames in the whole render span. */
  length: number;
  /**
   * Timeline frame of the span's first frame. libass reads the frame's timeline time, not the
   * clip's, so the events sit there.
   */
  at: number;
  /** The family of an imported font, by its media id. */
  fontFamily?: (mediaId: string) => string | undefined;
  /** Character widths of a face, for text that breaks its own lines (max_lines). */
  measure?: (face: TextFace) => Measure | undefined;
}

/** A face text is set in: the family libass is given, or an imported font by its media id. */
export interface TextFace {
  font: string;
  bold: boolean;
  italic: boolean;
  mediaId?: string | undefined;
}

/** #RRGGBB(AA) as an ASS colour, &HAABBGGRR, where alpha 00 is opaque. */
function assColour(hex: string): string {
  const h = hex.replace('#', '');
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  const a =
    h.length === 8
      ? (255 - Number.parseInt(h.slice(6, 8), 16)).toString(16).padStart(2, '0')
      : '00';
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Colour only (no alpha), for \1c-style override tags. */
const assRgb = (hex: string) => `&H${assColour(hex).slice(4)}&`;

/** Text made literal: no override blocks or escapes from user text; newlines become \N. */
export function assText(s: string): string {
  return s.replace(/\\/g, '\\⁠').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N');
}

function time(seconds: number, round: (n: number) => number = Math.round): string {
  const cs = Math.max(0, round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** libass numpad alignment from horizontal alignment and which edge sits on y. */
function alignment(style: TextStyle): number {
  const col = style.align === 'left' ? 1 : style.align === 'right' ? 3 : 2;
  const row = style.anchor === 'top' ? 6 : style.anchor === 'middle' ? 3 : 0;
  return col + row;
}

/** A word's style where spans change it. */
interface WordLook {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
}

/** A screenful of text: its tokens, the tokens that start a new line, and when it shows. */
interface Page {
  /** Token range [from, to) of the whole text. */
  from: number;
  to: number;
  /** Tokens that begin a line (other than the page's first). */
  breaks: Set<number>;
  /** Clip frame it shows from; the first page from the start of the render span. */
  start: number;
}

/**
 * Lines broken by measured widths: greedy at `limit`, a forced break before each token in
 * `forced`. Returns the tokens that begin each line after the first.
 */
function breakLines(
  order: number[],
  widths: Map<number, number>,
  space: number,
  limit: number,
  forced: Set<number>,
): number[] {
  const out: number[] = [];
  let line = -1;
  for (const i of order) {
    const w = widths.get(i) ?? 0;
    if (line < 0) line = w;
    else if (forced.has(i) || line + space + w > limit) {
      out.push(i);
      line = w;
    } else line += space + w;
  }
  return out;
}

/** The ASS script for a title or caption clip, timed on its render span. */
export function buildAss(clip: TextClip, o: AssOptions): string {
  const style: TextStyle = { ...TEXT_DEFAULTS[clip.type], ...clip.style };
  const px = (fraction: number) => Math.round(fraction * o.height * 100) / 100;
  const size = px(style.size ?? 0.06);
  const fps = o.fps.num / o.fps.den;
  const ms = (frame: number) => Math.round(((frame + o.head) / fps) * 1000);
  const width = (style.max_width ?? 0.9) * o.width;
  const margin = Math.max(0, Math.round((o.width - width) / 2));
  const outline = style.outline ? style.outline.width * size : 0;
  const shadow = style.shadow ? style.shadow.distance * size : 0;
  const blur = style.shadow?.blur ? Math.round(style.shadow.blur * size * 10) / 10 : 0;
  const hl = style.highlight && style.highlight.mode !== 'none' ? style.highlight : undefined;
  const karaoke = hl && (hl.mode === 'karaoke' || hl.mode === 'fill');
  // For karaoke, the primary colour is the sung colour and the secondary the waiting one.
  const primary = assColour(karaoke && hl ? hl.color : (style.color ?? '#FFFFFF'));
  const secondary = assColour(style.color ?? '#FFFFFF');
  const bold = style.bold ? -1 : 0;
  const italic = style.italic ? -1 : 0;
  const underline = style.underline ? -1 : 0;
  const spacing = Math.round((style.letter_spacing ?? 0) * size * 100) / 100;
  const align = alignment(style);
  const imported = style.font_media_id ? o.fontFamily?.(style.font_media_id) : undefined;
  const font = (imported ?? style.font ?? 'Inter').replace(/,/g, ' ');
  const mediaId = imported ? style.font_media_id : undefined;
  const common = `${bold},${italic},${underline},0,100,100,${spacing},0`;
  const styles = [
    `Style: Text,${font},${size},${primary},${secondary},${assColour(style.outline?.color ?? '#000000')},${assColour(style.shadow?.color ?? '#00000000')},${common},1,${outline},${shadow},${align},${margin},${margin},0,1`,
  ];
  if (style.box) {
    // BorderStyle 3 draws a box in the outline colour, padded by the outline width.
    styles.push(
      `Style: Box,${font},${size},&HFF000000,&HFF000000,${assColour(style.box.color)},&HFF000000,${common},3,${style.box.padding * size},0,${align},${margin},${margin},0,1`,
    );
  }
  const pos = `\\pos(${Math.round((style.x ?? 0.5) * o.width)},${Math.round((style.y ?? 0.5) * o.height)})`;
  const end = time((o.at + o.length) / fps);
  const n = o.length - o.head;

  // Words with times, as clip frames, when the caption has them.
  const words =
    clip.type === 'caption' && clip.words?.length
      ? clip.words.map((w) => ({
          text: w.text,
          start: (w.t - clip.in) / o.tpf,
          end: (w.end - clip.in) / o.tpf,
        }))
      : undefined;
  const tokens =
    words ??
    clip.text
      .split(/(\s+)/)
      .filter((t) => t.length)
      .map((text) => ({ text, start: 0, end: n }));
  const isSpace = (i: number) => !tokens[i]?.text.trim().length;
  // Each visible token's word number, which spans count in.
  const wordOf = new Map<number, number>();
  for (const [i] of tokens.entries()) if (!isSpace(i)) wordOf.set(i, wordOf.size);

  // Spans: each word's look over the clip style, a later span winning.
  const spans = clip.spans ?? [];
  const looks = new Map<number, WordLook>();
  for (const sp of spans)
    for (let w = sp.first_word; w <= sp.last_word; w++) {
      const look = looks.get(w) ?? {};
      for (const key of ['color', 'bold', 'italic', 'underline', 'size'] as const)
        if (sp[key] !== undefined) (look as Record<string, unknown>)[key] = sp[key];
      looks.set(w, look);
    }
  const restyles = {
    color: spans.some((s) => s.color !== undefined),
    bold: spans.some((s) => s.bold !== undefined),
    italic: spans.some((s) => s.italic !== undefined),
    underline: spans.some((s) => s.underline !== undefined),
    size: spans.some((s) => s.size !== undefined),
  };
  const lookOf = (i: number): Required<WordLook> => {
    const look = looks.get(wordOf.get(i) ?? -1) ?? {};
    return {
      color: look.color ?? style.color ?? '#FFFFFF',
      bold: look.bold ?? Boolean(style.bold),
      italic: look.italic ?? Boolean(style.italic),
      underline: look.underline ?? Boolean(style.underline),
      size: look.size ?? style.size ?? 0.06,
    };
  };
  /** Override tags for a word's shape (and colour, unless `colour` is false). */
  const lookTags = (i: number, colour: boolean): string => {
    const l = lookOf(i);
    const tags: string[] = [];
    if (restyles.bold) tags.push(`\\b${l.bold ? 1 : 0}`);
    if (restyles.italic) tags.push(`\\i${l.italic ? 1 : 0}`);
    if (restyles.underline) tags.push(`\\u${l.underline ? 1 : 0}`);
    if (restyles.size) tags.push(`\\fs${px(l.size)}`);
    // Karaoke words wait in their own colour and take the highlight as they are sung.
    if (colour && restyles.color && !(hl && !karaoke))
      tags.push(`\\${karaoke ? 2 : 1}c${assRgb(l.color)}`);
    return tags.join('');
  };

  // Pages: with max_lines, the text a screenful at a time, broken into lines here by the font's
  // widths (libass then keeps those lines as given).
  const pages: Page[] = [];
  const all = [...wordOf.keys()];
  if (style.max_lines && all.length) {
    const measureOf = (i: number) => {
      const l = lookOf(i);
      const m = o.measure?.({ font, bold: l.bold, italic: l.italic, mediaId });
      if (!m) throw new Error(`No font widths for ${font} to break lines by`);
      return m;
    };
    const widths = new Map<number, number>();
    for (const i of all) {
      const text = tokens[i]?.text ?? '';
      widths.set(i, measureOf(i)(text) * px(lookOf(i).size) + spacing * [...text].length);
    }
    const plainFace = { font, bold: Boolean(style.bold), italic: Boolean(style.italic), mediaId };
    const space = (o.measure?.(plainFace)?.(' ') ?? 0) * size + spacing;
    // Line breaks the text asks for: a newline in the space before a word.
    const forced = new Set(
      all.filter((i) => !words && i > 0 && isSpace(i - 1) && /\n/.test(tokens[i - 1]?.text ?? '')),
    );
    const starts = [all[0] as number, ...breakLines(all, widths, space, width, forced)];
    const max = style.max_lines;
    for (let l = 0; l < starts.length; l += max) {
      const first = starts[l] as number;
      const next = starts[l + max];
      const order = all.filter((i) => i >= first && (next === undefined || i < next));
      // Balanced: the narrowest width that keeps this page's line count.
      const lines = Math.min(max, starts.length - l);
      const widest = Math.max(...order.map((i) => widths.get(i) ?? 0));
      let lo = widest;
      let hi = width;
      for (let k = 0; k < 24 && hi - lo > 0.5; k++) {
        const mid = (lo + hi) / 2;
        if (breakLines(order, widths, space, mid, forced).length + 1 <= lines) hi = mid;
        else lo = mid;
      }
      pages.push({
        from: first,
        to: next ?? tokens.length,
        breaks: new Set(breakLines(order, widths, space, hi, forced)),
        start: 0,
      });
    }
    // Each page shows from its first word: by its timing, or by how far into the text it is.
    const letters = (from: number, to: number) =>
      all
        .filter((i) => i >= from && i < to)
        .reduce((s, i) => s + [...(tokens[i]?.text ?? '')].length, 0);
    const total = letters(0, tokens.length);
    for (const p of pages.slice(1))
      p.start = Math.round(words ? (tokens[p.from]?.start ?? 0) : (letters(0, p.from) / total) * n);
  } else pages.push({ from: 0, to: tokens.length, breaks: new Set(), start: 0 });
  const paged = pages.length > 1 || Boolean(style.max_lines);

  // The reveal: when each token (or letter) appears, in milliseconds from the event start.
  const revealFrames = style.reveal_frames ?? Math.max(1, Math.round(fps * 0.8));
  /**
   * One page's text with its tags. The shadow layer runs this without highlights or colours,
   * and its reveal fades the fill towards `shown` (the shadow's alpha) rather than to opaque.
   */
  const render = (
    page: Page,
    first: boolean,
    highlights: boolean,
    alpha = '\\alpha',
    shown = '00',
  ): string => {
    // Times inside the event, which starts at the page.
    const offset = first ? 0 : ms(page.start);
    const at = (frame: number) => ms(frame) - offset;
    const revealAt = (frames: number) => (first ? ms(frames) : Math.round((frames / fps) * 1000));
    const parts: string[] = [];
    const inPage = (i: number) => i >= page.from && i < page.to;
    const visibleTokens = all.filter(inPage);
    const letters = visibleTokens.reduce((sum, i) => sum + [...(tokens[i]?.text ?? '')].length, 0);
    let letter = 0;
    let wordIndex = 0;
    for (let i = page.from; i < page.to; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      if (isSpace(i)) {
        if (!paged) parts.push(assText(tok.text));
        continue;
      }
      const sep =
        paged && wordIndex > 0
          ? page.breaks.has(i)
            ? '\\N'
            : ' '
          : words && i > 0 && !paged
            ? ' '
            : '';
      const tags: string[] = [lookTags(i, highlights)];
      // Highlights by word timing.
      if (highlights && hl && words) {
        const a = at(tok.start);
        const b = at(tok.end);
        if (hl.mode === 'karaoke' || hl.mode === 'fill') {
          // Each word's turn lasts until the next word starts, so pauses stay where they are.
          if (i === page.from && a > 0) parts.push(`{\\k${Math.round(a / 10)}}`);
          const next = i + 1 < page.to ? tokens[i + 1] : undefined;
          const until = next ? at(next.start) : b;
          tags.push(
            `\\k${hl.mode === 'fill' ? 'f' : ''}${Math.max(1, Math.round((until - a) / 10))}`,
          );
        } else {
          const on = assRgb(hl.color);
          const off = assRgb(lookOf(i).color);
          // A zero-length \t renders half-way in libass, so each switch takes 1 ms.
          tags.push(`\\1c${off}\\t(${a},${a + 1},\\1c${on})\\t(${b},${b + 1},\\1c${off})`);
          if (hl.mode === 'pop') {
            tags.push(
              `\\t(${a},${a + 80},\\fscx115\\fscy115)\\t(${b - 80},${b},\\fscx100\\fscy100)`,
            );
          }
        }
      }
      // Reveals spread across the reveal frames from the page's first frame.
      const reveal = style.reveal ?? 'none';
      if (reveal === 'word_fade' || reveal === 'word_pop') {
        const t0 = revealAt((wordIndex / Math.max(1, visibleTokens.length)) * revealFrames);
        tags.push(
          reveal === 'word_fade'
            ? `${alpha}&HFF&\\t(${t0},${t0 + 200},${alpha}&H${shown}&)`
            : `\\fscx0\\fscy0\\t(${t0},${t0 + 160},\\fscx100\\fscy100)`,
        );
      }
      let body: string;
      if (reveal === 'typewriter') {
        body = [...tok.text]
          .map((ch) => {
            const t = revealAt((letter++ / Math.max(1, letters)) * revealFrames);
            return `{${alpha}&HFF&\\t(${t},${t + 1},${alpha}&H${shown}&)}${assText(ch)}`;
          })
          .join('');
      } else body = assText(tok.text);
      wordIndex++;
      const joined = tags.join('');
      parts.push(`${sep}${joined ? `{${joined}}` : ''}${body}`);
    }
    return parts.join('');
  };
  const events: string[] = [];
  for (const [p, page] of pages.entries()) {
    const first = p === 0;
    // Down, so the first frame's own time is never before the event starts.
    const begin = time((o.at + (first ? 0 : o.head + page.start)) / fps, Math.floor);
    const next = pages[p + 1];
    const until = next ? time((o.at + o.head + next.start) / fps, Math.floor) : end;
    // Paged lines are broken here; libass keeps them as given.
    const q = paged ? '\\q2' : '';
    const text = render(page, first, true);
    const plain = paged
      ? all
          .filter((i) => i >= page.from && i < page.to)
          .map(
            (i, k) =>
              `${k ? (page.breaks.has(i) ? '\\N' : ' ') : ''}${assText(tokens[i]?.text ?? '')}`,
          )
          .join('')
      : assText(words ? words.map((w) => w.text).join(' ') : clip.text);
    if (style.box) events.push(`Dialogue: 0,${begin},${until},Box,,0,0,0,,{${pos}${q}}${plain}`);
    if (shadow && blur && style.shadow) {
      // libass blurs the letters too when there is no outline, and casts no shadow from
      // invisible ones, so a soft shadow is its own layer: the letters in the shadow colour,
      // offset and blurred, under crisp text without a shadow.
      const sx = Math.round((style.x ?? 0.5) * o.width + shadow);
      const sy = Math.round((style.y ?? 0.5) * o.height + shadow);
      const c = assColour(style.shadow.color);
      events.push(
        `Dialogue: 1,${begin},${until},Text,,0,0,0,,{\\pos(${sx},${sy})${q}\\1c&H${c.slice(4)}&\\1a&H${c.slice(2, 4)}&\\3a&HFF&\\shad0\\blur${blur}}${render(page, first, false, '\\1a', c.slice(2, 4))}`,
      );
      events.push(`Dialogue: 2,${begin},${until},Text,,0,0,0,,{${pos}${q}\\shad0}${text}`);
    } else {
      events.push(`Dialogue: 1,${begin},${until},Text,,0,0,0,,{${pos}${q}}${text}`);
    }
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${o.width}`,
    `PlayResY: ${o.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
