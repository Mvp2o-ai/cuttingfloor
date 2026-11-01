// What cuttingfloor can do, for /features and /features.md. Each item is something a creator can ask
// for, then the tools that do it. Every claim is checked against the tool descriptions and schemas
// in packages/server and packages/schema; the catalogue names come from content/tools.ts, which is
// written from the server, so lists of effects, transitions and formats can't drift.

import { KEYS } from '../../content/facts.ts';
import {
  ANALYSES,
  ANIMATIONS,
  AUDIO_EFFECTS,
  BLEND_MODES,
  EXPORT_PRESETS,
  HIGHLIGHTS,
  LOOPS,
  MASK_SHAPES,
  TEXT_REVEALS,
  TIMELINE_FORMATS,
  TOOL_COUNT,
  TOOLS,
  TRANSITIONS,
  VIDEO_EFFECTS,
} from '../../content/tools.ts';
import { type GroupId, LINES } from './lines.ts';

export const TITLE = `Features: every video editing tool your agent gets (${TOOL_COUNT} tools)`;
export const DESCRIPTION = `Everything cuttingfloor can do, in plain words: cut by transcript, captions, voiceover, stems, mixing and loudness, effects, motion graphics, background removal, checks and export to MP4, FCPXML, OTIO and EDL. All ${TOOL_COUNT} MCP tools listed.`;
export const UPDATED = '2026-11-01';

export type Item = { say: string; tools: string[] };
export type Group = { id: GroupId; name: string; title: string; intro: string; items: Item[] };

/** "dip_to_black" → "dip to black"; a list of them, joined. */
const words = (names: readonly string[], skip: readonly string[] = []) =>
  names
    .filter((n) => !skip.includes(n))
    .map((n) => n.replace(/_/g, ' '))
    .join(', ');

