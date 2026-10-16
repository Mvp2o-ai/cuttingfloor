import { installedFonts, presetCatalog } from '@cuttingfloor/engine';
import {
  BLEND_MODES,
  type BlendMode,
  EASES,
  EFFECTS,
  type HIGHLIGHTS,
  type IN_OUT_ANIMATIONS,
  type LOOP_ANIMATIONS,
  MASK_SHAPES,
  type MaskShape,
  type TEXT_REVEALS,
  type TransitionKind,
} from '@cuttingfloor/schema';
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

// Catalogues are data, not tools: the names a tool accepts plus what each one does, read as
// resources so tool definitions stay small (spec §21.5).

const BLEND: Record<BlendMode, string> = {
  normal: 'Covers what is below',
  add: 'Adds light; black disappears (glows, light leaks)',
  multiply: 'Darkens; white disappears (shadows, paper textures)',
  screen: 'Lightens; black disappears (flares, smoke, sparks)',
  overlay: 'Multiply on darks, screen on lights (contrast textures)',
  darken: 'Keeps the darker of the two',
  lighten: 'Keeps the lighter of the two',
  color_dodge: 'Brightens below by the clip, strongly',
  color_burn: 'Darkens below by the clip, strongly',
  hard_light: 'Overlay driven by the clip',
  soft_light: 'Gentle overlay',
  difference: 'Absolute difference; inverts under white',
  exclusion: 'Softer difference',
};

const MASKS: Record<MaskShape, string> = {
  rectangle: 'x, y, width, height, rotation, corner_radius',
  ellipse: 'x, y, width, height, rotation',
  linear: 'Keeps everything below a line through x, y; rotation turns the line',
  mirror: 'Keeps a band of thickness height through x, y; rotation turns it',
  heart: 'x, y, width, height, rotation',
  star: 'Five points; x, y, width, height, rotation',
  polygon: 'points: [[x, y], ...] corners in the clip picture',
};

const IN_OUT: Record<(typeof IN_OUT_ANIMATIONS)[number], string> = {
  fade: 'Opacity from 0',
  zoom_in: 'Grows into place while fading in; as an exit, grows while fading out',
  zoom_out: 'Shrinks into place while fading in; as an exit, shrinks away',
  slide_left: 'Moves left into place from the right; as an exit, leaves to the left',
  slide_right: 'Moves right into place from the left; as an exit, leaves to the right',
  slide_up: 'Rises into place from below; as an exit, leaves upwards',
  slide_down: 'Drops into place from above; as an exit, leaves downwards',
  pop: 'Scales up from nothing with an overshoot',
  spin: 'Turns a full circle while growing',
  drop: 'Falls in and bounces',
};

const LOOPS: Record<(typeof LOOP_ANIMATIONS)[number], string> = {
  pulse: 'Breathes in size',
  sway: 'Rocks side to side',
  shake: 'Jitters in place (camera shake)',
  float: 'Bobs up and down',
  spin: 'Turns continuously; strength sets turns per period',
  flicker: 'Dims at random',
};

const TRANSITIONS: Record<TransitionKind, string> = {
  dissolve: 'The next clip fades in over the last',
  dip_to_black: 'Fades to black and up into the next clip',
  dip_to_white: 'Fades to white and back down into the next clip',
  wipe_left: 'An edge moves left, revealing the next clip from the right',
  wipe_right: 'An edge moves right, revealing the next clip from the left',
  wipe_up: 'An edge moves up, revealing the next clip from the bottom',
  wipe_down: 'An edge moves down, revealing the next clip from the top',
  slide_left: 'The next clip slides in from the right, over the last',
  slide_right: 'The next clip slides in from the left, over the last',
  slide_up: 'The next clip slides up from below, over the last',
  slide_down: 'The next clip slides down from above, over the last',
  push_left: 'The next clip pushes the last out to the left',
  push_right: 'The next clip pushes the last out to the right',
  push_up: 'The next clip pushes the last out upwards',
  push_down: 'The next clip pushes the last out downwards',
  zoom_in: 'The next clip grows into place as it fades in',
  zoom_out: 'The last clip grows away as the next fades in',
  iris: 'The next clip opens from a circle in the centre',
  spin: 'The next clip spins in from small',
  crossfade: 'Audio only: equal-power fade from one clip into the next',
};

const HIGHLIGHT_TEXT: Record<(typeof HIGHLIGHTS)[number], string> = {
  none: 'No highlight',
  karaoke: 'Each word turns to the highlight colour as it is spoken, and stays',
  fill: 'Like karaoke, but the colour sweeps across each word',
  word: 'Only the word being spoken is in the highlight colour',
  pop: 'The word being spoken is in the highlight colour and grows a little',
};

