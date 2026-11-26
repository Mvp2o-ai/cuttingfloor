// Agent demos: a creator's own assistant (Claude, ChatGPT, Kazi) with cuttingfloor plugged in as
// an MCP tool, editing a real clip. Every video here is a real cuttingfloor render of that clip.

export type DemoCall = { fn: string; note: string };

export type DemoVideo = {
  src: string;
  poster?: string;
  label: string;
  seconds: number;
  /** WebVTT of what is said, in this video's own times. */
  captions?: string;
  /** 16:9 rather than the default 9:16. */
  wide?: boolean;
};

export type DemoTurn = {
  prompt: string;
  /** The agent's answer before it works: one or two plain sentences. */
  reply: string;
  calls: DemoCall[];
  /** The grey line while the calls run. */
  status: string;
  /** Its last word: the result, and the next thing it offers. */
  done: string;
  /** The video the preview shows once this turn is done. */
  video: DemoVideo;
};

export type DemoWord = {
  text: string;
  /** The turn (0-based) that cuts it. */
  cut?: number;
};

export type Demo = {
  id: string;
  /** Its watch page is /demos/<slug>: the job, in the words people search it with. */
  slug: string;
  /** The page's heading and the video's name in search. */
  title: string;
  /** One or two sentences: the meta description and the video's description. */
  description: string;
  /** What the agent did, one plain line each. */
  steps: string[];
  /** When the finished video was made (YYYY-MM-DD). */
  uploaded: string;
  /** The skill the agent followed, if one fits: /skills/<skill>. */
  skill?: string;
  /** The guide that answers the same question: /guides/<guide>. */
  guide?: string;
  /** The fix that answers the same question: /fixes/<fix>. */
  fix?: string;
  /** Chapters of the finished video, in its seconds, for key moments in search. */
  moments?: { name: string; start: number; end: number }[];
  agent: 'Claude' | 'ChatGPT' | 'Kazi';
  /** The clip as it came in. */
  raw: DemoVideo;
  /** Other versions the agent made, shown on the watch page. */
  extra?: (DemoVideo & { caption: string })[];
  transcript: DemoWord[];
  turns: DemoTurn[];
};

// A dancer’s four takes of a Motion Party-style routine (generated footage, edited for real by cuttingfloor).
const DANCE: Demo = {
  id: 'dance',
  slug: 'edit-a-dance-short-to-the-beat',
  title: 'Cut a dance video to the beat, with no copyrighted music',
  description:
    'A dancer gives Kazi four takes of a Motion Party-style routine. Kazi makes an original beat, cuttingfloor cuts a new shot on every bar, slows into the big move and puts each move’s name on screen: a 23-second Short.',
  steps: [
    'Looked at all four takes to find each move.',
    'Made an original hip-hop beat from scratch, so there’s no copyright claim.',
    'Found the beats and cut to a new shot at the start of every bar.',
    'Zoomed in on three downbeats so the cuts hit harder.',
    'Sped through the drop, then went slow-mo into the step-out so it lands on the beat.',
    'Froze her final pose on the last hit.',
    'Turned the room sound down under the beat and kept her “Did I get it?” at the end.',
    'Put each move’s name on screen as she does it.',
    'Added a flash and a “MOTION PARTY” stamp on the final pose, and exported it vertical.',
  ],
  uploaded: '2026-10-18',
  moments: [
    { name: 'The bounce', start: 0, end: 4.6 },
    { name: 'Arm roll', start: 4.6, end: 6.9 },
    { name: 'Shimmy', start: 6.9, end: 9.2 },
    { name: 'Spin + drop', start: 9.2, end: 13.8 },
    { name: 'Step out', start: 13.8, end: 16.1 },
    { name: 'Hit the pose', start: 16.1, end: 19.4 },
    { name: 'Did I get it?', start: 19.4, end: 23.4 },
  ],
  agent: 'Kazi',
  raw: {
    src: '/demo/dance/raw.mp4',
    poster: '/demo/dance/raw.jpg',
    label: 'dance-takes.mp4 · 0:34',
    seconds: 34,
  },
  transcript: [
    { text: 'Take 1: waiting to start', cut: 0 },
    { text: 'Take 1: the bounce' },
    { text: 'Take 1: winding down', cut: 0 },
    { text: 'Take 2: getting ready', cut: 0 },
    { text: 'Take 2: arm rolls' },
    { text: 'Take 2: shimmy' },
    { text: 'Take 2: settling back', cut: 0 },
    { text: 'Take 3: counting in', cut: 0 },
    { text: 'Take 3: the spin' },
    { text: 'Take 3: the drop and the step-out' },
    { text: 'Take 3: holding the stance', cut: 0 },
    { text: 'Take 4: dancing in to the camera' },
    { text: 'Take 4: hit the pose' },
    { text: 'Take 4: [laughs] “Did I get it?”' },
    { text: 'Room sound under every move', cut: 0 },
  ],
  turns: [
    {
      prompt:
        "Make these four takes into one dance video, cut to a beat. Don't use a real song, I'll get copyright struck.",
      reply:
        'I’ll make you an original beat so there’s nothing to get struck, then cut your four takes to land on it, with zoom-ins, a slow-mo into the big move and a hold on your final pose.',
      calls: [
        { fn: 'media.import', note: 'four takes' },
        { fn: 'render.frames', note: 'looked at every take' },
        { fn: 'media.import', note: 'the beat Kazi made' },
        { fn: 'media.analyze', note: 'found the beats' },
        { fn: 'edit.batch', note: 'a cut on every bar, 7 shots' },
        { fn: 'clip.set_speed', note: 'slow-mo into the step-out' },
        { fn: 'edit.batch', note: 'zoom-ins, pose freeze' },
        { fn: 'audio.set_master', note: 'louder, peaks under −1 dB' },
        { fn: 'render.frames', note: 'checked every cut' },
        { fn: 'export.video', note: 'vertical, 0:23' },
      ],
      status: 'Cutting your takes to the beat…',
      done: 'Your 23-second cut is ready: an original 104 BPM beat, a cut on every bar, a slow-mo into the step-out and a freeze on your final pose. Want the move names on screen?',
      video: {
        src: '/demo/dance/cut.mp4',
        poster: '/demo/dance/cut.jpg',
        label: 'dance-cut.mp4 · 0:23',
        seconds: 23.4,
        captions: '/demo/dance/cut.vtt',
      },
    },
    {
      prompt: 'Put the move names on screen and make the ending pop.',
      reply:
        'I’ll put each move’s name up as you hit it, big enough for Shorts, and turn your final pose into a flash.',
      calls: [
        { fn: 'create.motion', note: 'animated end flash' },
        { fn: 'edit.batch', note: '6 move names and the flash' },
        { fn: 'text.set', note: 'bigger sign-off' },
        { fn: 'render.frames', note: 'checked the titles' },
        { fn: 'export.video', note: 'vertical, 0:23' },
      ],
      status: 'Adding the move names…',
      done: 'Done: every move’s name pops up as you do it, and the pose hits with a flash and a “MOTION PARTY” stamp. Want a loop-friendly ending too?',
      video: {
        src: '/demo/dance/short.mp4',
        poster: '/demo/dance/short.jpg',
        label: 'motion-party-short.mp4 · 0:23',
        seconds: 23.4,
        captions: '/demo/dance/short.vtt',
      },
    },
  ],
};

