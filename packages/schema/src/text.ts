import * as z from 'zod/v4';
import { MediaId } from './ids.ts';

// Text: titles and captions, rendered with libass. Sizes are fractions of the frame height and
// positions fractions of the frame, so text lands the same at every render size.

// Checked at run time rather than as a schema pattern: it repeats in every colour field.
const Colour = z.string().refine((v) => /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v), {
  message: 'a colour is #RRGGBB or #RRGGBBAA',
});

export const TEXT_REVEALS = ['none', 'typewriter', 'word_fade', 'word_pop'] as const;
export const HIGHLIGHTS = ['none', 'fill', 'word', 'karaoke', 'pop'] as const;

/**
 * Text style. Every field is optional; titles and captions have their own defaults. Colours
 * are #RRGGBB or #RRGGBBAA; sizes are fractions (see video://catalog/text).
 */
export const TextStyle = z.object({
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
});
export type TextStyle = z.infer<typeof TextStyle>;

/** A caption word, timed in ticks from the start of the caption's source (like media). */
export const StoredWord = z.object({
  text: z.string().max(200),
  t: z.number().int(),
  end: z.number().int(),
});
export type StoredWord = z.infer<typeof StoredWord>;