export const GROUPS: Group[] = [
  {
    id: 'cut',
    name: 'Cut and arrange',
    title: 'Cut by what was said, not by timecode.',
    intro:
      'Every cut a video editor makes, as a tool your agent calls. Each edit makes a new version, and every earlier version stays, so going back is one step.',
    items: [
      {
        say: 'Cut by words: pick a line from the transcript, from one word to another, and it lands on the timeline as a clip.',
        tools: ['media.analyze', 'clip.add'],
      },
      {
        say: 'Cut out pauses, ums, mistakes or any stretch of time across every track at once, closing the gap.',
        tools: ['range.extract', 'range.lift'],
      },
      {
        say: 'Place, move, trim, split and remove clips; trim only the sound for J and L cuts.',
        tools: ['clip.add', 'clip.move', 'clip.trim', 'clip.split', 'clip.remove'],
      },
      {
        say: 'Choose between takes: compare their transcripts and frames, keep the best and swap footage in place without losing the timing or look.',
        tools: ['judge.ask', 'clip.replace'],
      },
      {
        say: 'Roll, slip and slide edits: move a cut, show a different part of a clip, or move a clip between its neighbours.',
        tools: ['clip.roll', 'clip.slip', 'clip.slide'],
      },
      {
        say: 'Speed: faster, slower, a speed ramp over the clip, or reverse, with the pitch kept.',
        tools: ['clip.set_speed'],
      },
      { say: 'Freeze frames: hold any frame for as long as you like.', tools: ['clip.freeze'] },
      {
        say: 'Nesting: drop one edit into another of the same size and frame rate as a single clip.',
        tools: ['clip.add'],
      },
      {
        say: 'Tracks: add, remove, mute, hide and lock video and audio tracks; link picture and sound so they move together.',
        tools: ['track.add', 'track.set', 'clip.link', 'clip.unlink'],
      },
      {
        say: 'Change size and frame rate at any point, e.g. 16:9 to 9:16 for Shorts, Reels and TikTok, keeping every clip in time.',
        tools: ['timeline.set_sequence'],
      },
      {
        say: 'Many edits as one change, all or nothing, with one preview.',
        tools: ['edit.batch'],
      },
    ],
  },
  {
    id: 'text',
    name: 'Captions and text',
    title: 'Captions that keep time.',
    intro:
      'Captions come from the transcript, so they land on the words and follow every cut and speed change.',
    items: [
      {
        say: 'Captions from the transcript, an SRT or a VTT, burned into the export.',
        tools: ['caption.add'],
      },
      {
        say: `Word highlights as each word is said: ${words(HIGHLIGHTS, ['none'])}.`,
        tools: ['caption.add', 'text.set'],
      },
      {
        say: `Titles with font, size, colour, outline, shadow and box, revealed by ${words(TEXT_REVEALS, ['none'])}.`,
        tools: ['title.add'],
      },
      {
        say: 'Restyle every caption on a track at once, or change any title’s words.',
        tools: ['text.set'],
      },
      {
        say: 'Use your own fonts: import a .ttf or .otf file.',
        tools: ['media.import', 'text.set'],
      },
      { say: 'Export captions as SRT or VTT files.', tools: ['export.timeline'] },
    ],
  },
  {
    id: 'audio',
    name: 'Audio and voice',
    title: 'Mix like an engineer. Hear what is there.',
    intro:
      'Voice, music and sound get the same care as the picture: words timed, stems split, levels ridden, effects on, and the loudness measured after every change.',
    items: [
      {
        say: 'Transcripts with a time on every word (Whisper). For English the word edges are aligned to the sound, to about 0.05 s; other languages keep Whisper’s timing.',
        tools: ['media.analyze'],
      },
      {
        say: 'Voiceover from English text in a natural voice (Kokoro), with every word timed, so captions and cuts land on it.',
        tools: ['create.voiceover'],
      },
      {
        say: 'Stems: split any sound into voice, drums, bass and everything else (Demucs), or everything but the voice in one file. Lose the music under an interview, or keep only the music.',
        tools: ['create.stems'],
      },
      {
        say: 'Volume rides with keyframes, pan left to right, and fades in and out.',
        tools: ['audio.set_gain', 'audio.set_pan', 'audio.fade'],
      },
      {
        say: 'Duck the music under speech: speech spans from the voice-activity detector become gain keyframes on the music.',
        tools: ['media.analyze', 'audio.set_gain'],
      },
      {
        say: `Sound effects: ${words(AUDIO_EFFECTS)}. EQ, compressor, denoise (including a neural voice cleaner for speech) and pitch, on a clip, a track or the whole mix.`,
        tools: ['filter.add'],
      },
      {
        say: 'Master gain and a peak limiter on the whole mix.',
        tools: ['audio.set_master'],
      },
      {
        say: 'Loudness measured and shown: every audio edit previews as a waveform with its loudness; checks give integrated loudness (LUFS), true peak (dBTP) and loudness range.',
        tools: ['audio.set_gain', 'qa.check', 'media.analyze'],
      },
      {
        say: 'Listen for sounds you describe in plain words: laughter, applause, a cough, a door, music starting. Or find 447 named sounds as data.',
        tools: ['media.listen', 'media.analyze'],
      },
      {
        say: 'Line up a camera with a separate microphone, or two cameras, from their sound.',
        tools: ['media.correlate'],
      },
      {
        say: 'Lip-sync: redraw a speaker’s mouth to match new words, to fix a line without a reshoot. Runs on your own sync. labs key.',
        tools: ['create.lipsync'],
      },
    ],
  },
  {
    id: 'look',
    name: 'Look and effects',
    title: 'Colour, overlays and motion.',
    intro:
      'Grade it, key it, mask it, animate it. Effects go on a clip, a track or the whole video, and any number can change over time with keyframes.',
    items: [
      {
        say: `Picture effects: ${words(VIDEO_EFFECTS)}. Colour, LUTs (.cube), blur, vignette and chroma key (green screen) among them.`,
        tools: ['filter.add', 'filter.set'],
      },
      {
        say: 'Grade or blur everything underneath for a stretch of the video with an adjustment clip.',
        tools: ['adjustment.add'],
      },
      {
        say: 'Picture-in-picture, overlays and punch-ins: position, scale, rotate, crop, flip and fade, animated with keyframes and eases.',
        tools: ['clip.set_transform'],
      },
      {
        say: `Masks: ${words(MASK_SHAPES)}, with feather and invert, animated.`,
        tools: ['clip.set_mask'],
      },
      { say: `Blend modes: ${words(BLEND_MODES)}.`, tools: ['clip.set_blend'] },
      {
        say: `Entrance and exit animations (${words(ANIMATIONS)}) and loops (${words(LOOPS)}).`,
        tools: ['clip.set_animation'],
      },
      {
        say: `Transitions at a cut: ${words(TRANSITIONS, ['crossfade'])}. Linked sound crossfades at the same cut, and a sound-only crossfade is there too.`,
        tools: ['transition.add', 'transition.set', 'transition.remove'],
      },
      {
        say: 'Pin a title, sticker or mask to a moving subject from its tracked position; reframe wide shots to vertical around the faces.',
        tools: ['media.analyze', 'clip.set_transform'],
      },
    ],
  },
  {
    id: 'create',
    name: 'Create from nothing',
    title: 'Make what you don’t have.',
    intro:
      'No footage needed. Your agent writes the graphics as HTML and they render frame-exactly; voice and backgrounds are made on the server.',
    items: [
      {
        say: 'Motion graphics from animated HTML, with transparency: lower thirds, animated titles, callouts, logo stings, kinetic type. Up to 60 seconds each.',
        tools: ['create.motion'],
      },
      {
        say: 'Stills from HTML as PNG, transparent where nothing is painted: title and end cards, thumbnails, overlays.',
        tools: ['create.still'],
      },
      {
        say: 'Mattes: solid colours and gradients for backgrounds and colour washes.',
        tools: ['create.matte'],
      },
      { say: 'Voiceover with timed words.', tools: ['create.voiceover'] },
      {
        say: 'Background removal for people (fast enough for long video) or any subject: products, animals, objects. Video comes out with transparency and its sound.',
        tools: ['create.cutout'],
      },
      { say: 'Stabilize shaky handheld footage.', tools: ['create.stabilized'] },
    ],
  },
  {
    id: 'analyze',
    name: 'Analyze and judge',
    title: 'Footage turned into facts.',
    intro:
      'Your agent can’t watch every second of your footage, so the server reads it and returns data it can cut on.',
    items: [
      {
        say: `Analyses: ${words(ANALYSES)}. Cut on beats, reframe on face boxes, follow a tracked object, find silences and scene changes.`,
        tools: ['media.analyze'],
      },
      {
        say: 'Find moments in plain words: “where the demo starts”, “a wide shot of a city street at night”, “frames too dark to see the faces”. In a file or in the edit as it renders.',
        tools: ['media.seek'],
      },
      {
        say: 'Typed visual judgments: yes or no, one of your choices, a score, or a box around something, about frames, stills and text, in about a second.',
        tools: ['judge.ask'],
      },
      {
        say: 'Ask the same questions of frames sampled across a whole video.',
        tools: ['media.analyze'],
      },
    ],
  },
  {
    id: 'review',
    name: 'Review',
    title: 'It looks before it ships.',
    intro:
      'Every edit can come back with a picture of the result, so your agent sees what it made and fixes it before you watch.',
    items: [
      {
        say: 'A preview with every edit: frames of the picture, or a waveform with loudness for sound.',
        tools: ['clip.add', 'audio.set_gain'],
      },
      {
        say: 'Frames of the edit or any file, as a contact sheet or full-size stills; transparency shown honestly over a checkerboard.',
        tools: ['render.frames'],
      },
      {
        say: 'A small, quick review render to watch the cut with sound.',
        tools: ['export.video'],
      },
      {
        say: 'QA checks on the render: gaps, missing media, frame count, loudness and true peak, black and silent stretches, and, cut by cut, whether it lands while someone is speaking or clips a word.',
        tools: ['qa.check'],
      },
      {
        say: 'What changed between two versions, and the full history of edits to step back through.',
        tools: ['timeline.diff', 'timeline.history'],
      },
    ],
  },
  {
    id: 'export',
    name: 'Export',
    title: 'A finished file, or the edit itself.',
    intro:
      'Get a video to post, or take the edit into the editing app you already use and keep going by hand.',
    items: [
      {
        say: `Presets: ${EXPORT_PRESETS.join(', ')}. MP4 (H.264 or AV1), vertical 9:16, ProRes, GIF, WAV and MP3; size, frame rate and bitrate can be changed.`,
        tools: ['export.video'],
      },
      {
        say: `The edit for your editing app: ${TIMELINE_FORMATS.join(', ')}. FCPXML for Final Cut Pro and DaVinci Resolve, OTIO for Premiere and Resolve, EDL, and captions as SRT or VTT, optionally zipped with the media.`,
        tools: ['export.timeline'],
      },
      {
        say: 'A download link and a page to watch it in any browser, to share.',
        tools: ['export.video', 'media.get'],
      },
    ],
  },
  {
    id: 'basics',
    name: 'Media, timelines and jobs',
    title: 'Your files and your edits.',
    intro:
      'Bring footage in, keep track of it, and follow long jobs. Media is kept 7 days after last use, timelines a day; save the edit and load it back any time.',
    items: [
      {
        say: 'Import video, audio, images and fonts from a link (Dropbox and Google Drive share links work), an upload from your computer, or a file dropped on your account page.',
        tools: ['media.import', 'media.upload', 'media.list'],
      },
      {
        say: 'Phone footage is fixed on import: variable frame rate, rotation and HDR are conformed.',
        tools: ['media.import'],
      },
      {
        say: 'Save an edit and bring it back later.',
        tools: ['timeline.get', 'timeline.load'],
      },
      {
        say: 'Long jobs (imports, renders, analyses) run in the background with progress, and can be cancelled.',
        tools: ['job.get', 'job.list', 'job.cancel'],
      },
      {
        say: 'Skills: step-by-step instructions for common jobs, found by your agent in your own words.',
        tools: ['skills.search', 'skills.get'],
      },
    ],
  },
];