// A podcast interview filmed from six angles (generated footage, edited for real by cuttingfloor).
const INTERVIEW: Demo = {
  id: 'interview',
  slug: 'edit-a-two-person-interview',
  title: 'Edit a two-person interview into a Short',
  description:
    'A podcast host asks Claude to cut six camera angles of an interview together. cuttingfloor cuts to whoever is talking, removes the dead air and the ums, adds name cards and captions, and makes vertical and widescreen versions.',
  steps: [
    'Read all six camera angles and wrote down every word.',
    'Measured where each person actually speaks, so the cuts land on speech.',
    'Found the guest’s “um”, which the transcript left out.',
    'Cut to whoever is talking and trimmed the dead air around every line.',
    'Let each line’s sound start just before its shot, so the cuts flow.',
    'Hid the um cut under a shot of Marcus listening, so nothing jumps.',
    'Made the sound louder and even.',
    'Added a name card for each person and captions in their own colour.',
    'Made a vertical version that follows each speaker’s face, and a widescreen one for YouTube.',
  ],
  uploaded: '2026-10-18',

  moments: [
    { name: '100K in a year?', start: 0, end: 5.3 },
    { name: 'Post every single day', start: 5.3, end: 16.9 },
    { name: 'Your one tip', start: 16.9, end: 20.2 },
    { name: 'Just post the thing', start: 20.2, end: 23.4 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/interview/raw.mp4',
    poster: '/demo/interview/raw.jpg',
    label: 'interview-all-angles.mp4 · 0:48',
    seconds: 48,
    captions: '/demo/interview/raw.vtt',
    wide: true,
  },
  extra: [
    {
      src: '/demo/interview/wide.mp4',
      poster: '/demo/interview/wide.jpg',
      label: 'interview-widescreen.mp4 · 0:23',
      seconds: 23.4,
      captions: '/demo/interview/wide.vtt',
      wide: true,
      caption: 'Widescreen, for YouTube',
    },
  ],
  transcript: [
    { text: '[2 s before Marcus starts]', cut: 0 },
    { text: 'Okay, so you went from zero to a hundred thousand followers in one year.' },
    { text: '[pause]', cut: 0 },
    { text: 'How?' },
    { text: '[silence while the camera changes]', cut: 0 },
    { text: 'Honestly? I posted every single day,' },
    { text: 'even when,' },
    { text: 'um,', cut: 0 },
    { text: 'nobody was watching.' },
    { text: '(Marcus laughs) Every single day?' },
    { text: 'Hmm.', cut: 0 },
    { text: 'Every day. The first fifty. But that’s how you get good.' },
    { text: '[3 s of silence]', cut: 0 },
    { text: 'So what’s your one tip for someone starting today?' },
    { text: 'Um…', cut: 0 },
    { text: '[3 s of silence]', cut: 0 },
    { text: 'Start before you’re ready. Just post the thing.' },
  ],
  turns: [
    {
      prompt: 'Cut this interview together. Show whoever’s talking and tighten the gaps.',
      reply:
        'I’ll read every angle, find exactly where each person talks, then cut to whoever’s speaking and close up the gaps so it plays like one conversation.',
      calls: [
        { fn: 'skills.get', note: 'read the cleanup steps' },
        { fn: 'media.import', note: 'six angles' },
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'media.analyze', note: 'where each person talks' },
        { fn: 'render.frames', note: 'looked at each angle' },
        { fn: 'edit.batch', note: '7 shots, cut to the speaker' },
        { fn: 'edit.batch', note: 'sound leads into each shot' },
        { fn: 'audio.set_master', note: 'louder, even' },
        { fn: 'render.frames', note: 'checked every cut' },
        { fn: 'export.video', note: 'widescreen, 0:23' },
      ],
      status: 'Cutting to whoever’s talking…',
      done: 'Done: 48 seconds of takes down to 23. The camera follows whoever’s speaking, and the um is gone. Want names and captions?',
      video: {
        src: '/demo/interview/cut.mp4',
        poster: '/demo/interview/cut.jpg',
        label: 'interview-cut.mp4 · 0:23',
        seconds: 23.4,
        captions: '/demo/interview/cut.vtt',
        wide: true,
      },
    },
    {
      prompt: 'Add their names and captions, and make me a vertical one for Shorts.',
      reply:
        'I’ll put a name card on each person the first time we see them, caption every line in that person’s colour, then make a vertical version that keeps whoever’s talking in frame.',
      calls: [
        { fn: 'create.still', note: 'drew the name cards' },
        { fn: 'media.analyze', note: 'found the faces' },
        { fn: 'caption.add', note: 'every line, per speaker' },
        { fn: 'text.set', note: 'gold for him, pink for her' },
        { fn: 'edit.batch', note: 'placed the name cards' },
        { fn: 'clip.set_transform', note: 'vertical, framed on faces' },
        { fn: 'render.frames', note: 'checked the vertical' },
        { fn: 'export.video', note: 'vertical and widescreen' },
      ],
      status: 'Adding names and captions…',
      done: 'Done: name cards for Marcus and Dana, captions in gold for him and pink for her, and a vertical Short framed on whoever’s talking. The widescreen one is ready too. Want a hook title at the start?',
      video: {
        src: '/demo/interview/short.mp4',
        poster: '/demo/interview/short.jpg',
        label: 'interview-short.mp4 · 0:23',
        seconds: 23.4,
        captions: '/demo/interview/short.vtt',
      },
    },
  ],
};

// A beauty creator’s lip gloss review, three takes (generated footage, edited for real by cuttingfloor).
const PRODUCT: Demo = {
  id: 'product',
  slug: 'edit-a-product-review-short',
  title: 'Turn a beauty product review into a 15-second Short',
  description:
    'A beauty creator asks ChatGPT to make a lip gloss review into a Short. cuttingfloor opens on the best line, speeds through the application, pops up callouts as she says them and cuts her out onto a pink end card with the price.',
  steps: [
    'Opened on her best line, “look at that shine”, as the hook.',
    'Took out the pauses and the silent moments before and after she talks.',
    'Sped up the gloss going on, slow at the start and end.',
    'Added a soft beat made from scratch that dips under her voice.',
    'Made the whole video an even, phone-friendly volume.',
    'Added step labels: the gloss, swipe it on, the verdict.',
    'Popped up “high shine” and “not sticky” right as she says them.',
    'Cut her out holding the gloss and slid her onto a pink background with a $14 sticker for the ending.',
  ],
  uploaded: '2026-10-18',
  moments: [
    { name: 'Hook: look at that shine', start: 0, end: 1.67 },
    { name: 'The gloss', start: 1.67, end: 6 },
    { name: 'Swipe it on', start: 6, end: 9.83 },
    { name: 'The verdict', start: 9.83, end: 12.5 },
    { name: '$14', start: 12.5, end: 15.5 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/product/raw.mp4',
    poster: '/demo/product/raw.jpg',
    label: 'gloss-review-takes.mp4 · 0:24',
    seconds: 24.04,
  },
  transcript: [
    { text: '[reaches for the gloss]', cut: 0 },
    { text: 'Okay, this is the gloss everyone keeps asking me about.' },
    { text: '[pause]', cut: 0 },
    { text: 'Let’s try it.' },
    { text: '[opens the tube]', cut: 0 },
    { text: '[puts the gloss on, 8 s, sped up]' },
    { text: '[waits]', cut: 0 },
    { text: 'Okay, it’s not sticky at all.' },
    { text: '[pause]', cut: 0 },
    { text: 'And', cut: 0 },
    { text: 'look at that shine.' },
  ],
  turns: [
    {
      prompt: 'Make this a 15 second review. Hook them in the first second.',
      reply:
        'I’ll open on “look at that shine” with a slow zoom, then tell the story in order: the intro, the gloss going on sped up, and your verdict.',
      calls: [
        { fn: 'skills.get', note: 'read the cleanup steps' },
        { fn: 'media.import', note: 'three takes' },
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'media.analyze', note: 'found where she speaks' },
        { fn: 'edit.batch', note: 'hook first, six pieces' },
        { fn: 'clip.set_speed', note: 'sped up the application' },
        { fn: 'media.import', note: 'a soft beat Kazi made' },
        { fn: 'audio.set_master', note: 'even volume' },
        { fn: 'render.frames', note: 'checked every cut' },
        { fn: 'export.video', note: 'vertical, 0:13' },
      ],
      status: 'Cutting the review together…',
      done: 'Your 13-second review opens on “look at that shine” and keeps every line in order, with a soft beat under it. Want the price and a few callouts?',
      video: {
        src: '/demo/product/cut.mp4',
        poster: '/demo/product/cut.jpg',
        label: 'gloss-review-cut.mp4 · 0:13',
        seconds: 13.5,
        captions: '/demo/product/cut.vtt',
      },
    },
    {
      prompt: 'Add the price, $14, and a few callouts. And make the gloss pop off the screen.',
      reply:
        'I’ll cut you out holding the gloss and drop you onto pink for the ending with a $14 sticker, and pop up “high shine” and “not sticky” right as you say them.',
      calls: [
        { fn: 'judge.ask', note: 'found the gloss in frame' },
        { fn: 'create.cutout', note: 'cut her out with the gloss' },
        { fn: 'create.matte', note: 'pink background' },
        { fn: 'create.motion', note: 'high shine, not sticky, $14' },
        { fn: 'edit.batch', note: 'step labels and end card' },
        { fn: 'clip.set_animation', note: 'slides up onto pink' },
        { fn: 'render.frames', note: 'checked the layout' },
        { fn: 'export.video', note: 'vertical, 0:15' },
      ],
      status: 'Adding the price and callouts…',
      done: 'Your 15-second Short has step labels, pop-ups on the lines where you say them, and an ending where you pop out onto pink with a $14 sticker. Want captions burned in too?',
      video: {
        src: '/demo/product/short.mp4',
        poster: '/demo/product/short.jpg',
        label: 'gloss-review-short.mp4 · 0:15',
        seconds: 15.5,
        captions: '/demo/product/short.vtt',
      },
    },
  ],
};