const REVEAL_TEXT: Record<(typeof TEXT_REVEALS)[number], string> = {
  none: 'All at once',
  typewriter: 'Letter by letter over reveal_frames',
  word_fade: 'Word by word, each fading in',
  word_pop: 'Word by word, each popping up from nothing',
};

const CATALOGS: Record<string, { title: string; body: unknown | (() => Promise<unknown>) }> = {
  presets: {
    title: 'Export presets',
    body: {
      note: 'export.video {preset, overrides?}. overrides: width/height (a box; aspect kept), fps, bitrate (e.g. "8M") or crf, where the preset takes them. export.timeline writes fcpxml, otio, edl, srt or vtt.',
      presets: presetCatalog(),
    },
  },
  effects: {
    title: 'Effects',
    body: {
      note: 'filter.add {clip_id | track_id | timeline: true, name, params}. Video effects go on video clips, tracks or the timeline (and adjustment clips); audio effects on audio. Numbers marked animatable take {keyframes: [{frame, value, ease}]}.',
      effects: Object.fromEntries(
        Object.entries(EFFECTS).map(([name, spec]) => [
          name,
          {
            kind: spec.kind,
            about: spec.about,
            params: Object.fromEntries(
              Object.entries(spec.params).map(([k, p]) => [
                k,
                p.kind === 'number'
                  ? {
                      range: [p.min, p.max],
                      default: p.default,
                      animatable: Boolean(p.animatable),
                      about: p.about,
                    }
                  : p.kind === 'choice'
                    ? { one_of: p.values, default: p.default, about: p.about }
                    : p.kind === 'colour'
                      ? { colour: true, default: p.default, about: p.about }
                      : { media_id: true, about: p.about },
              ]),
            ),
          },
        ]),
      ),
    },
  },
  text: {
    title: 'Text styles',
    body: {
      note: 'Sizes are fractions of the frame height (size) or of the text size (outline, shadow, box padding, letter_spacing); x, y and max_width are fractions of the frame. Captions default to bold white Inter with a black outline at the bottom; titles to bold white Inter with a soft shadow in the centre. Highlights need caption word timings.',
      highlight: HIGHLIGHT_TEXT,
      reveal: REVEAL_TEXT,
    },
  },
  fonts: {
    title: 'Fonts',
    body: async () => ({
      note: 'Families text styles can name. Import other .ttf/.otf files with media.import and set font_media_id.',
      families: await installedFonts(),
    }),
  },
  transitions: {
    title: 'Transitions',
    body: {
      note: 'transition.add at the cut after a clip, centred on the cut. Linked audio gets a crossfade automatically.',
      kinds: TRANSITIONS,
    },
  },
  eases: {
    title: 'Keyframe easing',
    body: {
      note: 'A keyframe ease shapes the move into the next keyframe. Default linear. hold jumps at the next keyframe.',
      eases: EASES,
    },
  },
  blend_modes: {
    title: 'Blend modes',
    body: Object.fromEntries(BLEND_MODES.map((m) => [m, BLEND[m]])),
  },
  mask_shapes: {
    title: 'Mask shapes',
    body: {
      note: 'Positions and sizes are fractions of the clip picture (0–1). feather is a fraction of its short side.',
      shapes: Object.fromEntries(MASK_SHAPES.map((m) => [m, MASKS[m]])),
    },
  },
  animations: {
    title: 'Animation presets',
    body: {
      note: 'Presets layer over the clip transform: in runs from the clip start, out ends at the clip end, loop repeats every period_frames (default 1 s) at strength (default 1).',
      in_out: IN_OUT,
      loop: LOOPS,
    },
  },
};

export function registerCatalogs(server: McpServer): void {
  server.registerResource(
    'catalog',
    new ResourceTemplate('video://catalog/{name}', {
      list: async () => ({
        resources: Object.entries(CATALOGS).map(([name, c]) => ({
          uri: `video://catalog/${name}`,
          name,
          title: c.title,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Catalogues',
      description: `Names tools accept and what each does: ${Object.keys(CATALOGS).join(', ')}`,
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const entry = CATALOGS[String(vars.name)];
      if (!entry) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown catalogue ${String(vars.name)}; try ${Object.keys(CATALOGS).join(', ')}`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              typeof entry.body === 'function' ? await entry.body() : entry.body,
            ),
          },
        ],
      };
    },
  );
}
