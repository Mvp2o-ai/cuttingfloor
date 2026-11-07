// The claim the home page leads with, and the proof under it: what a desktop editor does, and the
// tools an agent calls to do it. The home page, its Markdown twin and llms.txt read this, so the
// three say the same thing. The claim rests on /compare: every other hosted video MCP is an editor
// app with its own AI inside (checked 2026-11-07); the agent-free ones are a render API and a
// template renderer.

import { TOOL_COUNT } from './tools.ts';

export const TOOLKIT_HEADLINE =
  'The most complete video and motion graphics toolkit for your agent.';

export const TOOLKIT_LEDE = `CapCut, Premiere and After Effects can make almost any edit, if a professional editor drives them. Now you have one: ChatGPT, Claude or Kazi. The other hosted video editing MCPs are editor apps with their own AI inside. cuttingfloor is just the tools, ${TOOL_COUNT} of them, granular enough to combine in endless ways, so the agent you already use can make virtually any edit a desktop editor can.`;

export const TOOLKIT_LINE = 'You bring the intelligence. We bring the tools.';

/** What you'd reach for in a desktop editor, and the tools your agent calls instead. */
export const DESKTOP_TOOLS: { does: string; tools: string[] }[] = [
  {
    does: 'Ripple, roll, slip and slide trims',
    tools: ['clip.trim', 'clip.roll', 'clip.slip', 'clip.slide'],
  },
  { does: 'Speed ramps, reverse and freeze frames', tools: ['clip.set_speed', 'clip.freeze'] },
  {
    does: 'Keyframed position, scale, rotation and opacity',
    tools: ['clip.set_transform', 'clip.set_animation'],
  },
  { does: 'Masks and blend modes', tools: ['clip.set_mask', 'clip.set_blend'] },
  { does: 'Adjustment layers and nested sequences', tools: ['adjustment.add', 'clip.add'] },
  { does: 'Colour, LUTs, green screen, blur and glitch', tools: ['filter.add'] },
  {
    does: 'Background removal, stabilizing and upscaling',
    tools: ['create.cutout', 'create.stabilized', 'create.upscaled'],
  },
  {
    does: 'Motion graphics, titles and word-timed captions',
    tools: ['create.motion', 'title.add', 'caption.add'],
  },
  {
    does: 'A full mix: gain rides, EQ, compressor, stems, limiter',
    tools: ['audio.set_gain', 'filter.add', 'create.stems', 'audio.set_master'],
  },
  { does: 'Tracking faces and objects, finding beats and scenes', tools: ['media.analyze'] },
  { does: 'Hand-off to Premiere, Final Cut or Resolve', tools: ['export.timeline'] },
];