// A real estate agent’s listing clip (generated footage, edited for real by cuttingfloor).
const LISTING: Demo = {
  id: 'listing',
  slug: 'edit-a-real-estate-listing-video',
  title: 'Edit a real estate listing video with ChatGPT',
  description:
    'A realtor asks ChatGPT to cut a wrong address and the dead air from a listing clip, then add captions and a price card. cuttingfloor turns 20 seconds into a 14-second post.',
  steps: [
    'Read every word of the clip, with its timing.',
    'Found the wrong address and the long pause by measuring where she’s actually talking.',
    'Cut the wrong address and the long pause, and shortened the pause before “Just redone”.',
    'Smoothed each cut and zoomed in a little on every other part, so nothing jumps.',
    'Made the sound louder without clipping.',
    'Added word-by-word captions and a listing card with the address, price, beds and baths.',
    'Popped in an open-house sticker when she says it, and exported it vertical.',
  ],
  uploaded: '2026-10-18',
  skill: 'cut-pauses-ums-and-restarts',
  moments: [
    { name: 'Hey everyone', start: 0, end: 2.8 },
    { name: '214 Maple Drive', start: 2.8, end: 4.6 },
    { name: '3 bed, 2 bath, new kitchen', start: 4.6, end: 8.75 },
    { name: 'Open house Saturday', start: 8.75, end: 13.05 },
    { name: 'Come say hi', start: 13.05, end: 14.35 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/listing/raw.mp4',
    poster: '/demo/listing/raw.jpg',
    label: 'listing-214-maple.mp4 · 0:20',
    seconds: 20.02,
    captions: '/demo/listing/raw.vtt',
  },
  transcript: [
    { text: 'Hey everyone! So I’m here at' },
    { text: '412 Maple… no, sorry,', cut: 0 },
    { text: '214 Maple Drive.' },
    { text: '[2 s smiling at the camera]', cut: 0 },
    {
      text: 'Three bedrooms, two baths, and this kitchen? Just redone. Open house is Saturday, ten to two. Come say hi!',
    },
  ],
  turns: [
    {
      prompt: 'Cut the part where I got the address wrong, and the dead air.',
      reply:
        'On it. I’ll keep the right address, cut the long pause, and smooth the cuts so nothing jumps.',
      calls: [
        { fn: 'skills.search', note: 'how to cut flubs' },
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'judge.ask', note: 'found the flub' },
        { fn: 'render.frames', note: 'checked the cut points' },
        { fn: 'edit.batch', note: 'kept 4 parts' },
        { fn: 'edit.batch', note: 'smoothed 3 cuts' },
        { fn: 'audio.set_master', note: 'louder, no clipping' },
        { fn: 'export.video', note: 'vertical, 0:14' },
      ],
      status: 'Cutting…',
      done: 'Done: 20 seconds down to 14, and the address is right all the way through. Want captions and the price on screen?',
      video: {
        src: '/demo/listing/clean.mp4',
        poster: '/demo/listing/clean.jpg',
        label: 'listing-clean.mp4 · 0:14',
        seconds: 14.35,
        captions: '/demo/listing/clean.vtt',
      },
    },
    {
      prompt: 'Yes. $485,000, 3 bed, 2 bath.',
      reply:
        'Adding word-by-word captions and a listing card that slides in when you say the address.',
      calls: [
        { fn: 'create.motion', note: 'animated listing card' },
        { fn: 'create.still', note: 'open-house sticker' },
        { fn: 'caption.add', note: '11 captions, word by word' },
        { fn: 'edit.batch', note: 'placed the card and sticker' },
        { fn: 'render.frames', note: 'checked the layout' },
        { fn: 'export.video', note: 'vertical, 0:14' },
      ],
      status: 'Adding the listing card…',
      done: 'Ready to post: captions, the price card, and an open-house sticker when you mention it. Want a square one for Instagram too?',
      video: {
        src: '/demo/listing/short.mp4',
        poster: '/demo/listing/short.jpg',
        label: 'listing-214-maple-post.mp4 · 0:14',
        seconds: 14.35,
        captions: '/demo/listing/short.vtt',
      },
    },
  ],
};

// A creator's raw tips video, four takes (generated footage, edited for real by cuttingfloor).
const TIPS: Demo = {
  id: 'tips',
  slug: 'remove-pauses-and-restarts-from-a-talking-video',
  title: 'Remove the pauses and restarts from a talking video',
  description:
    'A creator asks Claude to cut the long pauses, the restart and the repeated line out of a 40-second tips video. cuttingfloor keeps every point, adds big word-by-word captions and a hook title: a 21-second Short.',
  steps: [
    'Followed the steps for cleaning up a talking video.',
    'Lined up every word with where she’s really talking in each take.',
    'Had Jev, its own vision model, mark the restart and the repeated line, then checked each one.',
    'Kept the clean second try of “Number one” and dropped the first.',
    'Dropped the second “Just post the thing.”',
    'Cut the long pause, the coffee sip and the silences between takes.',
    'Softened every cut and zoomed in a little on every other part, so nothing jumps.',
    'Made the sound louder without clipping.',
    'Added big word-by-word captions with the spoken word in yellow.',
    'Put a hook title across the top for the first 5 seconds, and exported it vertical.',
  ],
  uploaded: '2026-10-18',
  skill: 'cut-pauses-ums-and-restarts',
  moments: [
    { name: 'Hook', start: 0, end: 5.6 },
    { name: 'Tip 1: the first three seconds', start: 5.6, end: 10.4 },
    { name: 'Tip 2: your first 50 are practice', start: 10.4, end: 15.2 },
    { name: 'Tip 3: just post it', start: 15.2, end: 19.6 },
    { name: 'Follow for part two', start: 19.6, end: 21.5 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/tips/raw.mp4',
    poster: '/demo/tips/raw.jpg',
    label: 'posting-tips.mp4 · 0:40',
    seconds: 40,
  },
  transcript: [
    { text: 'Okay, so three things I wish I knew before I started posting.' },
    { text: '[long pause, looks away]', cut: 0 },
    { text: 'Number one, nobody, nobody, wait, let me start that again.', cut: 0 },
    { text: 'Number one: nobody watches past three seconds unless you give them a reason.' },
    { text: '[silence]', cut: 0 },
    { text: 'Number two: your first 50 videos are practice' },
    { text: '[long pause]', cut: 0 },
    { text: 'and that’s fine.' },
    { text: '[coffee sip]', cut: 0 },
    { text: 'Number three: just post it. Seriously, just post the thing.' },
    { text: 'Just post the thing.', cut: 0 },
    { text: 'Okay, follow for part two.' },
    { text: '[silence]', cut: 0 },
  ],
  turns: [
    {
      prompt: 'Cut out the long pauses, the ums and the bits where I start over.',
      reply:
        'On it. I’ll find where you’re really talking, mark the restarts and repeats, and keep your last clean try of each line.',
      calls: [
        { fn: 'skills.search', note: 'the cleanup steps' },
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'media.analyze', note: 'the quiet gaps, per take' },
        { fn: 'judge.ask', note: 'Jev marked restarts and repeats' },
        { fn: 'edit.batch', note: 'kept 6 parts, in order' },
        { fn: 'edit.batch', note: 'smoothed the cuts' },
        { fn: 'audio.set_master', note: 'louder, no clipping' },
        { fn: 'render.frames', note: 'checked both sides of each cut' },
        { fn: 'export.video', note: 'vertical, 0:21' },
      ],
      status: 'Cutting the pauses and restarts…',
      done: 'Done: 40 seconds down to 21. I cut the restart, the repeated line, the long pause and the coffee sip, and kept every point in order. Want big captions?',
      video: {
        src: '/demo/tips/clean.mp4',
        poster: '/demo/tips/clean.jpg',
        label: 'posting-tips-clean.mp4 · 0:21',
        seconds: 21.5,
        captions: '/demo/tips/clean.vtt',
      },
    },
    {
      prompt: 'Yes, big captions.',
      reply:
        'Big bold captions coming, a word at a time, with a title up top for the first few seconds.',
      calls: [
        { fn: 'media.analyze', note: 'exact word timings' },
        { fn: 'caption.add', note: 'word-by-word captions' },
        { fn: 'title.add', note: 'hook title' },
        { fn: 'render.frames', note: 'checked the caption size' },
        { fn: 'edit.batch', note: 'bigger text' },
        { fn: 'qa.check', note: 'length and volume' },
        { fn: 'export.video', note: 'vertical, 0:21' },
      ],
      status: 'Adding captions…',
      done: 'Here it is, ready to post: big yellow captions all the way through and “3 things I wish I knew before posting” across the top. Want a thumbnail too?',
      video: {
        src: '/demo/tips/short.mp4',
        poster: '/demo/tips/short.jpg',
        label: 'posting-tips-short.mp4 · 0:21',
        seconds: 21.5,
        captions: '/demo/tips/short.vtt',
      },
    },
  ],
};

// A tech creator's four takes of one channel intro (generated footage, judged by Jev and edited
// for real by cuttingfloor).
const JEV: Demo = {
  id: 'jev',
  slug: 'pick-your-best-take-with-ai',
  title: 'Let AI pick your best take, then make the thumbnail',
  description:
    'A tech creator gives ChatGPT four takes of his channel intro. cuttingfloor has Jev, its own vision model, watch every quarter second of each take, keeps the best one, then picks the frame where he looks best for a thumbnail.',
  steps: [
    'Wrote down every word of each take, with when it was said.',
    'Had Jev, cuttingfloor’s own vision model, look at each take every quarter second: looking at the lens, eyes closed, wincing, energy.',
    'Checked which takes drag a word out, squint or crack up.',
    'Picked take 1: on the lens in all 32 frames, no blinks, the most energy.',
    'Trimmed it to where he speaks and put his closing line right after it.',
    'Matched the closing line’s volume, then made it all louder and even.',
    'Had Jev score 41 frames for open eyes, a smile, sharp focus and a closed mouth, and took the best.',
    'Built a thumbnail from that frame and checked the title doesn’t cover his face.',
    'Added the title for the first seconds and captions that light up each word, and exported it vertical.',
  ],
  uploaded: '2026-10-19',
  moments: [
    { name: 'The intro', start: 0, end: 5.2 },
    { name: 'It looks at the frames', start: 5.2, end: 8.9 },
    { name: 'Smile', start: 8.9, end: 10.1 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/jev/raw.mp4',
    poster: '/demo/jev/raw.jpg',
    label: 'intro-takes.mp4 · 0:40',
    seconds: 40,
    captions: '/demo/jev/raw.vtt',
  },
  transcript: [
    { text: 'Take 1: “Hey, I’m Jake, and today I’m testing whether an AI can pick my best take.”' },
    { text: 'Take 2: the same line, dragging out “an… AI…”, then a wince.', cut: 0 },
    { text: 'Take 3: the same line, starting off at the monitor, flat.', cut: 0 },
    { text: 'Take 4: the same line, a hard squint halfway, then he cracks up.', cut: 0 },
    { text: '“It actually looks at the frames, not just the words.” (smiles)' },
  ],
  turns: [
    {
      prompt: 'Which of these intros is my best take? Use it and cut the rest.',
      reply:
        'I’ll read what you said in each take and have Jev look at your face every quarter second, then keep the winner and put your closing line after it.',
      calls: [
        { fn: 'media.import', note: 'five clips' },
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'media.analyze', note: 'Jev looked at 160 frames' },
        { fn: 'judge.ask', note: 'stumbles, squint, laugh' },
        { fn: 'render.frames', note: 'looked at each take' },
        { fn: 'edit.batch', note: 'take 1, then the closer' },
        { fn: 'audio.set_master', note: 'louder, even' },
        { fn: 'render.frames', note: 'checked the cut' },
        { fn: 'export.video', note: 'vertical, 0:10' },
      ],
      status: 'Watching your four takes…',
      done: 'Take 1 wins: you’re on the lens in 32 of 32 frames, eyes never closed, and it has the most energy. Take 2 drags out “AI” and winces, take 3 starts on your monitor and is the flattest, take 4 squints mid-line and ends laughing. Want a thumbnail and a title?',
      video: {
        src: '/demo/jev/best.mp4',
        poster: '/demo/jev/best.jpg',
        label: 'intro-best-take.mp4 · 0:10',
        seconds: 10.1,
        captions: '/demo/jev/best.vtt',
      },
    },
    {
      prompt: 'Now pick a thumbnail frame where I look good, and put a title on the video.',
      reply:
        'I’ll have Jev check every quarter second for open eyes, looking at the lens, a smile and sharp focus, build the thumbnail from the best frame, and add a matching title and captions.',
      calls: [
        { fn: 'media.analyze', note: 'Jev scored 41 frames' },
        { fn: 'render.frames', note: 'grabbed the best one' },
        { fn: 'create.still', note: 'built the thumbnail' },
        { fn: 'judge.ask', note: 'is his face clear?' },
        { fn: 'caption.add', note: 'word-by-word captions' },
        { fn: 'create.still', note: 'a matching title' },
        { fn: 'render.frames', note: 'checked the text' },
        { fn: 'export.video', note: 'vertical, 0:10' },
      ],
      status: 'Finding your best frame…',
      done: 'Your best frame is 5.1 seconds in: eyes open, smiling, on the lens. The thumbnail puts “CAN AI PICK MY BEST TAKE?” under your chin, and Jev confirmed your face is clear. The video opens with the same title, with captions that light up each word. Want a 6-second cut for a story?',
      video: {
        src: '/demo/jev/short.mp4',
        poster: '/demo/jev/thumbnail.jpg',
        label: 'can-ai-pick-my-best-take.mp4 · 0:10',
        seconds: 10.1,
        captions: '/demo/jev/short.vtt',
      },
    },
  ],
};

