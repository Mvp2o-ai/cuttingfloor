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
    'A dancer gives Kazi four takes of a Motion Party-style routine. cuttingfloor makes an original beat, cuts a new shot on every bar, slows into the big move and puts each move’s name on screen: a 23-second Short.',
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
        { fn: 'code.run', note: 'made an original beat' },
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
        { fn: 'code.run', note: 'measured where each person talks' },
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
        { fn: 'code.run', note: 'drew the name cards' },
        { fn: 'media.analyze', note: 'found the faces' },
        { fn: 'caption.add', note: 'every line, per speaker' },
        { fn: 'text.set', note: 'gold for him, pink for her' },
        { fn: 'edit.batch', note: 'placed the name cards' },
        { fn: 'code.run', note: 'vertical, framed on faces' },
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
        { fn: 'code.run', note: 'found where she speaks' },
        { fn: 'edit.batch', note: 'hook first, six pieces' },
        { fn: 'clip.set_speed', note: 'sped up the application' },
        { fn: 'code.run', note: 'made a soft beat' },
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
        { fn: 'code.run', note: 'found the speech and the flub' },
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
        { fn: 'code.run', note: 'words beside speech, per take' },
        { fn: 'code.run', note: 'Jev marked restarts and repeats' },
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
        { fn: 'code.run', note: 'captions and hook title' },
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

export const DEMOS: Demo[] = [DANCE, INTERVIEW, PRODUCT, LISTING, TIPS];

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

/** The demo that shows a skill, for a link from the skill's page. */
export function demoForSkill(slug: string): Demo | undefined {
  return DEMOS.find((d) => d.skill === slug);
}
