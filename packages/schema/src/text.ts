import * as z from 'zod/v4';
import { MediaId } from './ids.ts';

// Text: titles and captions, rendered with libass. Sizes are fractions of the frame height and
// positions fractions of the frame, so text lands the same at every render size.

// Checked at run time rather than as a schema pattern: it repeats in every colour field.
export const Colour = z.string().refine((v) => /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v), {
  message: 'a colour is #RRGGBB or #RRGGBBAA',
});

export const TEXT_REVEALS = ['none', 'typewriter', 'word_fade', 'word_pop'] as const;
export const HIGHLIGHTS = ['none', 'fill', 'word', 'karaoke', 'pop'] as const;

/**
 * Text style. Every field is optional; a field left out takes its TEXT_DEFAULTS value. Colours
 * are #RRGGBB or #RRGGBBAA; sizes are fractions (see video://catalog/text).
 */
export const TextStyle = z
  .object({
    font: z.string().min(1).max(100).optional().describe('video://catalog/fonts'),
    font_media_id: MediaId.optional().describe('An imported font'),
    size: z.number().min(0.005).max(1).optional().describe('Of frame height'),
    color: Colour.optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right']).optional(),
    x: z.number().min(-1).max(2).optional(),
    y: z.number().min(-1).max(2).optional(),
    anchor: z.enum(['top', 'middle', 'bottom']).optional(),
    max_width: z.number().min(0.05).max(1).optional(),
    letter_spacing: z.number().min(-0.5).max(2).optional(),
    outline: z
      .object({
        color: Colour,
        width: z.number().min(0).max(0.5),
      })
      .nullable()
      .optional(),
    shadow: z
      .object({
        color: Colour,
        distance: z.number().min(0).max(0.5),
        blur: z.number().min(0).max(0.5).optional(),
      })
      .nullable()
      .optional(),
    box: z
      .object({
        color: Colour,
        padding: z.number().min(0).max(1),
      })
      .nullable()
      .optional(),
    highlight: z
      .object({
        mode: z.enum(HIGHLIGHTS),
        color: Colour,
      })
      .nullable()
      .optional(),
    reveal: z.enum(TEXT_REVEALS).optional(),
    reveal_frames: z.number().int().min(1).max(10_000).optional(),
  })
  .meta({ id: 'TextStyle' });
export type TextStyle = z.infer<typeof TextStyle>;

/**
 * What a title or caption looks like in each style field it was not given. They are published
 * (video://catalog/text) and timeline.get shows each text clip's style with them filled in, so
 * nothing about how text looks is decided out of sight.
 */
export const TEXT_DEFAULTS: Record<'title' | 'caption', TextStyle> = {
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

/** A caption word, timed in ticks from the start of the caption's source (like media). */
export const StoredWord = z.object({
  text: z.string().max(200),
  t: z.number().int(),
  end: z.number().int(),
});
export type StoredWord = z.infer<typeof StoredWord>;