// Tip 1 of a 24-minute slide explainer, with a talking-head clip lip-synced to its narration
// (generated presenter, edited for real by cuttingfloor).
const MEMORY: Demo = {
  id: 'memory',
  slug: 'add-a-talking-head-to-your-explainer-video',
  title: 'Add a talking head to a slide explainer, then make it a Short',
  description:
    'A creator asks Claude to put himself into Tip 1 of his 24-minute slide explainer. cuttingfloor finds the tip by its words, cuts him out of his background into the corner the slides leave empty, then makes a vertical Short: slides on top, him underneath, captions on the seam.',
  steps: [
    'Found where Tip 1 starts and ends in the 24-minute explainer from its words.',
    'Started on the first frame of the Tip 1 slide, not the end of the one before.',
    'Matched his clip’s sound to the explainer’s, so his lips land on the narration.',
    'Cut him out of his background: it looked cleaner on the dark slides than a rounded box.',
    'Had Jev check every second for an empty corner: the bottom right stays clear, so he stands there.',
    'Slid him in at the start and faded him out at the end.',
    'Kept the explainer’s sound and made it YouTube-loud.',
    'For Shorts: slides across the top, him framed on his face underneath.',
    'Big word-by-word captions on the seam, with a few misheard words fixed.',
    'A “TIP 1: WRITE NOTES INLINE” title for the first few seconds, exported vertical.',
  ],
  uploaded: '2026-10-19',
  moments: [
    { name: 'The notepad tool', start: 0, end: 10.1 },
    { name: 'The detour costs', start: 10.1, end: 17.2 },
    { name: 'A convention, not a tool', start: 17.2, end: 66 },
    { name: 'The streaming parse', start: 66, end: 78.7 },
    { name: 'Notes are working memory', start: 78.7, end: 100.4 },
    { name: 'Three details', start: 100.4, end: 131.7 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/memory/raw.mp4',
    poster: '/demo/memory/raw.jpg',
    label: 'memory-explainer.mp4 · 2:11',
    seconds: 131.8,
    wide: true,
  },
  transcript: [
    {
      text: 'Most people give their assistant a notepad tool. The model stops mid-turn, emits a tool call, waits, then keeps going.',
    },
    {
      text: 'We don’t give the assistant a tool. We give it a convention: it writes its notes inline, inside the response it’s already generating.',
    },
    { text: 'The notes ride the response stream. No tool call, no round trip.' },
    {
      text: 'A small state machine flips to recording on the open sentinel and done on the close.',
    },
    { text: 'That’s working memory. Persistence happens later, at eviction.' },
    { text: '…three details that matter. Start there.' },
  ],
  turns: [
    {
      prompt: 'Put me in my explainer for tip one: a talking head in the corner.',
      reply:
        'I’ll cut Tip 1 out of the explainer by its words, line your clip up with the narration, cut you out of your background and put you in whichever corner the slides leave empty.',
      calls: [
        { fn: 'skills.search', note: 'looked for a recipe' },
        { fn: 'media.get', note: 'found Tip 1’s words' },
        { fn: 'media.analyze', note: 'found the quiet gaps' },
        { fn: 'audio.set_loudness', note: 'matched his sound to yours' },
        { fn: 'create.cutout', note: 'cut out his background' },
        { fn: 'media.analyze', note: 'Jev: which corner stays empty' },
        { fn: 'edit.batch', note: 'tried a rounded box, then the cut-out' },
        { fn: 'render.frames', note: 'compared the two' },
        { fn: 'edit.batch', note: 'slide in, fade out' },
        { fn: 'audio.set_master', note: 'YouTube-loud' },
        { fn: 'export.video', note: 'widescreen, 2:11' },
        { fn: 'media.analyze', note: 'Jev: checked he covers nothing' },
      ],
      status: 'Putting you in the corner…',
      done: 'You’re in the bottom-right corner for all of Tip 1, cut out of your background and in sync with your voice. That corner stays empty the whole tip, so you never had to move. Want a vertical version for Shorts?',
      video: {
        src: '/demo/memory/talkinghead.mp4',
        poster: '/demo/memory/talkinghead.jpg',
        label: 'tip-1-talking-head.mp4 · 2:11',
        seconds: 131.8,
        captions: '/demo/memory/talkinghead.vtt',
        wide: true,
      },
    },
    {
      prompt: 'Now make a vertical one for Shorts: slides on top, me underneath, with captions.',
      reply:
        'I’ll stack the slides on top and you underneath, framed on your face, with big word-by-word captions on the line between and a Tip 1 title at the start.',
      calls: [
        { fn: 'media.analyze', note: 'found his face' },
        { fn: 'timeline.create', note: 'vertical' },
        { fn: 'edit.batch', note: 'slides on top, him below, title' },
        { fn: 'caption.add', note: 'captions from the transcript' },
        { fn: 'render.frames', note: 'checked the seam' },
        { fn: 'text.set', note: 'captions onto the seam' },
        { fn: 'clip.set_transform', note: 'cropped the slide’s progress bar' },
        { fn: 'qa.check', note: 'length and volume' },
        { fn: 'export.video', note: 'vertical, 2:11' },
      ],
      status: 'Stacking it for Shorts…',
      done: 'Your Short is ready: slides on top, you underneath, big captions on the seam and a Tip 1 title for the first few seconds. At 2:11 it’s long for a Short. Want a 60-second cut next?',
      video: {
        src: '/demo/memory/short.mp4',
        poster: '/demo/memory/short.jpg',
        label: 'tip-1-short.mp4 · 2:11',
        seconds: 131.7,
        captions: '/demo/memory/short.vtt',
      },
    },
  ],
};

// The same Tip 1, rebuilt from a static slide into motion graphics with a new voiceover
// (every frame a real cuttingfloor render; the sound effects Claude made from scratch).
const EXPLAINER: Demo = {
  id: 'explainer',
  slug: 'make-a-motion-graphics-explainer-video',
  title: 'Make a motion graphics explainer video from your script',
  description:
    'A creator asks Claude to turn a 2-minute explainer that is one static slide into real motion graphics. cuttingfloor tightens the script to 40 seconds, reads it in a British voice, boards nine beats on the words and animates each one with camera moves, timed builds and sound effects.',
  steps: [
    'Followed two skills: storyboard first, then motion graphics like a pro.',
    'Cut the 2:11 script to 38 seconds, one idea per beat.',
    'Read it in a British voice, with every word timed.',
    'Gave each of nine beats a job (hook, problem, cost, turn, fix, how, payoff, close) and its exact frames.',
    'Built each beat as its own animated scene: things overshoot as they land, arrive one after another, and the camera always moves.',
    'Showed the idea instead of a slide: the answer stops for a tool call, then notes ride the stream between two tags.',
    'Checked every scene frame by frame and fixed five layout slips before the final render.',
    'Laid the scenes on the voice, with whooshes, pops and ticks on the hits and no music.',
    'Checked for gaps and black frames and made it loud and clear.',
  ],
  uploaded: '2026-11-08',
  skill: 'make-motion-graphics',
  moments: [
    { name: 'How assistants take notes', start: 0, end: 7.8 },
    { name: 'Every note is a round trip', start: 7.8, end: 13.5 },
    { name: 'Give it a convention', start: 13.5, end: 16.4 },
    { name: 'Notes go inline', start: 16.4, end: 21.4 },
    { name: 'A tiny parser', start: 21.4, end: 27 },
    { name: 'Never breaks stride', start: 27, end: 31.6 },
    { name: 'Working memory, for free', start: 31.6, end: 36.9 },
    { name: 'Tag your own notes', start: 36.9, end: 40.5 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/memory/raw.mp4',
    poster: '/demo/memory/raw.jpg',
    label: 'memory-explainer.mp4 · 2:11',
    seconds: 131.8,
    wide: true,
  },
  transcript: [
    {
      text: 'Most people give their assistant a notepad tool. The model stops mid-turn, emits a tool call, waits, then keeps going.',
    },
    {
      text: 'We don’t give the assistant a tool. We give it a convention: it writes its notes inline, inside the response it’s already generating.',
    },
    { text: 'The notes ride the response stream. No tool call, no round trip.' },
    {
      text: 'A small state machine flips to recording on the open sentinel and done on the close.',
    },
    { text: 'That’s working memory.' },
    { text: 'Persistence happens later, at eviction.', cut: 0 },
    { text: '…three details that matter. Start there.', cut: 0 },
  ],
  turns: [
    {
      prompt:
        'This explainer is one slide for two minutes. Turn tip one into real motion graphics: under a minute, British voice.',
      reply:
        'I’ll tighten the script to about 40 seconds, record it in a British voice, then board it beat by beat on the words before animating anything.',
      calls: [
        { fn: 'skills.get', note: 'storyboard before animate' },
        { fn: 'skills.get', note: 'make motion graphics' },
        { fn: 'media.get', note: 'read the old script' },
        { fn: 'create.voiceover', note: 'British voice, 38 s, every word timed' },
        { fn: 'media.import', note: 'Inter and JetBrains Mono' },
        { fn: 'create.motion', note: 'nine beats, one scene each' },
        { fn: 'render.frames', note: 'checked every beat' },
        { fn: 'media.import', note: 'a style frame of each beat' },
        { fn: 'edit.batch', note: 'the board, timed to the voice' },
        { fn: 'export.video', note: 'animatic, 0:40' },
      ],
      status: 'Boarding it on the voice…',
      done: 'Here’s the board: nine beats, each held for its exact frames under the new voice, from the tool call that stalls the answer to “Tag your own notes”. Want it animated with sound?',
      video: {
        src: '/demo/explainer/animatic.mp4',
        poster: '/demo/explainer/animatic.jpg',
        label: 'tip-1-animatic.mp4 · 0:40',
        seconds: 40.5,
        captions: '/demo/explainer/animatic.vtt',
        wide: true,
      },
    },
    {
      prompt: 'Animate it. Sound effects on the hits, no music, and make the voice loud.',
      reply:
        'I’ll lay the nine scenes on the voice at their storyboard frames, put a whoosh, pop or tick on every hit, and bring the voice up front.',
      calls: [
        { fn: 'timeline.create', note: 'widescreen, 30 fps' },
        { fn: 'edit.batch', note: 'nine scenes at their frames' },
        { fn: 'media.import', note: 'whooshes and pops Claude made' },
        { fn: 'edit.batch', note: '31 effects on the hits' },
        { fn: 'qa.check', note: 'no gaps, no black frames' },
        { fn: 'audio.set_gain', note: 'voice up front' },
        { fn: 'audio.set_master', note: 'loud, no clipping' },
        { fn: 'export.video', note: 'widescreen, 0:40' },
      ],
      status: 'Animating the beats…',
      done: 'Your 40-second explainer is ready: every beat moves on its word, the voice sits up front and the effects land on the hits. Want a vertical cut for Shorts?',
      video: {
        src: '/demo/explainer/master.mp4',
        poster: '/demo/explainer/master.jpg',
        label: 'tip-1-motion-graphics.mp4 · 0:40',
        seconds: 40.5,
        captions: '/demo/explainer/master.vtt',
        wide: true,
      },
    },
  ],
};

// A streamer's 2:20 stream of Pulse Swarm, an original arcade game rendered on cuttingfloor, with
// his facecam (generated streamer, lip-synced to his commentary; edited for real by cuttingfloor).
const STREAM: Demo = {
  id: 'stream',
  slug: 'turn-a-gaming-stream-into-shorts',
  title: 'Turn a gaming stream into Shorts',
  description:
    'A streamer asks ChatGPT for a vertical Short from his stream. cuttingfloor opens on his boss win, stacks his facecam over the gameplay, zooms in on the big moments and adds word-by-word captions, meme sound effects and slow-mo replays: three Shorts from one stream.',
  steps: [
    'Followed the steps for turning a long video into Shorts.',
    'Wrote down every word of the stream, with when it was said.',
    'Looked through the stream to find the boss kill, the 50 combo and the crash.',
    'Opened the boss Short on the win, then went back to the hit that left him on his last life.',
    'Put his facecam across the top and the game underneath.',
    'Zoomed in and shook the picture on every big moment: the kill, the 50 combo and the crash.',
    'Put a short title at the top of each Short in the first second.',
    'Added big captions that light up word by word, on a purple-to-pink bar that only shows while he talks.',
    'Fixed the words the transcript misheard, like “China” for “chain it” and “Vector 7” for “Sector 7”.',
    'Added meme sound effects under his voice: an explosion and a crowd cheer on the win, dings and an airhorn on the combo, a boom and a sad trombone on the crash.',
    'Added a slow-motion replay of the 50 combo and of the crash.',
    'Ended each Short where it loops back to its start, and exported all three vertical.',
  ],
  uploaded: '2026-11-21',
  skill: 'turn-a-long-video-into-shorts',
  guide: 'turn-a-long-video-into-shorts',
  fix: 'make-a-video-vertical',
  moments: [
    { name: 'Hook: It’s down!', start: 0, end: 2.1 },
    { name: 'One life left', start: 2.1, end: 6.1 },
    { name: 'Ten percent', start: 6.1, end: 10.1 },
    { name: 'It’s down!', start: 10.1, end: 12.9 },
    { name: 'New high score', start: 12.9, end: 14.8 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/stream/raw.mp4',
    poster: '/demo/stream/raw.jpg',
    label: 'kairoplays-sector-7-stream.mp4 · 2:20',
    seconds: 140,
    captions: '/demo/stream/raw.vtt',
    wide: true,
  },
  extra: [
    {
      src: '/demo/stream/combo.mp4',
      poster: '/demo/stream/combo.jpg',
      label: 'fifty-combo-short.mp4 · 0:15',
      seconds: 15.6,
      captions: '/demo/stream/combo.vtt',
      caption: 'Short 2: the 50 combo',
    },
    {
      src: '/demo/stream/fail.mp4',
      poster: '/demo/stream/fail.jpg',
      label: 'do-not-clip-that-short.mp4 · 0:17',
      seconds: 17.2,
      captions: '/demo/stream/fail.vtt',
      caption: 'Short 3: “Do not clip that”',
    },
  ],
  transcript: [
    { text: 'Yo yo yo, what’s up chat! We are back! Pulse Swarm, sector seven.', cut: 0 },
    { text: '[warming up on the small ones, shout-outs to chat]', cut: 0 },
    { text: 'Ooh, here comes a big wave. Okay, chain it, chain it, chain it!' },
    { text: 'Wait, wait, wait! Twenty! Thirty! No way. No way!' },
    { text: 'Oh my god, that laser was this close! FIFTY! Fifty combo! Let’s go!' },
    { text: 'Honestly? I’m kind of cracked at this game. Nobody is touching me right now.' },
    {
      text: '[flies straight into a mine] No, no, no. Did I just fly into that? It wasn’t even moving!',
    },
    { text: 'Chat. Do not clip that. I’m serious.' },
    {
      text: 'Okay. Focus. We’ve still got two lives. [the boss warning, the first ten seconds of the fight]',
      cut: 0,
    },
    { text: 'Ah! I got hit! One life left, chat. Nobody talk to me.' },
    { text: 'It’s at ten percent. Five percent. Come on, come on, come on!' },
    { text: 'No way! It’s down! Let’s go! Sector seven, done! New high score!' },
    { text: 'GG, chat. That one is going in the highlights. Peace!', cut: 0 },
  ],
  turns: [
    {
      prompt:
        'Find the best moment in this stream and make a 30-second vertical Short: facecam on top, gameplay below, big word-by-word captions and a zoom on the big play.',
      reply:
        'I’ll read everything you said and look through the stream for the big play, then cut it vertical with your facecam on top, the game underneath, captions that light up as you speak and a zoom on the moment.',
      calls: [
        { fn: 'skills.get', note: 'long video into Shorts' },
        { fn: 'media.import', note: 'the 2:20 stream' },
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'render.frames', note: 'found the hit, the countdown, the kill' },
        { fn: 'media.analyze', note: 'listened again to the countdown' },
        { fn: 'timeline.create', note: 'vertical, one for the Short' },
        { fn: 'edit.batch', note: 'the win first, then his last life' },
        { fn: 'edit.batch', note: 'facecam on top, zoom and shake on the kill' },
        { fn: 'skills.get', note: 'Shorts-style captions' },
        { fn: 'create.matte', note: 'purple-to-pink caption bar' },
        { fn: 'edit.batch', note: '17 captions, a bar only while he talks' },
        { fn: 'title.add', note: '“Last life vs the final boss”' },
        { fn: 'render.frames', note: 'the bar hid “New high score”, moved the zoom' },
        { fn: 'export.video', note: 'vertical, 0:14' },
      ],
      status: 'Finding your best moment…',
      done: 'Your best moment is the boss win on your last life. I kept it to 14 seconds so it opens on the kill, goes back to the hit that left you on one life, and ends on “New high score!” so it loops. Want meme sound effects on it, and Shorts of the 50 combo and the crash too?',
      video: {
        src: '/demo/stream/cut.mp4',
        poster: '/demo/stream/cut.jpg',
        label: 'last-life-boss-win.mp4 · 0:14',
        seconds: 14.8,
        captions: '/demo/stream/cut.vtt',
      },
    },
    {
      prompt: 'Yes! Add meme sound effects and make the other two.',
      reply:
        'I’ll put sounds from the effects pack under your voice, then cut the 50 combo and the crash the same way, each with a zoom on the moment and a slow-mo replay.',
      calls: [
        { fn: 'media.import', note: '10 sounds from the effects pack' },
        { fn: 'edit.batch', note: 'explosion and crowd cheer on the win' },
        { fn: 'edit.batch', note: 'the 50 combo: dings, airhorn, zoom on the counter' },
        { fn: 'edit.batch', note: 'the crash: zoom, shake and a boom' },
        { fn: 'clip.set_speed', note: 'slow-mo replays, new in-between frames' },
        { fn: 'caption.add', note: '36 captions, word by word' },
        { fn: 'title.add', note: '“He told chat not to clip it”' },
        { fn: 'qa.check', note: 'voice above the sounds' },
        { fn: 'audio.set_master', note: 'peaks under −1.5 dB' },
        { fn: 'render.frames', note: 'checked every zoom' },
        { fn: 'export.video', note: 'three vertical Shorts' },
      ],
      status: 'Adding the sound effects…',
      done: 'All three are ready: the boss win (0:14), the 50 combo (0:15) and “Chat, do not clip that” (0:17), each with a title up top, captions that light up word by word and sound effects under your voice. The crash has a boom, a slow-mo replay and a sad trombone. I fixed “China” to “chain it” and “Vector 7” to “Sector 7”. Want a longer cut of the whole boss fight too?',
      video: {
        src: '/demo/stream/short.mp4',
        poster: '/demo/stream/short.jpg',
        label: 'last-life-boss-win-short.mp4 · 0:14',
        seconds: 14.8,
        captions: '/demo/stream/short.vtt',
      },
    },
  ],
};

// A creator's money-tips video filmed in a messy, badly lit bedroom (generated footage, edited for
// real by cuttingfloor): the room swapped for a cinematic black backdrop, with captions.
const BGSWAP: Demo = {
  id: 'bgswap',
  slug: 'replace-the-background-behind-a-person-in-a-video',
  title: 'Replace the messy background behind you with a cinematic black, and add captions',
  description:
    'A creator gives ChatGPT a 28-second money-tips video filmed on his phone in a cluttered, badly lit bedroom. cuttingfloor cuts him out of the room, puts him on a dark backdrop with a soft warm light behind his head, lights him to match, cleans up his voice and adds bold captions that follow his words: a 24-second Short, plus a second version on a deep blue.',
  steps: [
    'Wrote down every word he says with its time.',
    'Cut him out of the room on every frame, hair and hands included, with no green screen, and looked closely at the edge round his hair and hands.',
    'Put him on a near-black backdrop with a soft warm light behind his head, so his hair stands out against it, and darker corners like a studio portrait.',
    'Brightened his face a little, added contrast and toned the colour down so he looks lit for the new backdrop, and added a touch of film grain over everything so he and the backdrop look like one picture.',
    'Cut the long pause after “That one hurt” and the repeated “think about it”, and pushed in closer on every other part so the cuts feel on purpose.',
    'Put bold captions under his face, two or three words at a time, with the word he is saying in gold and the key words gold: money rules, pay yourself first, twice, automate, payday.',
    'Kept “3 money rules I wish I knew at 22” at the top the whole time, in the empty dark space above his head.',
    'Cleaned up the room sound in his voice and made it loud and even for phones, with peaks under −1 dB.',
    'Made a second version on a deep blue backdrop in a brand colour, with his skin cooled a little to match.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Three money rules I wish I knew at 22', start: 0, end: 3.7 },
    { name: 'Rule one: pay yourself first', start: 3.7, end: 8.75 },
    { name: 'Rule two: if you can’t buy it twice', start: 8.75, end: 14.46 },
    { name: 'Rule three: automate it', start: 14.46, end: 20 },
    { name: 'Save this for payday', start: 20, end: 23.8 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/bgswap/raw.mp4',
    poster: '/demo/bgswap/raw.jpg',
    label: 'messy-room-talk.mp4 · 0:28',
    seconds: 28.1,
    captions: '/demo/bgswap/raw.vtt',
  },
  extra: [
    {
      src: '/demo/bgswap/brand-blue.mp4',
      poster: '/demo/bgswap/brand-blue.jpg',
      label: 'money-rules-brand-blue.mp4 · 0:24',
      seconds: 23.8,
      captions: '/demo/bgswap/brand-blue.vtt',
      caption: 'The second version, on a deep blue backdrop',
    },
  ],
  transcript: [
    { text: 'Three money rules I wish someone told me at 22.' },
    { text: 'Rule one: pay yourself first. Before rent, before anything.' },
    { text: 'Rule two: if you can’t buy it twice, you can’t afford it.' },
    { text: 'Yeah, that one hurt.' },
    { text: 'Rule three: automate it. Set it up once and you never have to think about it,' },
    { text: 'think about it', cut: 0 },
    { text: 'again.' },
    { text: 'Save this for payday and follow for more money tips.' },
  ],
  turns: [
    {
      prompt:
        'I filmed this in my bedroom and the room is a mess. Can you get rid of the background behind me, make it a stylish cinematic black like a studio, and add captions? Keep it looking like me.',
      reply:
        'I’ll cut you out of the room, put you on a dark backdrop with a soft light behind your head, light you to match so it looks real, and add bold captions that follow your words. I’ll leave your face and colours natural.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for swapping a background' },
        { fn: 'media.import', note: 'his video' },
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'create.cutout', note: 'him without the room, hair and hands included' },
        { fn: 'render.frames', note: 'checked the edge round his hair and hands' },
        {
          fn: 'create.cutout',
          note: 'a second try that follows him from one frame: it took the bed too, so kept the first',
        },
        { fn: 'create.still', note: 'the dark backdrop with a soft warm light' },
        { fn: 'timeline.create', note: 'vertical, 24 fps' },
        { fn: 'edit.batch', note: 'backdrop, him over it, the pauses cut, push-ins' },
        { fn: 'edit.batch', note: 'matched his light: brighter face, contrast, grain' },
        { fn: 'edit.batch', note: 'captions with the spoken word in gold, the title on top' },
        { fn: 'edit.batch', note: 'voice cleaned up, made louder and even' },
        { fn: 'render.frames', note: 'checked the captions and the title' },
        { fn: 'qa.check', note: 'loudness, peaks and every cut' },
        { fn: 'export.video', note: 'vertical, 0:24' },
        { fn: 'create.still', note: 'a deep blue backdrop' },
        { fn: 'edit.batch', note: 'the second version, cooler to match the blue' },
        { fn: 'export.video', note: 'vertical, 0:24' },
      ],
      status: 'Cutting you out of the room…',
      done: 'Your 24-second Short is ready: the room is gone, you’re on a dark backdrop with a soft light behind you, your voice is clean and loud, and the captions follow every word with the key ones in gold. I made a second one on a deep blue too, in case you want a brand colour. Want a version without the title at the top?',
      video: {
        src: '/demo/bgswap/cut.mp4',
        poster: '/demo/bgswap/cut.jpg',
        label: 'money-rules-cinematic-black.mp4 · 0:24',
        seconds: 23.8,
        captions: '/demo/bgswap/cut.vtt',
      },
    },
  ],
};

