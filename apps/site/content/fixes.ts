// The editing problems people search for most, in their words (US Google volumes from kwrds,
// 2026-11-06), each with what a connected agent does about it and a prompt to paste. Every claim
// holds for the server as it is: a logo is blurred or covered, never erased, and lip-sync runs on
// the user's own sync. labs key. Each fix has its own page, /fixes/<id>, titled with the question
// (answer engines cite the page whose title is the exact question); /fixes is the index.

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
};

export const FIXES_UPDATED = '2026-11-18';

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
      'The agent finds the logo, follows it if it moves, and blurs it or covers it with a box or a crop. It does not repaint what was behind it, so a logo in the middle of the picture still shows a blur. It is for marks on footage you have the rights to edit; the cuttingfloor mark on an export comes off with a clean copy.',
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
      'Give it the song. The agent lays it under the video, lowers it while someone is talking, fades it in and out, and can cut the video to its beats.',
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
