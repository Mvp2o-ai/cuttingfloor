// The editing problems people search for most, in their words (US Google volumes from kwrds,
// 2026-11-06), each with what a connected agent does about it and a prompt to paste. Every claim
// holds for the server as it is: a logo is blurred or covered, never erased, and lip-sync runs on
// the user's own sync. labs key. /fixes renders this list.

export type Fix = {
  /** The anchor on /fixes. */
  id: string;
  /** The problem as searched. */
  problem: string;
  answer: string;
  /** What to say to your agent, word for word. */
  prompt: string;
  /** A demo or guide that shows it. */
  see?: { label: string; href: string };
};

export const FIXES_UPDATED = '2026-11-06';

export const FIXES: Fix[] = [
  {
    id: 'compress-a-video',
    problem: 'How do I compress a video?',
    answer:
      'Ask for a smaller file and say what it is for. The agent exports again at a lower bitrate or size, tells you the new file size, and you can ask for smaller still.',
    prompt: 'Make this video small enough to email, under 25 MB, and keep it sharp.',
  },
  {
    id: 'trim-a-video',
    problem: 'How do I trim a video?',
    answer:
      'Say where it should start and end, in seconds or in words: “cut everything before she says hello”. The agent reads the transcript, so it can trim on what is said.',
    prompt:
      'Trim this so it starts when I say “okay, let’s go” and ends after “see you next time”.',
  },
  {
    id: 'remove-a-watermark-or-logo',
    problem: 'How do I remove a watermark or logo from a video?',
    answer:
      'The agent finds the logo, follows it if it moves, and blurs it or covers it with a box or a crop. It does not repaint what was behind it, so a logo in the middle of the picture still shows a blur.',
    prompt: 'Blur the logo in the bottom right corner for the whole video.',
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
  },
  {
    id: 'speed-up-or-slow-down',
    problem: 'How do I speed up a video, or make slow motion?',
    answer:
      'Name the part and the speed. The agent changes the speed of that stretch, can ramp into it smoothly, and keeps the sound in step or mutes it.',
    prompt: 'Play the part from 0:12 to 0:20 at half speed, with a smooth ramp in and out.',
  },
  {
    id: 'stabilize-shaky-video',
    problem: 'How do I stabilize shaky video?',
    answer:
      'The agent makes a steadied copy of the clip and swaps it into the edit, cropping in slightly to hide the moving edges.',
    prompt: 'This walking shot is shaky. Stabilize it.',
  },
  {
    id: 'add-music',
    problem: 'How do I add music to a video?',
    answer:
      'Give it the song. The agent lays it under the video, lowers it while someone is talking, fades it in and out, and can cut the video to its beats.',
    prompt: 'Add this song under the video, quieter when I talk, and fade it out at the end.',
    see: { label: 'Edit a dance Short to the beat', href: '/demos/edit-a-dance-short-to-the-beat' },
  },
  {
    id: 'remove-the-background',
    problem: 'How do I remove the background from a video?',
    answer:
      'The agent cuts the person out of the background, or keys out a green screen, and puts them over a new background, a colour or another video.',
    prompt: 'Remove the background behind me and put me over this picture of a beach.',
  },
  {
    id: 'remove-background-noise',
    problem: 'How do I remove background noise from a video?',
    answer:
      'The agent runs noise reduction and voice cleanup on the voice, and can split the voice from music or room sound, then measures the loudness so it ends at a level that sounds right.',
    prompt: 'There is a fan humming in the background. Clean up my voice so it is clear.',
  },
  {
    id: 'add-subtitles',
    problem: 'How do I add subtitles or captions to a video?',
    answer:
      'The agent transcribes the speech with a time for every word and adds captions that follow it, each word highlighted as it is said, in the style you describe. It can also give you an SRT or VTT file.',
    prompt: 'Add big word-by-word captions, white with a yellow highlight, in the lower third.',
    see: { label: 'How to add captions to a video', href: '/guides/add-captions-to-a-video' },
  },
  {
    id: 'lip-sync',
    problem: 'How do I lip-sync a video?',
    answer:
      'The agent redraws the mouth of the person in your clip to new words, through sync. labs on your own key. Use it on your own footage, or on people who agreed.',
    prompt: 'Make my mouth match this new voiceover in the first ten seconds.',
  },
  {
    id: 'blur-a-face',
    problem: 'How do I blur a face in a video?',
    answer:
      'The agent finds the faces, follows the one you mean through the shot, and blurs only that one, for as long as it is on screen.',
    prompt: 'Blur the face of the man in the background for the whole clip.',
  },
  {
    id: 'add-text',
    problem: 'How do I add text to a video?',
    answer:
      'Say the words, where and when. The agent adds a title in the style you describe, animates it on and off, and can pin it to something that moves.',
    prompt: 'Put “3 tips for your first Short” at the top for the first three seconds.',
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
  },
  {
    id: 'fix-audio-out-of-sync',
    problem: 'How do I fix audio that is out of sync with the video?',
    answer:
      'The agent measures how far the sound is off by comparing it with the camera’s own sound, then slides it into place to the frame.',
    prompt: 'My microphone recording is out of sync with the camera. Line them up.',
  },
  {
    id: 'make-a-video-louder',
    problem: 'How do I make a video louder?',
    answer:
      'The agent raises the level, evens out loud and quiet parts, and measures the result so it lands at the loudness YouTube and TikTok expect without clipping.',
    prompt: 'The sound is too quiet. Make it as loud as a normal YouTube video.',
  },
  {
    id: 'colour-correct',
    problem: 'How do I colour correct a video, or fix a dark one?',
    answer:
      'Describe the look. The agent grades the clip, brightens what is too dark, matches shots to each other, and checks frames so you can see it before it exports.',
    prompt: 'This is too dark and a bit blue. Brighten it and make it warmer.',
  },
  {
    id: 'make-a-video-vertical',
    problem: 'How do I make a video vertical, or turn a long video into Shorts?',
    answer:
      'The agent reframes to 9:16 and follows the speaker’s face so they stay in frame. For Shorts, it reads the transcript, picks the moments worth clipping and cuts each on whole sentences.',
    prompt:
      'Turn this 20-minute podcast into three vertical Shorts of its best moments, with captions.',
    see: {
      label: 'Edit a two-person interview into a Short',
      href: '/demos/edit-a-two-person-interview',
    },
  },
  {
    id: 'add-a-voiceover',
    problem: 'How do I add an AI voiceover to a video?',
    answer:
      'Give it the script. The agent makes the voice with a time for every word, lays it in, and can caption it and time the cuts to it.',
    prompt: 'Add a calm voiceover reading this script, and caption it.',
  },
];