// A singer's original song and six phone clips of her singing at home (generated song and footage,
// edited for real by cuttingfloor), cut into a lyric Short.
const LYRIC: Demo = {
  id: 'lyric',
  slug: 'make-a-lyric-video-for-your-song',
  title: 'Make a lyric video for your song, with every word on screen as it’s sung',
  description:
    'A singer gives Kazi her original song and six phone clips of her singing at home. cuttingfloor finds every sung word and its time, then makes a 28-second lyric Short for TikTok and Reels: each word on screen as she sings it, the key words big and gold, the words moving with the beat, the clips cut to the beat and the hook line as the big moment.',
  steps: [
    'Pulled her voice out of the music and wrote down every sung word with its time.',
    'Fixed the words it misheard: “ain’t all my hands” was “Paint on my hands”, “window blow” was “window glow”, “the wall starts” was “the walls start”.',
    'Took the strongest 28 seconds, from “Everybody told me slow down” through the chorus, so it opens on a line, not the slow intro.',
    'Put every word on screen on the frame she sings it: a line at a time in the verse, a few huge words at a time in the chorus.',
    'Made the key words gold and bigger: slow down, heart, up, shaking, waking, spotlight, spark.',
    'Made the words pulse on every beat after the drop, shake on “shaking” and stretch out with the long note on “spotlight”.',
    'Cut her six clips to the beat: a shot a bar in the verse, faster into the chorus, a zoom-in and a white flash on the drop.',
    'Made “I’m the spark tonight” the big moment: a flash, sparks and the biggest words, on her closest shot.',
    'Gave the footage a warm, moodier look and darkened the middle of the picture behind the words so they read on every shot.',
    'Kept the song loud for phones, with peaks under −1 dB.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Everybody told me slow down', start: 0, end: 3.4 },
    { name: 'But my heart don’t know how', start: 3.4, end: 8.6 },
    { name: 'Turn it up', start: 8.6, end: 15.4 },
    { name: 'Every street is waking', start: 15.4, end: 17.5 },
    { name: 'I don’t need a spotlight', start: 17.5, end: 21 },
    { name: 'I’m the spark tonight', start: 21, end: 28.1 },
  ],
  agent: 'Kazi',
  raw: {
    src: '/demo/lyric/raw.mp4',
    poster: '/demo/lyric/raw.jpg',
    label: 'song-and-footage.mp4 · 0:38',
    seconds: 37.6,
    captions: '/demo/lyric/raw.vtt',
  },
  transcript: [
    { text: 'Paint on my hands and the radio low', cut: 0 },
    { text: 'Counting the cracks in the window glow', cut: 0 },
    { text: 'Everybody told me slow down, slow down' },
    { text: 'But my heart don’t know how' },
    { text: 'Turn it up, till the walls start shaking' },
    { text: 'Turn it up, turn it up' },
    { text: 'Every street is waking' },
    { text: 'I don’t need a spotlight' },
    { text: 'I’m the spark tonight' },
    { text: 'I’m the spark, till the walls start shaking' },
    { text: 'I’m the spark' },
  ],
  turns: [
    {
      prompt:
        'I wrote and recorded this song and filmed a few clips of me singing at home. Make me a lyric video for TikTok and Reels: the words on screen as I sing them, and make the chorus hit.',
      reply:
        'I’ll take the strongest 28 seconds, from “Everybody told me slow down” through the chorus, put every word on screen as you sing it, cut your clips to the beat and make “I’m the spark tonight” the big moment.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for lyric videos' },
        { fn: 'media.import', note: 'the song and six clips' },
        { fn: 'create.stems', note: 'her voice on its own' },
        { fn: 'media.analyze', note: 'every sung word, timed' },
        { fn: 'media.analyze', note: 'the beats of the song' },
        { fn: 'create.motion', note: 'the words, timed to her singing and the beat' },
        { fn: 'timeline.create', note: 'vertical, 30 fps' },
        { fn: 'edit.batch', note: '18 shots on the beat, the song under them' },
        { fn: 'edit.batch', note: 'warm look, zoom-ins, a flash on the drop' },
        { fn: 'render.frames', note: 'checked each word lands on its frame' },
        { fn: 'create.motion', note: 'bigger verse words, one frame earlier' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'audio.set_master', note: 'peaks under −1 dB once encoded' },
        { fn: 'export.video', note: 'vertical, 0:28' },
      ],
      status: 'Timing every word to your singing…',
      done: 'Your 28-second lyric Short is ready: every word lands as you sing it, the chorus hits with big gold words on the beat, and “I’m the spark tonight” gets the flash and the sparks. Want a version that opens straight on the hook?',
      video: {
        src: '/demo/lyric/cut.mp4',
        poster: '/demo/lyric/cut.jpg',
        label: 'the-spark-lyric-short.mp4 · 0:28',
        seconds: 28.1,
        captions: '/demo/lyric/cut.vtt',
      },
    },
  ],
};

