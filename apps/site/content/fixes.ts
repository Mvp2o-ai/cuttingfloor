// The editing problems people search for most, in their words (US Google volumes from kwrds,
// 2026-11-06), each with what a connected agent does about it and a prompt to paste. Every claim
// holds for the server as it is: a logo is blurred or covered, never erased, and lip-sync runs on
// the user's own sync. labs key. Each fix has its own page, /fixes/<id>, titled with the question
// (answer engines cite the page whose title is the exact question); /fixes is the index. Pages
// about AI clips name several generators in the question and every one in the answer, since
// people search by the generator they use.

import { GENERATORS_LINE, type ToolCall } from './tool-calls.ts';

export type Fix = {
  /** The page, /fixes/<id>, and the anchor on /fixes that old links point at. */
  id: string;
  /** The problem as searched. */
  problem: string;
  answer: string;
  /** What to say to your agent, word for word. */
  prompt: string;
  /** A demo or guide that shows it. */
  see?: { label: string; href: string };
  /** A demo of the job, when `see` is a guide, so the page shows it done as well. */
  watch?: { label: string; href: string };
  /** Three or four other fixes, by id, linked at the foot of the page. */
  related: string[];
  /** The MCP tool calls the job uses, in order. */
  tools?: ToolCall[];
};

export const FIXES_UPDATED = '2026-11-23';

const AI_GUIDE = {
  label: 'How to turn AI video clips into a film',
  href: '/guides/turn-ai-video-clips-into-a-film',
};
const SOUNDS_GUIDE = {
  label: 'How to add sound effects to your Shorts with AI',
  href: '/guides/add-sound-effects-to-shorts',
};
const SHORTS_GUIDE = {
  label: 'How to turn a long video into Shorts with AI',
  href: '/guides/turn-a-long-video-into-shorts',
};
const GAMING_DEMO = {
  label: 'Turn a gaming stream into Shorts',
  href: '/demos/turn-a-gaming-stream-into-shorts',
};
const BRING: ToolCall = {
  tool: 'media.upload',
  does: 'brings in files from your device (media.import takes a link instead)',
};
const CHECK: ToolCall = {
  tool: 'render.frames',
  does: 'renders frames of the edit so the agent can look before exporting',
};
const EXPORT: ToolCall = {
  tool: 'export.video',
  does: 'renders the finished MP4 and gives you a download link and a page to watch it',
};