export const GROUP_NAME = Object.fromEntries(GROUPS.map((g) => [g.id, g.name])) as Record<
  GroupId,
  string
>;

/** Every tool the server lists, with its plain line and group, in the order of the groups. */
export const TOOL_ROWS = GROUPS.flatMap((g) =>
  TOOLS.filter((t) => LINES[t.name]?.group === g.id).map((t) => ({
    ...t,
    say: LINES[t.name]?.say ?? '',
    group: g.name,
  })),
);

// A tool the server lists with no plain line fails the build, so the table can't silently drop one.
const missing = TOOLS.filter((t) => !LINES[t.name]).map((t) => t.name);
if (missing.length)
  throw new Error(`No plain line in features/lines.ts for: ${missing.join(', ')}`);

/** How each tool runs, in words. */
export function runs(t: { longRunning: string }): string {
  if (t.longRunning === 'always') return 'Background job';
  if (t.longRunning === 'sometimes') return 'At once, or a job when long';
  return 'At once';
}

/** featureList for the structured data: the plain capability lines. */
export const FEATURE_LIST = GROUPS.flatMap((g) => g.items.map((i) => `${g.name}: ${i.say}`));

/** Whether a tool needs a key of your own, from KEYS in content/facts.ts. Empty when it needs none. */
export function keyNeed(name: string): string {
  for (const k of KEYS) {
    const entry = k.tools.find((t) => t === name || t.startsWith(`${name} `));
    if (!entry) continue;
    const part = entry.slice(name.length).trim();
    const when = k.hosted.startsWith('Included') ? 'Self-hosted only' : 'Hosted and self-hosted';
    return part ? `${when}: ${part.replace(/[()]/g, '')}` : when;
  }
  return '';
}