// A small pottery studio's six product photos of a new mug collection, a recorded voiceover and an
// original music track (generated, edited for real by cuttingfloor), cut into a promo in two versions.
const PROMO: Demo = {
  id: 'promo',
  slug: 'make-a-product-promo-from-photos',
  title: 'Make a product promo video from photos, with two different openings',
  description:
    'A small pottery studio gives Claude six photos of its new mugs, a recorded voiceover and an original music track. cuttingfloor turns them into a 22-second promo for Reels and WhatsApp Status, with every photo moving, the key words on screen, the price and a call to action, then a second version that opens with the offer to test against it.',
  steps: [
    'Looked at all six photos and read the voiceover word by word.',
    'Opened on the problem, “Your morning coffee deserves better”, with a quick push in so something moves in the first second.',
    'Cut the mug out of the hands-and-coffee photo and moved it faster than the background, so the still photo looks 3D.',
    'Gave every photo its own move: a slow push in, a turn on the flat lay, a slide down the glaze, a pull back that reveals all four mugs.',
    'Changed photo on every line of the voice, and tightened the pauses between lines.',
    'Put the key words on screen as she says them: “deserves better”, “Ember collection”, “made by hand”, “the same”, “gift-boxed”.',
    'Ended on the offer, $28 each or all four for $90 with free shipping this week, then “Tap the link” held long enough to act on.',
    'Laid the original music under the voice, quieter while she talks and up again at the end, with a cup set down at the start and a soft whoosh into the reveal and the offer.',
    'Made the voice loud and even for phones, with peaks under −1 dB.',
    'Made a second, 18-second version that opens with the offer instead, for testing which opening sells better.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Hook: your coffee deserves better', start: 0, end: 3.73 },
    { name: 'The Ember collection', start: 3.73, end: 5.17 },
    { name: 'Made by hand', start: 5.17, end: 8.5 },
    { name: 'No two the same', start: 8.5, end: 12.57 },
    { name: 'Gift-boxed', start: 12.57, end: 14.63 },
    { name: 'All four for $90', start: 14.63, end: 19.03 },
    { name: 'Tap the link', start: 19.03, end: 22.1 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/promo/raw.mp4',
    poster: '/demo/promo/raw.jpg',
    label: 'promo-stills.mp4 · 0:22',
    seconds: 21.6,
    captions: '/demo/promo/raw.vtt',
  },
  extra: [
    {
      src: '/demo/promo/offer-first.mp4',
      poster: '/demo/promo/offer-first.jpg',
      label: 'ember-mugs-offer-first.mp4 · 0:18',
      seconds: 18.5,
      captions: '/demo/promo/offer-first.vtt',
      caption: 'The second version, opening with the offer',
    },
  ],
  transcript: [
    { text: 'Your morning coffee deserves better than a mug from the supermarket.' },
    { text: 'Meet the Ember collection.' },
    { text: 'Four new glazes, each one made by hand in our little studio.' },
    { text: 'The glaze pools and drips in the kiln, so no two mugs are ever the same.' },
    { text: 'They come gift-boxed, ready to give.' },
    { text: 'Twenty-eight dollars each, or all four for ninety.' },
    { text: 'Free shipping this week only.' },
    { text: 'Tap the link and pick yours.' },
  ],
  turns: [
    {
      prompt:
        'I make mugs and sell them on Instagram and WhatsApp. Here are six photos of my new collection, my voice recording and a music track. Make me a short promo for Reels and Status with the price at the end, and a second version with a different opening so I can see which one sells better.',
      reply:
        'I’ll open the first one on the problem your voice starts with, give every photo its own move, put the key words on screen as you say them, and end on your offer and “Tap the link”. The second one opens straight on the price and free shipping.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for photo promos' },
        { fn: 'media.import', note: 'six photos, the voice and the music' },
        { fn: 'render.frames', note: 'checked the cut-out mug' },
        { fn: 'media.analyze', note: 'the beats of the music' },
        { fn: 'media.get', note: 'every word of the voice, timed' },
        { fn: 'create.cutout', note: 'the mug and hands, for a 3D move' },
        { fn: 'sounds.list', note: 'a cup set down, a soft whoosh' },
        { fn: 'create.motion', note: 'the words on screen, the price and the call to action' },
        { fn: 'timeline.create', note: 'vertical, 30 fps' },
        {
          fn: 'edit.batch',
          note: 'nine shots with moves, the voice tightened, the music under it',
        },
        {
          fn: 'render.frames',
          note: 'split a long close-up and fixed text running off the screen',
        },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'audio.set_master', note: 'louder for phones, peaks under −1 dB' },
        { fn: 'export.video', note: 'vertical, 0:22' },
        { fn: 'edit.batch', note: 'the second version: the offer first' },
        { fn: 'export.video', note: 'vertical, 0:18' },
      ],
      status: 'Moving your photos and timing the words…',
      done: 'Both versions are ready. The first, 22 seconds, opens on “Your morning coffee deserves better” and ends on all four for $90 with free shipping and “Tap the link”. The second, 18 seconds, opens on the price. Post one to Reels and the other to Status and see which brings more orders. Want a square one for the feed too?',
      video: {
        src: '/demo/promo/cut.mp4',
        poster: '/demo/promo/cut.jpg',
        label: 'ember-mugs-problem-first.mp4 · 0:22',
        seconds: 22.1,
        captions: '/demo/promo/cut.vtt',
      },
    },
  ],
};