export const FIXES: Fix[] = [
  {
    id: 'compress-a-video',
    problem: 'How do I compress a video?',
    answer:
      'Ask for a smaller file and say what it is for. The agent exports again at a lower bitrate or size, tells you the new file size, and you can ask for smaller still.',
    prompt: 'Make this video small enough to email, under 25 MB, and keep it sharp.',
    related: ['trim-a-video', 'make-a-video-vertical', 'make-a-video-louder'],
  },
  {
    id: 'trim-a-video',
    problem: 'How do I trim a video?',
    answer:
      'Say where it should start and end, in seconds or in words: “cut everything before she says hello”. The agent reads the transcript, so it can trim on what is said.',
    prompt:
      'Trim this so it starts when I say “okay, let’s go” and ends after “see you next time”.',
    related: ['remove-words-and-mistakes', 'make-jump-cuts', 'compress-a-video'],
  },
  {
    id: 'remove-a-watermark-or-logo',
    problem: 'How do I remove a watermark or logo from a video?',
    answer:
      'The agent finds the logo, follows it if it moves, and blurs it or covers it with a box or a crop. It does not repaint what was behind it, so a logo in the middle of the picture still shows a blur. It is for marks on footage you have the rights to edit; the cuttingfloor watermark on an export comes off when you remove it with credits.',
    prompt: 'Blur the logo in the bottom right corner for the whole video.',
    related: ['blur-a-face', 'remove-the-background', 'add-text'],
  },
  {
    id: 'make-jump-cuts',
    problem: 'How do I make jump cuts?',
    answer:
      'The agent cuts the pauses and dead air between sentences, on word timings so no word is clipped, and can add a small punch-in at each cut so the jumps look meant.',
    prompt:
      'Jump cut this talking video: take out the pauses and add a slight zoom on every other cut.',
    see: {
      label: 'Remove pauses and restarts',
      href: '/demos/remove-pauses-and-restarts-from-a-talking-video',
    },
    related: ['remove-words-and-mistakes', 'trim-a-video', 'add-subtitles'],
  },
  {
    id: 'speed-up-or-slow-down',
    problem: 'How do I speed up a video, or make slow motion?',
    answer:
      'Name the part and the speed. The agent changes the speed of that stretch, can ramp into it smoothly, and keeps the sound in step or mutes it.',
    prompt: 'Play the part from 0:12 to 0:20 at half speed, with a smooth ramp in and out.',
    related: ['trim-a-video', 'stabilize-shaky-video', 'add-music'],
  },
  {
    id: 'stabilize-shaky-video',
    problem: 'How do I stabilize shaky video?',
    answer:
      'Tell it which shot is shaky. The agent makes a steadied copy of the clip and swaps it into the edit, cropping in slightly to hide the moving edges.',
    prompt: 'This walking shot is shaky. Stabilize it.',
    related: ['colour-correct', 'speed-up-or-slow-down', 'make-a-video-vertical'],
  },
  {
    id: 'add-music',
    problem: 'How do I add music to a video?',
    answer:
      'Give it a song, or ask for music made for the video. The agent lays it under the video, lowers it while someone is talking, fades it in and out, and cuts to its beats. Made music is built in layers you can change, with the beat on the cuts.',
    prompt: 'Add this song under the video, quieter when I talk, and fade it out at the end.',
    see: { label: 'Edit a dance Short to the beat', href: '/demos/edit-a-dance-short-to-the-beat' },
    related: ['make-a-video-louder', 'remove-background-noise', 'add-a-voiceover'],
  },
  {
    id: 'remove-the-background',
    problem: 'How do I remove the background from a video?',
    answer:
      'The agent cuts the person out of the background, or keys out a green screen, and puts them over a new background, a colour or another video.',
    prompt: 'Remove the background behind me and put me over this picture of a beach.',
    related: ['blur-a-face', 'remove-a-watermark-or-logo', 'colour-correct'],
  },
  {
    id: 'remove-background-noise',
    problem: 'How do I remove background noise from a video?',
    answer:
      'The agent runs noise reduction and voice cleanup on the voice, and can split the voice from music or room sound, then measures the loudness so it ends at a level that sounds right.',
    prompt: 'There is a fan humming in the background. Clean up my voice so it is clear.',
    related: ['make-a-video-louder', 'fix-audio-out-of-sync', 'add-music'],
  },
  {
    id: 'add-subtitles',
    problem: 'How do I add subtitles or captions to a video?',
    answer:
      'The agent transcribes the speech with a time for every word and adds captions that follow it, each word highlighted as it is said, in the style you describe. It can also give you an SRT or VTT file.',
    prompt: 'Add big word-by-word captions, white with a yellow highlight, in the lower third.',
    see: { label: 'How to add captions to a video', href: '/guides/add-captions-to-a-video' },
    related: ['add-text', 'make-a-video-vertical', 'add-a-voiceover'],
  },
  {
    id: 'lip-sync',
    problem: 'How do I lip-sync a video?',
    answer:
      'The agent redraws the mouth of the person in your clip to new words, through sync. labs on your own key. Use it on your own footage, or on people who agreed.',
    prompt: 'Make my mouth match this new voiceover in the first ten seconds.',
    related: ['add-a-voiceover', 'fix-audio-out-of-sync', 'add-subtitles'],
  },
  {
    id: 'blur-a-face',
    problem: 'How do I blur a face in a video?',
    answer:
      'The agent finds the faces, follows the one you mean through the shot, and blurs only that one, for as long as it is on screen.',
    prompt: 'Blur the face of the man in the background for the whole clip.',
    related: ['remove-a-watermark-or-logo', 'remove-the-background', 'add-text'],
  },
  {
    id: 'add-text',
    problem: 'How do I add text to a video?',
    answer:
      'Say the words, where and when. The agent adds a title in the style you describe, animates it on and off, and can pin it to something that moves.',
    prompt: 'Put “3 tips for your first Short” at the top for the first three seconds.',
    related: ['add-subtitles', 'remove-a-watermark-or-logo', 'add-a-voiceover'],
  },
  {
    id: 'remove-words-and-mistakes',
    problem: 'How do I cut words, ums and mistakes out of a video?',
    answer:
      'The agent reads the transcript, finds the ums, false starts and repeated takes, and cuts them out on word timings so no word is clipped. Or name the words to go.',
    prompt: 'Cut the ums, the restarts and the second time I say “just post it”.',
    see: {
      label: 'Remove pauses and restarts',
      href: '/demos/remove-pauses-and-restarts-from-a-talking-video',
    },
    related: ['make-jump-cuts', 'trim-a-video', 'add-subtitles'],
  },
  {
    id: 'fix-audio-out-of-sync',
    problem: 'How do I fix audio that is out of sync with the video?',
    answer:
      'The agent measures how far the sound is off by comparing it with the camera’s own sound, then slides it into place to the frame.',
    prompt: 'My microphone recording is out of sync with the camera. Line them up.',
    related: ['remove-background-noise', 'make-a-video-louder', 'lip-sync'],
  },
  {
    id: 'make-a-video-louder',
    problem: 'How do I make a video louder?',
    answer:
      'The agent raises the level, evens out loud and quiet parts, and measures the result so it lands at the loudness YouTube and TikTok expect without clipping.',
    prompt: 'The sound is too quiet. Make it as loud as a normal YouTube video.',
    related: ['remove-background-noise', 'add-music', 'fix-audio-out-of-sync'],
  },
  {
    id: 'colour-correct',
    problem: 'How do I colour correct a video, or fix a dark one?',
    answer:
      'Describe the look. The agent grades the clip, brightens what is too dark, matches shots to each other, and checks frames so you can see it before it exports.',
    prompt: 'This is too dark and a bit blue. Brighten it and make it warmer.',
    related: ['stabilize-shaky-video', 'remove-the-background', 'make-a-video-vertical'],
  },
  {
    id: 'make-a-video-vertical',
    problem: 'How do I make a video vertical, or turn a long video into Shorts?',
    answer:
      'The agent fills the 9:16 frame and moves the crop shot by shot to keep the speaker’s face in view, with no black bars. For Shorts, it imports the long video once, finds the moments you name or describe from the transcript and the picture, cuts each on whole sentences with the hook first, and captions every word.',
    prompt:
      'Turn this 20-minute podcast into three vertical Shorts of its best moments, with captions.',
    see: {
      label: 'How to turn a long video into Shorts with AI',
      href: '/guides/turn-a-long-video-into-shorts',
    },
    watch: {
      label: 'Turn a gaming stream into Shorts',
      href: '/demos/turn-a-gaming-stream-into-shorts',
    },
    related: ['add-subtitles', 'trim-a-video', 'compress-a-video'],
  },
  {
    id: 'add-a-voiceover',
    problem: 'How do I add an AI voiceover to a video?',
    answer:
      'Give it the script. The agent makes the voice with a time for every word, lays it in, and can caption it and time the cuts to it.',
    prompt: 'Add a calm voiceover reading this script, and caption it.',
    related: ['add-subtitles', 'add-music', 'lip-sync'],
  },
  {
    id: 'edit-ai-video-clips-into-one-video',
    problem: 'How do I edit Kling, Veo, Sora or Runway clips into one video?',
    answer: `Give your agent the clips and say the order. Clips from ${GENERATORS_LINE} all work, mixed together. It cuts each clip to its best part, trims the warped frames at the ends, blends the joins, evens out colour and sound, and exports one MP4. Your shots are cut, never regenerated.`,
    prompt:
      'Here are my AI clips. Put them in this order, cut the weird frames at the start and end of each, blend the joins, make the colour match, and export one 1080p MP4.',
    see: AI_GUIDE,
    related: [
      'make-a-short-film-from-ai-clips',
      'add-transitions-between-short-ai-clips',
      'match-colour-between-ai-clips',
      'cut-the-warped-frames-at-the-end-of-an-ai-clip',
    ],
    tools: [
      BRING,
      { tool: 'media.analyze (look)', does: 'answers questions about sampled frames of each clip' },
      { tool: 'timeline.create', does: 'sets the finished size and frame rate' },
      { tool: 'edit.batch', does: 'adds every clip in order in one call (clip.add, clip.trim)' },
      { tool: 'transition.add', does: 'blends each join' },
      { tool: 'filter.add', does: 'corrects the colour of the clips that are off' },
      { tool: 'audio.set_gain', does: 'evens out clips that came with sound' },
      CHECK,
      {
        tool: 'qa.check',
        does: 'measures the render: gaps, missing media, loudness and peak, black or silent stretches',
      },
      EXPORT,
    ],
  },
  {
    id: 'make-a-short-film-from-ai-clips',
    problem: 'How do I make a short film from Kling, Veo or Sora clips?',
    answer: `Tell your agent the story and give it the clips, from ${GENERATORS_LINE}. It puts the shots in story order, cuts each on its strongest moment, adds titles and credits, a voiceover if you want one, sound effects, and music made for it or your own, then checks the film and exports it.`,
    prompt:
      'Make a short film from these clips. The story: a lost robot finds its way home. Put the shots in story order, add a title at the start and credits at the end, add sound effects and my music, and export it in 16:9.',
    see: AI_GUIDE,
    related: [
      'edit-ai-video-clips-into-one-video',
      'add-sound-effects-to-ai-video',
      'make-several-versions-of-an-edit',
    ],
    tools: [
      BRING,
      {
        tool: 'media.analyze (look)',
        does: 'describes what happens in each clip so it can go in story order',
      },
      { tool: 'timeline.create', does: 'sets 16:9, the size and frame rate' },
      { tool: 'clip.add', does: 'lays the shots down in story order' },
      { tool: 'clip.trim', does: 'cuts each shot to its strongest moment' },
      { tool: 'transition.add', does: 'blends scene changes' },
      { tool: 'title.add', does: 'the title card and the credits' },
      { tool: 'create.voiceover', does: 'a narrator from your script, with a time for each word' },
      { tool: 'sounds.list', does: 'finds sounds by description; the user hears them in the chat' },
      { tool: 'media.import', does: 'brings in the sounds picked' },
      { tool: 'audio.fade', does: 'fades music in and out' },
      { tool: 'audio.set_master', does: 'sets the final loudness, with a limiter' },
      CHECK,
      EXPORT,
    ],
  },
  {
    id: 'edit-ai-clips-and-capcut-footage-together',
    problem: 'How do I edit AI clips and CapCut exports together?',
    answer: `Export what you made in CapCut as an MP4, then give it to your agent with your clips from ${GENERATORS_LINE}. They go on one timeline at one size and frame rate, so you can cut between them, blend the joins and export one video. CapCut project files themselves can’t be opened.`,
    prompt:
      'Here is my CapCut export and three AI clips. Start with the CapCut part, then the clips in this order, blend each join, and export it at 1080p.',
    see: AI_GUIDE,
    related: [
      'edit-ai-video-clips-into-one-video',
      'mix-different-sizes-and-frame-rates',
      'add-transitions-between-short-ai-clips',
    ],
    tools: [
      BRING,
      { tool: 'media.get', does: 'reads each file’s size, frame rate, length and sound' },
      { tool: 'timeline.create', does: 'sets one size and frame rate for everything' },
      { tool: 'clip.add', does: 'puts the CapCut part and the clips in order' },
      { tool: 'clip.set_transform', does: 'crops or zooms a clip that doesn’t fill the frame' },
      { tool: 'transition.add', does: 'blends the joins' },
      EXPORT,
    ],
  },
  {
    id: 'add-transitions-between-short-ai-clips',
    problem: 'How do I add transitions between short Kling, Veo or Sora clips?',
    answer:
      'A blend needs footage past the cut on both sides, and a 5 to 10 second AI clip has little to spare once it is trimmed. Ask for transitions; when one is too long, the server says how many frames each side has and the longest that fits, and your agent uses that. Short dissolves and wipes work best.',
    prompt:
      'Add a short dissolve between every clip. If a dissolve doesn’t fit, use the longest one that does.',
    see: AI_GUIDE,
    related: [
      'edit-ai-video-clips-into-one-video',
      'make-a-short-ai-clip-longer',
      'cut-the-warped-frames-at-the-end-of-an-ai-clip',
    ],
    tools: [
      {
        tool: 'transition.add',
        does: 'adds a dissolve, wipe, push or zoom at a cut; a refusal gives the frames to spare',
      },
      { tool: 'transition.set', does: 'changes a transition’s kind or length' },
      { tool: 'clip.trim', does: 'leaves more footage past a cut when a blend needs it' },
      {
        tool: 'export.video (mp4_h264_fast)',
        does: 'a quick render of the joins to watch them move',
      },
    ],
  },
  {
    id: 'match-colour-between-ai-clips',
    problem: 'How do I make Kling, Veo and Sora clips match in colour?',
    answer:
      'Clips from different generations, or different generators, rarely match. Your agent measures each clip’s colour, then adjusts brightness, temperature, saturation and curves on the ones that are off, or puts one look (a LUT) over the whole film, and compares frames side by side before exporting.',
    prompt:
      'Make all my clips match in colour, warm and a little dark like a film, and show me a frame from each before you export.',
    see: AI_GUIDE,
    related: [
      'colour-correct',
      'edit-ai-video-clips-into-one-video',
      'make-a-short-film-from-ai-clips',
    ],
    tools: [
      {
        tool: 'media.analyze (colour)',
        does: 'measures each clip’s colour, channel by channel',
      },
      {
        tool: 'filter.add',
        does: 'temperature, exposure, saturation or curves on a clip, or a LUT on the whole timeline',
      },
      { tool: 'filter.set', does: 'adjusts a correction after looking' },
      CHECK,
    ],
  },
  {
    id: 'cut-the-warped-frames-at-the-end-of-an-ai-clip',
    problem: 'How do I cut the warped frames at the start or end of an AI clip?',
    answer:
      'AI clips often warp, morph or freeze in their first or last moments. Your agent looks at frames from the ends of each clip, finds where the picture goes wrong, and trims each clip to the clean part. Say how strict to be, and it shows you the frames it cut at.',
    prompt:
      'Check the start and end of every clip for warping or morphing and trim each one to the clean part.',
    see: AI_GUIDE,
    related: [
      'trim-a-video',
      'add-transitions-between-short-ai-clips',
      'edit-ai-video-clips-into-one-video',
    ],
    tools: [
      CHECK,
      {
        tool: 'judge.ask',
        does: 'answers a typed question about frames, like whether a face warps',
      },
      {
        tool: 'media.analyze (picture)',
        does: 'every frame’s brightness and change, which shows sudden jumps',
      },
      { tool: 'clip.trim', does: 'cuts each clip to the clean part' },
    ],
  },
  {
    id: 'make-a-short-ai-clip-longer',
    problem: 'How do I make a 5-second Kling or Veo clip longer?',
    answer:
      'No model makes new footage here. Your agent can slow the clip down, with in-between frames built from its own movement so it stays smooth, hold a frame at the end, or play it forward then backward. For a longer shot from the generator itself, extend it there and bring in the new clip.',
    prompt:
      'Make this 5-second clip last 8 seconds: slow it down smoothly and hold the last frame.',
    see: AI_GUIDE,
    related: [
      'speed-up-or-slow-down',
      'add-transitions-between-short-ai-clips',
      'make-a-short-film-from-ai-clips',
    ],
    tools: [
      {
        tool: 'clip.set_speed',
        does: 'slows the clip; interpolate motion builds in-between frames; reverse plays it backward',
      },
      { tool: 'clip.freeze', does: 'holds a frame for as long as you say' },
      { tool: 'clip.add', does: 'adds the clip again, reversed, for a forward-and-back loop' },
    ],
  },
  {
    id: 'mix-different-sizes-and-frame-rates',
    problem: 'How do I edit AI clips with different sizes and frame rates together?',
    answer:
      'Pick the size and frame rate of the finished video, for example 1080p at 24 frames a second, wide or vertical. Every clip is fitted into that frame and played at that rate, so 720p, 1080p, square and vertical clips sit on one timeline. Your agent can zoom or crop a clip to fill the frame instead of showing bars.',
    prompt:
      'Put all these clips in one 1080p video at 24 fps, and zoom any clip that doesn’t fill the frame so there are no black bars.',
    see: AI_GUIDE,
    related: [
      'edit-ai-clips-and-capcut-footage-together',
      'make-a-video-vertical',
      'edit-ai-video-clips-into-one-video',
    ],
    tools: [
      { tool: 'media.get', does: 'reads each clip’s size and frame rate' },
      { tool: 'timeline.create', does: 'sets the finished size and frame rate' },
      { tool: 'clip.add', does: 'fits each clip into the frame' },
      { tool: 'clip.set_transform', does: 'zooms or moves a clip to fill the frame' },
      {
        tool: 'clip.set_speed (interpolate)',
        does: 'smooths a clip with fewer frames a second than the video',
      },
    ],
  },
  {
    id: 'add-sound-effects-to-ai-video',
    problem: 'How do I add sound effects to Kling, Veo or Sora video?',
    answer:
      'Most AI clips come silent or with rough sound. Your agent finds the moments that need a sound (a cut, a hit, a reveal), finds each sound you describe in a free library of about 20,000 sound effects, places them on their own track and sets their levels. Footsteps, ambience, whooshes and booms are all there; you can hear them in the chat first.',
    prompt:
      'Add sound effects: a whoosh on every cut, a boom when the title appears, and a riser before the last shot. Keep them under the music.',
    see: SOUNDS_GUIDE,
    related: ['add-music', 'even-out-the-sound-of-ai-clips', 'make-a-short-film-from-ai-clips'],
    tools: [
      {
        tool: 'media.analyze (scenes, beats)',
        does: 'finds the cuts and beats where sounds land',
      },
      {
        tool: 'media.import',
        does: 'brings in a sound picked with sounds.list, or your file',
      },
      { tool: 'track.add', does: 'an audio track for the effects' },
      { tool: 'clip.add', does: 'places each sound at its moment' },
      { tool: 'audio.set_gain', does: 'sets each sound’s level' },
    ],
  },
  {
    id: 'add-sound-effects-to-hailuo-video',
    problem: 'How do I add sound effects to Hailuo (MiniMax) videos?',
    answer:
      'If your Hailuo clips came out silent, give them to your agent and say where sounds should go. It finds the cuts and moments, places sound effects on their own track, sets each level and keeps them under music or a voice. Describe each sound and it finds the closest in a free library of about 20,000; your own sound files work too.',
    prompt:
      'These Hailuo clips are silent. Add a whoosh on every cut, a boom when the robot lands, a riser before the last shot, and keep it all under the music.',
    see: SOUNDS_GUIDE,
    related: [
      'add-sound-effects-to-ai-video',
      'even-out-the-sound-of-ai-clips',
      'edit-ai-video-clips-into-one-video',
      'add-music',
    ],
    tools: [
      BRING,
      {
        tool: 'media.analyze (look)',
        does: 'finds the moments that need a sound, like a landing or a door',
      },
      { tool: 'media.analyze (scenes)', does: 'the times of every cut' },
      {
        tool: 'media.import',
        does: 'brings in a sound picked with sounds.list, or your own file',
      },
      { tool: 'track.add', does: 'an audio track for the effects' },
      { tool: 'clip.add', does: 'places each sound at its moment' },
      { tool: 'audio.set_gain', does: 'sets each sound’s level, and lowers it under a voice' },
      { tool: 'audio.fade', does: 'softens a sound in or out' },
      EXPORT,
    ],
  },
  {
    id: 'even-out-the-sound-of-ai-clips',
    problem: 'How do I even out the sound of Veo and Sora clips?',
    answer:
      'Clips that come with their own sound are often at different levels. Your agent measures the loudness of each clip, sets each one’s level so they match, crossfades the sound at the joins and sets the final loudness for where it’s going, with a limiter so nothing clips.',
    prompt:
      'The sound jumps between my clips. Make every clip the same loudness, crossfade the sound at each cut, and set it for YouTube.',
    see: AI_GUIDE,
    related: ['make-a-video-louder', 'add-sound-effects-to-ai-video', 'add-music'],
    tools: [
      { tool: 'media.analyze (loudness)', does: 'measures each clip’s loudness and peak' },
      { tool: 'audio.set_gain', does: 'sets each clip’s level' },
      { tool: 'transition.add (crossfade)', does: 'crossfades the sound at a cut' },
      { tool: 'audio.set_master', does: 'the final loudness, with a limiter' },
    ],
  },
  {
    id: 'make-several-versions-of-an-edit',
    problem: 'How do I make a few versions of the same edit?',
    answer:
      'Every change makes a new version of the timeline and the old ones stay, so you can ask for a tighter cut, a different ending or other music and keep both. Your agent exports each version, can say what changed between two, and can go back to any earlier one.',
    prompt:
      'Keep this cut. Make a second version that’s 20 seconds shorter with a different ending, and export both.',
    see: AI_GUIDE,
    related: ['make-a-short-film-from-ai-clips', 'trim-a-video', 'compress-a-video'],
    tools: [
      { tool: 'timeline.history', does: 'lists the versions so far' },
      { tool: 'timeline.diff', does: 'says what changed between two versions' },
      { tool: 'timeline.get', does: 'the whole edit as a document you can keep' },
      { tool: 'timeline.load', does: 'brings a kept edit back later' },
      EXPORT,
    ],
  },
  {
    id: 'turn-gaming-clips-into-shorts',
    problem: 'How do I turn gaming clips into Shorts, TikToks and Reels?',
    answer:
      'Give your agent your clips (GTA, Fortnite, Call of Duty, Valorant, Minecraft or anything else) and say what to keep. It finds the plays worth showing, cuts each Short, reframes the wide gameplay to vertical, adds captions, sound effects, and music made for it or your own, and exports one MP4 per Short.',
    prompt:
      'Turn these gaming clips into three vertical Shorts of the best plays, with captions, a boom on each kill and an airhorn on the win.',
    see: SHORTS_GUIDE,
    watch: GAMING_DEMO,
    related: [
      'turn-a-long-gameplay-video-into-shorts',
      'make-a-gaming-montage',
      'add-a-song-to-gaming-clips',
    ],
    tools: [
      BRING,
      { tool: 'media.seek', does: 'finds a moment you describe in words, like a win screen' },
      {
        tool: 'media.analyze (transcript)',
        does: 'what was said, with a time for every word',
      },
      { tool: 'timeline.create', does: 'a vertical 1080×1920 Short' },
      { tool: 'clip.set_transform', does: 'reframes the wide gameplay to vertical' },
      { tool: 'caption.add', does: 'captions that highlight each word' },
      { tool: 'sounds.list', does: 'finds a boom or an airhorn in the sound library' },
      { tool: 'media.import', does: 'brings in the sound picked' },
      EXPORT,
    ],
  },
  {
    id: 'turn-a-livestream-into-shorts',
    problem: 'How do I turn a Twitch or YouTube livestream into Shorts?',
    answer:
      'Download the stream recording and send the file, or a direct link to it; a Twitch or YouTube page link won’t import. Your agent reads what was said, finds the moments you describe in the picture, and cuts them into vertical Shorts with captions, one MP4 each.',
    prompt:
      'Here is my stream recording. Find the five funniest moments and make each a vertical Short with captions.',
    see: SHORTS_GUIDE,
    watch: GAMING_DEMO,
    related: [
      'turn-gaming-clips-into-shorts',
      'turn-a-long-gameplay-video-into-shorts',
      'add-subtitles',
    ],
    tools: [
      BRING,
      { tool: 'media.analyze (transcript, speakers)', does: 'every word, and who said it' },
      { tool: 'media.search', does: 'finds moments across all your files from a description' },
      { tool: 'media.seek', does: 'finds a moment you describe in the picture' },
      { tool: 'clip.add', does: 'takes each moment out of the stream' },
      { tool: 'clip.set_transform', does: 'reframes to vertical' },
      { tool: 'caption.add', does: 'captions from the transcript' },
      EXPORT,
    ],
  },
  {
    id: 'turn-a-long-gameplay-video-into-shorts',
    problem: 'How do I turn a long gameplay video with no talking into Shorts?',
    answer:
      'Gameplay without talking can’t be cut from a transcript, so your agent finds the action another way: moments you describe in words (“a win screen”, “a car chase”), loud spikes in the sound, and gunshots or explosions it can hear. It cuts each into a vertical Short and exports them.',
    prompt:
      'This is 20 minutes of gameplay with no commentary. Find the big fights and explosions and make three vertical Shorts.',
    see: SHORTS_GUIDE,
    watch: GAMING_DEMO,
    related: [
      'turn-gaming-clips-into-shorts',
      'turn-a-livestream-into-shorts',
      'make-a-gaming-montage',
    ],
    tools: [
      { tool: 'media.seek', does: 'finds a moment you describe in the picture' },
      {
        tool: 'media.analyze (sounds)',
        does: 'when gunshots, explosions and other named sounds can be heard',
      },
      { tool: 'media.analyze (loudness, scenes)', does: 'loud spikes and big picture changes' },
      { tool: 'judge.ask', does: 'checks a candidate moment on its frames' },
      { tool: 'clip.add', does: 'takes each moment out' },
      { tool: 'clip.set_transform', does: 'reframes to vertical' },
      EXPORT,
    ],
  },
  {
    id: 'add-a-song-to-gaming-clips',
    problem: 'How do I add a song to my gaming clips?',
    answer:
      'Send the song with your clips. Your agent finds its beats, cuts the clips on them, lowers or mutes the game sound under the music, and fades the song out at the end. Songs you bring are yours to clear for where you post; with no song, ask for music made for the clips.',
    prompt:
      'Put this song under my clips, cut on the beat, keep the game sound quiet underneath, and fade out at the end.',
    watch: {
      label: 'Edit a dance Short to the beat',
      href: '/demos/edit-a-dance-short-to-the-beat',
    },
    related: ['add-music', 'make-a-gaming-montage', 'turn-gaming-clips-into-shorts'],
    tools: [
      BRING,
      { tool: 'media.analyze (beats)', does: 'the tempo and the time of every beat' },
      { tool: 'clip.add', does: 'places each clip to start on a beat' },
      { tool: 'audio.set_gain', does: 'turns the game sound down under the song' },
      { tool: 'audio.fade', does: 'fades the song out' },
      EXPORT,
    ],
  },
  {
    id: 'make-a-gaming-montage',
    problem: 'How do I make a gaming montage?',
    answer:
      'Give your agent your best clips and a song. It cuts the plays to the beat, adds speed ramps and slow motion on the big moments, freeze frames, zooms, sound effects like booms and airhorns, and text, then exports it wide for YouTube or vertical for Shorts.',
    prompt:
      'Make a montage of these clips to this song: cut on the beat, slow motion on every kill, a freeze frame and a boom on the last one.',
    see: SHORTS_GUIDE,
    watch: GAMING_DEMO,
    related: [
      'add-a-song-to-gaming-clips',
      'turn-gaming-clips-into-shorts',
      'speed-up-or-slow-down',
    ],
    tools: [
      { tool: 'media.analyze (beats)', does: 'the beat times to cut on' },
      { tool: 'clip.set_speed', does: 'speed ramps and slow motion' },
      { tool: 'clip.freeze', does: 'a freeze frame on the big moment' },
      { tool: 'clip.set_animation', does: 'shakes, pulses and zoom-ins' },
      { tool: 'sounds.list', does: 'finds booms and airhorns in the sound library' },
      { tool: 'media.import', does: 'brings in the sounds picked' },
      { tool: 'title.add', does: 'text on screen' },
      EXPORT,
    ],
  },
  {
    id: 'make-a-tribute-video',
    problem: 'How do I make a tribute video?',
    answer:
      'Bring the photos, clips and a song. Your agent puts them in order, moves slowly across each photo, adds names, dates and a closing card, blends between them and fits it all to the music, then exports it for sharing or for a screen at an event.',
    prompt:
      'Make a tribute video from these photos and clips with this song. Slow moves on the photos, gentle dissolves, a title with the name and dates at the start, and a closing card.',
    related: ['add-music', 'add-text', 'make-a-reel-from-your-best-takes'],
    tools: [
      BRING,
      { tool: 'clip.add', does: 'puts photos and clips in order' },
      { tool: 'clip.set_transform', does: 'a slow keyframed move across each photo' },
      { tool: 'transition.add', does: 'dissolves between them' },
      { tool: 'title.add', does: 'names and dates' },
      { tool: 'create.motion', does: 'an animated closing card' },
      { tool: 'media.analyze (beats)', does: 'times the changes to the music' },
      { tool: 'audio.fade', does: 'fades the song in and out' },
      EXPORT,
    ],
  },
  {
    id: 'make-a-reel-from-your-best-takes',
    problem: 'How do I make a Reel from my best takes?',
    answer:
      'Film the same thing a few times and give your agent every take. It compares them, picks the best one for each part and says why, cuts them together vertical, adds captions and music, and exports for Instagram Reels, TikTok or Shorts. You can overrule any pick.',
    prompt:
      'Here are all my takes. Pick the best one for each part, tell me why, and cut a vertical Reel with captions.',
    watch: { label: 'Pick your best take with AI', href: '/demos/pick-your-best-take-with-ai' },
    related: ['make-a-video-vertical', 'add-subtitles', 'add-music'],
    tools: [
      BRING,
      { tool: 'media.analyze (transcript)', does: 'what was said in each take, word by word' },
      { tool: 'judge.ask', does: 'compares takes on their frames and scores them' },
      { tool: 'timeline.create', does: 'a vertical 1080×1920 Reel' },
      { tool: 'clip.add', does: 'cuts the chosen takes together' },
      { tool: 'caption.add', does: 'captions that highlight each word' },
      EXPORT,
    ],
  },
  {
    id: 'make-a-product-promo-with-voiceover-and-music',
    problem: 'How do I make a product promo with a voiceover and music?',
    answer:
      'Send your product clips or photos, the script and your music, or ask for music made to fit. Your agent makes the voiceover from the script in an American or British English voice, or uses your own recording in any language, times the shots to the words, adds captions, lowers the music under the voice and ends on a card.',
    prompt:
      'Make a 30-second promo from these product shots with this music. Voiceover reading my script, captions, and end on my logo.',
    watch: { label: 'Edit a product review Short', href: '/demos/edit-a-product-review-short' },
    related: ['add-a-voiceover', 'add-music', 'add-subtitles'],
    tools: [
      { tool: 'create.voiceover', does: 'the voice from your script, with a time for every word' },
      BRING,
      { tool: 'clip.add', does: 'times each shot to the words' },
      { tool: 'caption.add', does: 'captions from the voiceover’s word times' },
      { tool: 'audio.set_gain', does: 'keyframes that lower the music under the voice' },
      { tool: 'create.motion', does: 'an animated end card with your logo' },
      EXPORT,
    ],
  },
];

/** A fix by its id. */
export const fix = (id: string): Fix | undefined => FIXES.find((f) => f.id === id);

export const fixPath = (f: Fix) => `/fixes/${f.id}`;

/**
 * The answer's opening, for a list: its first sentence, or the first two when the first is a short
 * instruction ("Give it the song.") that says nothing alone.
 */
export function fixLead(f: Fix): string {
  const sentences = f.answer.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [f.answer];
  const first = sentences[0]?.trim() ?? f.answer;
  if (first.split(/\s+/).length >= 8 || sentences.length < 2) return first;
  return `${first} ${sentences[1]?.trim()}`;
}
