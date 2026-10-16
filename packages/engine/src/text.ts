import type { FrameRate, StoredClip, TextStyle } from '@cuttingfloor/schema';

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
  /** The family of an imported font, by its media id. */
  fontFamily?: (mediaId: string) => string | undefined;
}

const DEFAULTS: Record<'title' | 'caption', TextStyle> = {
  title: {
    font: 'Inter',
    size: 0.09,
    color: '#FFFFFF',
    bold: true,
    align: 'center',
    x: 0.5,
    y: 0.5,
    anchor: 'middle',
    max_width: 0.9,
    shadow: { color: '#00000099', distance: 0.03, blur: 0.04 },
  },
  caption: {
    font: 'Inter',
    size: 0.06,
    color: '#FFFFFF',
    bold: true,
    align: 'center',
    x: 0.5,
    y: 0.9,
    anchor: 'bottom',
    max_width: 0.84,
    outline: { color: '#000000', width: 0.09 },
  },
};

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

function time(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
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

/** The ASS script for a title or caption clip, timed on its render span. */
export function buildAss(clip: TextClip, o: AssOptions): string {
  const style: TextStyle = { ...DEFAULTS[clip.type], ...clip.style };
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
  const end = time(o.length / fps);
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

  // The reveal: when each token (or letter) appears, in milliseconds from the event start.
  const revealFrames = style.reveal_frames ?? Math.max(1, Math.round(fps * 0.8));
  /**
   * The text with its tags. The shadow layer runs this without highlights, and its reveal
   * fades the fill towards `shown` (the shadow's alpha) rather than to opaque.
   */
  const render = (highlights: boolean, alpha = '\\alpha', shown = '00'): string => {
    const parts: string[] = [];
    const visibleTokens = tokens.filter((t) => t.text.trim().length);
    const letters = visibleTokens.reduce((sum, t) => sum + [...t.text].length, 0);
    let letter = 0;
    let wordIndex = 0;
    for (const [i, tok] of tokens.entries()) {
      const isSpace = !tok.text.trim().length;
      const sep = words && i > 0 ? ' ' : '';
      if (isSpace) {
        parts.push(assText(tok.text));
        continue;
      }
      const tags: string[] = [];
      // Highlights by word timing.
      if (highlights && hl && words) {
        const a = ms(tok.start);
        const b = ms(tok.end);
        if (hl.mode === 'karaoke' || hl.mode === 'fill') {
          // Each word's turn lasts until the next word starts, so pauses stay where they are.
          if (i === 0 && a > 0) parts.push(`{\\k${Math.round(a / 10)}}`);
          const next = tokens[i + 1];
          const until = next ? ms(next.start) : b;
          tags.push(
            `\\k${hl.mode === 'fill' ? 'f' : ''}${Math.max(1, Math.round((until - a) / 10))}`,
          );
        } else {
          const on = assRgb(hl.color);
          const off = assRgb(style.color ?? '#FFFFFF');
          // A zero-length \t renders half-way in libass, so each switch takes 1 ms.
          tags.push(`\\1c${off}\\t(${a},${a + 1},\\1c${on})\\t(${b},${b + 1},\\1c${off})`);
          if (hl.mode === 'pop') {
            tags.push(
              `\\t(${a},${a + 80},\\fscx115\\fscy115)\\t(${b - 80},${b},\\fscx100\\fscy100)`,
            );
          }
        }
      }
      // Reveals spread across the reveal frames from the clip's first frame.
      const reveal = style.reveal ?? 'none';
      if (reveal === 'word_fade' || reveal === 'word_pop') {
        const t0 = ms((wordIndex / Math.max(1, visibleTokens.length)) * revealFrames);
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
            const t = ms((letter++ / Math.max(1, letters)) * revealFrames);
            return `{${alpha}&HFF&\\t(${t},${t + 1},${alpha}&H${shown}&)}${assText(ch)}`;
          })
          .join('');
      } else body = assText(tok.text);
      wordIndex++;
      parts.push(`${sep}${tags.length ? `{${tags.join('')}}` : ''}${body}`);
    }
    return parts.join('');
  };
  const text = render(true);
  const plain = assText(words ? words.map((w) => w.text).join(' ') : clip.text);
  const events = [];
  if (style.box) events.push(`Dialogue: 0,0:00:00.00,${end},Box,,0,0,0,,{${pos}}${plain}`);
  if (shadow && blur && style.shadow) {
    // libass blurs the letters too when there is no outline, and casts no shadow from
    // invisible ones, so a soft shadow is its own layer: the letters in the shadow colour,
    // offset and blurred, under crisp text without a shadow.
    const sx = Math.round((style.x ?? 0.5) * o.width + shadow);
    const sy = Math.round((style.y ?? 0.5) * o.height + shadow);
    const c = assColour(style.shadow.color);
    events.push(
      `Dialogue: 1,0:00:00.00,${end},Text,,0,0,0,,{\\pos(${sx},${sy})\\1c&H${c.slice(4)}&\\1a&H${c.slice(2, 4)}&\\3a&HFF&\\shad0\\blur${blur}}${render(false, '\\1a', c.slice(2, 4))}`,
    );
    events.push(`Dialogue: 2,0:00:00.00,${end},Text,,0,0,0,,{${pos}\\shad0}${text}`);
  } else {
    events.push(`Dialogue: 1,0:00:00.00,${end},Text,,0,0,0,,{${pos}}${text}`);
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