// Six AI-generated clips of a lighthouse keeper on a stormy night, out of order (generated footage,
// edited for real by cuttingfloor).
const FILM: Demo = {
  id: 'film',
  slug: 'edit-ai-video-clips-into-a-short-film',
  title: 'Edit AI video clips into a short film',
  description:
    'A creator gives ChatGPT six AI-generated clips of a lighthouse keeper on a stormy night, out of order, each a different colour and loudness. cuttingfloor puts them in story order, trims the dead starts, gives every shot one film look and adds an original score, storm sounds, footsteps and titles: a 43-second short film and a vertical trailer.',
  steps: [
    'Looked at all six clips and found where each one starts, ends and goes wrong.',
    'Put the shots in story order: the storm, the run up the cliff, the stairs, the lamp, the boat, the dawn.',
    'Cut the dead starts and frozen ends, and the frame of the reference photo that flashes at the start of two clips.',
    'Kept only the best seconds of each clip, so no shot runs the same length.',
    'Measured the colour of every shot, fixed each one’s tint and brightness, then put one film look over all of them, with grain, a dark edge and wide-screen bars.',
    'Had an original score made, then cut to it: the music drops out when the light dies, the thunder fills the silence, and the big swell lands as the lamp lights up.',
    'Added the sound the clips didn’t have: wind and waves, rain that goes quiet indoors, footsteps on the stairs, the match strike, a deep hit on the lamp, a far-off ship’s horn and gulls at dawn.',
    'Evened out the clips’ own sound, from the silent stairs clip to the very loud boat clip.',
    'Faded in from black on the wind, dissolved from the night into the dawn and faded out to the end title.',
    'Made an opening title and an end title in the same thin, wide lettering.',
    'Checked every cut, the loudness and the peaks, exported it wide-screen and cut an 18-second vertical trailer.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Title: The Keeper', start: 0, end: 7.6 },
    { name: 'The light goes out', start: 7.6, end: 9 },
    { name: 'Running through the storm', start: 9, end: 14 },
    { name: 'Up the stairs', start: 14, end: 20.6 },
    { name: 'Lighting the lamp', start: 20.6, end: 26.2 },
    { name: 'The boat turns away', start: 26.2, end: 32.7 },
    { name: 'Dawn', start: 32.7, end: 40 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/film/raw.mp4',
    poster: '/demo/film/raw.jpg',
    label: 'ai-film-clips.mp4 · 0:53',
    seconds: 52.8,
    wide: true,
  },
  extra: [
    {
      src: '/demo/film/trailer.mp4',
      poster: '/demo/film/trailer.jpg',
      label: 'the-keeper-trailer.mp4 · 0:18',
      seconds: 18.6,
      caption: 'The vertical trailer',
    },
  ],
  transcript: [
    { text: 'Clip 1: the reference photo flashes up first', cut: 0 },
    { text: 'Clip 1: the tower in the rain, then she lights the lamp' },
    { text: 'Clip 1: a frozen frame at the end', cut: 0 },
    { text: 'Clip 2: a frozen start, then dawn, tea, the boat sails home' },
    { text: 'Clip 3: she runs up the cliff with a lantern, lightning (green, cool colour)' },
    { text: 'Clip 4: a frozen start, then the lighthouse in the storm, the light dies (too dark)' },
    { text: 'Clip 5: she climbs the spiral stairs, no sound at all (pink tint)' },
    { text: 'Clip 6: a fishing boat heads for the rocks, the beam sweeps (very loud)' },
  ],
  turns: [
    {
      prompt:
        'I made six clips for a short film with an AI video tool. They’re out of order, the colours don’t match, some start frozen and one has no sound. Cut them into one proper short film with music, sound effects and titles.',
      reply:
        'I’ll look at every clip, put them in story order, trim the frozen and broken bits, make all the shots match with one film look, then build the sound: an original score, the storm, footsteps and the big moments. Titles at both ends.',
      calls: [
        { fn: 'media.upload', note: 'six AI clips in one file' },
        { fn: 'media.import', note: 'the clips, and an original score made for this film' },
        { fn: 'media.analyze', note: 'where each clip starts and ends' },
        { fn: 'render.frames', note: 'found the flashes of the reference photo' },
        { fn: 'media.analyze', note: 'the beats and the quiet part of the score' },
        { fn: 'media.analyze', note: 'measured the colour of every shot' },
        {
          fn: 'sounds.list',
          note: 'wind, waves, rain, thunder, footsteps, a match, a hit, a horn, gulls',
        },
        { fn: 'media.import', note: 'nine sounds and seven colour fixes (LUTs)' },
        { fn: 'timeline.create', note: 'wide-screen, 24 fps' },
        { fn: 'edit.batch', note: 'seven shots in story order, best seconds only' },
        { fn: 'create.motion', note: 'opening and end titles' },
        { fn: 'create.still', note: 'wide-screen bars' },
        { fn: 'edit.batch', note: 'colour fixes, one film look, grain, titles' },
        { fn: 'edit.batch', note: 'score, sound effects, levels, fades' },
        { fn: 'render.frames', note: 'cut a shot where the lamp was already lit' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'wide-screen, 0:43, and a vertical trailer' },
      ],
      status: 'Putting your shots in story order…',
      done: 'Your short film is ready: 43 seconds, the six clips in story order with the frozen starts cut, one film look over every shot, an original score that drops out when the light dies and swells as she lights the lamp, and the storm, the stairs and the dawn all with their own sound. I also cut an 18-second vertical trailer. Want a version without the bars for Shorts?',
      video: {
        src: '/demo/film/cut.mp4',
        poster: '/demo/film/cut.jpg',
        label: 'the-keeper.mp4 · 0:43',
        seconds: 43.5,
        wide: true,
      },
    },
  ],
};

// Five phone clips of a car on a coast road at sunset (generated footage, edited for real by cuttingfloor).
const CAR: Demo = {
  id: 'car',
  slug: 'make-a-cinematic-car-edit',
  title: 'Make a cinematic car edit from phone clips',
  description:
    'A creator gives Claude five flat phone clips of a car on a coast road at sunset. Claude has an original beat made for it, and cuttingfloor cuts on it, slows down on the best moments, grades the colour, adds whooshes and engine sound and slams a title in on the drop: a 20-second Short.',
  steps: [
    'Looked at all five clips to find the best moments: the pass in front of the sun, the launch, the corner, the sun through the windscreen.',
    'Had an original beat made, with a build at the start and a big drop, so there’s no copyright claim.',
    'Found every beat and the drop, then cut to a new shot on the beat.',
    'Opened on the car coming round the corner, sped up, so something happens in the first second.',
    'Sped into each best moment, went slow-motion through it on the quiet part of the beat, then sped back out when the beat came back.',
    'Made new in-between frames for every slow-motion part, so it plays smooth instead of choppy.',
    'Made a moody colour grade: warm, golden highlights, cool shadows, more contrast, a dark edge and a little film grain.',
    'Punched in on the drop with a short shake, and pushed in slowly on the last shot.',
    'Added whooshes into every slow-motion part, a low boom on the drop, an engine growl at the start, a car speeding away on two passes and the car’s own engine on the launch.',
    'Made two animated titles: “GOLDEN HOUR” slams in on the drop, and “COAST RUN” ends it.',
    'Checked every cut and the sound, made it louder with peaks under −1 dB, and exported it vertical.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Round the corner', start: 0, end: 0.9 },
    { name: 'Golden hour', start: 0.9, end: 3.25 },
    { name: 'The pass, in slow motion', start: 3.25, end: 5.6 },
    { name: 'Launch', start: 7, end: 9.8 },
    { name: 'The corner', start: 10.7, end: 13 },
    { name: 'Sun through the windscreen', start: 14, end: 15.9 },
    { name: 'Into the sun', start: 17.1, end: 19.6 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/car/raw.mp4',
    poster: '/demo/car/raw.jpg',
    label: 'car-takes.mp4 · 0:36',
    seconds: 36.2,
  },
  transcript: [
    { text: 'Clip 1: the car drives past in front of the sun' },
    { text: 'Clip 1: an empty road before it arrives', cut: 0 },
    { text: 'Clip 2: running alongside the front wheel' },
    { text: 'Clip 3: parked with the sun behind it, then the launch' },
    { text: 'Clip 4: driving, hands on the wheel, the sun through the windscreen' },
    { text: 'Clip 5: the car comes round a corner by the sea' },
    { text: 'Clip 5: driving away into the sun' },
    { text: 'Wind and road noise under every clip', cut: 0 },
  ],
  turns: [
    {
      prompt:
        'I filmed my car on the coast road at sunset on my phone. Make it a fast cinematic edit for Shorts: speed ramps, cuts on the beat, a moody colour grade, whooshes and some text. No copyrighted music.',
      reply:
        'I’ll get an original beat made for you, then cut your clips on it: a strong first second, slow motion through your best moments, a moody grade, whooshes and engine sound, and a title on the drop.',
      calls: [
        { fn: 'media.import', note: 'five phone clips' },
        { fn: 'render.frames', note: 'looked at every clip' },
        { fn: 'media.import', note: 'an original beat, made for this edit' },
        { fn: 'media.analyze', note: 'found the beats and the drop' },
        { fn: 'sounds.list', note: 'whooshes, a boom, engine sounds' },
        { fn: 'media.import', note: 'a colour grade (LUT) and five sounds' },
        { fn: 'timeline.create', note: 'vertical, 24 fps' },
        { fn: 'edit.batch', note: '20 shots on the beat, 5 speed ramps' },
        { fn: 'edit.batch', note: 'the beat, sound effects, the grade' },
        { fn: 'create.motion', note: '“GOLDEN HOUR” and “COAST RUN” titles' },
        { fn: 'edit.batch', note: 'titles, punch-in and shake on the drop' },
        { fn: 'render.frames', note: 'fixed a title running off the screen' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'vertical, 0:20' },
      ],
      status: 'Cutting your clips to the beat…',
      done: 'Your 20-second edit is ready: an original 129 BPM beat, a cut on the beat, slow motion through the pass in front of the sun, the launch, the corner and the windscreen, a warm, moody grade, and “GOLDEN HOUR” slamming in on the drop. Want a 9-second version for a story too?',
      video: {
        src: '/demo/car/cut.mp4',
        poster: '/demo/car/cut.jpg',
        label: 'coast-run.mp4 · 0:20',
        seconds: 19.6,
      },
    },
  ],
};

export const DEMOS: Demo[] = [
  BGSWAP,
  LYRIC,
  PROMO,
  FILM,
  CAR,
  STREAM,
  INTERVIEW,
  EXPLAINER,
  TIPS,
  MEMORY,
  PRODUCT,
  JEV,
  LISTING,
  DANCE,
];

export function demo(slug: string): Demo | undefined {
  return DEMOS.find((d) => d.slug === slug);
}

/** The finished video: the last turn's. */
export function finished(d: Demo): DemoVideo {
  return d.turns.at(-1)?.video ?? d.raw;
}

/** A video's length as its label gives it: "0:24". */
export function length(v: DemoVideo): string {
  return v.label.split(' · ').at(-1) ?? '';
}

/** Before and after lengths, "0:24 → 0:15", or one length when the edit kept it. */
export function lengths(d: Demo): string {
  const [before, after] = [length(d.raw), length(finished(d))];
  return before === after ? after : `${before} → ${after}`;
}

/** The demo that shows a skill, for a link from the skill's page. */
export function demoForSkill(slug: string): Demo | undefined {
  return DEMOS.find((d) => d.skill === slug);
}
