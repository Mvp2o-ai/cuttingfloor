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
  /** Its sound is the point (a voice with no music yet, a hum): sound controls wherever it plays. */
  sound?: boolean;
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

// One dancer's routine filmed six ways in a parking garage at night (generated footage, edited for
// real by cuttingfloor): a multi-angle dance edit cut on the hits of an original beat.
const DANCE: Demo = {
  id: 'dance',
  slug: 'edit-a-dance-short-to-the-beat',
  title: 'Cut one dance routine filmed from six angles into a Short, on the beat',
  description:
    'A dancer gives Kazi six takes of the same routine, filmed wide, waist-up, low from the floor, from the side, on his feet and close up, in a parking garage at night. Kazi makes an original beat, and cuttingfloor cuts between the angles on the hits, slows into the spin, punches in on the big moves and grades it: a 22-second Short.',
  steps: [
    'Looked at all six takes to find each move in each one: the bounce, the arms snapping out, the chest hits, the drop down low, the spin and the point at the camera.',
    'Made an original hip-hop beat with hard hits, so there’s no copyright claim.',
    'Found the beats and the hits in the music, and where the drop lands.',
    'Opened on the payoff: him pointing at the camera, close up, so the first second already grabs you, then cut to the wide shot right on the drop.',
    'Cut to a new angle on the music’s hits, in the middle of a move, so the routine keeps flowing from one camera to the next.',
    'Sped up into the spin on his feet, then went into slow motion right on the hit.',
    'Played the routine a second time with faster cuts when the beat gets bigger, zoomed in on the wide shots so he fills the frame.',
    'Punched in and shook the picture on the biggest hits, with a white flash on the drops.',
    'Slowed down his walk into the lens and froze on the point on the last hit, then let him laugh.',
    'Gave it one night look across every take: deeper blacks, warm lights, a dark edge and a little film grain.',
    'Put one clean line at the top, “One routine. Six angles.”, made it loud with peaks under −1 dB and exported it vertical. The beat is an original track made for this demo.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'The point', start: 0, end: 0.6 },
    { name: 'The drop', start: 0.6, end: 2.2 },
    { name: 'Arms and chest hits', start: 2.2, end: 4.5 },
    { name: 'Down low', start: 4.5, end: 6.1 },
    { name: 'Slow motion on the spin', start: 6.1, end: 7.75 },
    { name: 'Spin and back up', start: 7.75, end: 10.3 },
    { name: 'Again, harder', start: 10.3, end: 16.5 },
    { name: 'Point, point, point', start: 16.5, end: 20.9 },
    { name: 'The laugh', start: 20.9, end: 21.8 },
  ],
  agent: 'Kazi',
  raw: {
    src: '/demo/dance/raw.mp4',
    poster: '/demo/dance/raw.jpg',
    label: 'dance-takes.mp4 · 1:00',
    seconds: 60,
  },
  transcript: [
    { text: 'Take 1: wide, the whole routine' },
    { text: 'Take 1: walking back to the mark', cut: 0 },
    { text: 'Take 2: waist-up, the arms and chest hits' },
    { text: 'Take 2: the bounce before the hits', cut: 0 },
    { text: 'Take 3: low from the floor, dropping down and the spin' },
    { text: 'Take 4: from the side, the camera circling him' },
    { text: 'Take 5: on his feet, the footwork and the spin' },
    { text: 'Take 5: standing still at the end', cut: 0 },
    { text: 'Take 6: close up, he walks into the lens and points, then laughs' },
    { text: 'Garage room sound and sneaker squeaks under every take', cut: 0 },
  ],
  turns: [
    {
      prompt:
        'I filmed the same routine 6 times from different angles in a parking garage. Make it one dance video for TikTok that cuts between the angles on the beat, like the big dance channels do. No real song, I don’t want a copyright strike.',
      reply:
        'I’ll make you an original beat with hard hits, open on your point at the camera, then cut between your six angles on the hits so the routine flows from one camera to the next, with a slow-mo into the spin, punch-ins on the big moves and one night look over all of it.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for a dance edit' },
        { fn: 'media.import', note: 'your six takes' },
        { fn: 'render.frames', note: 'found each move in every take' },
        { fn: 'media.import', note: 'the beat Kazi made' },
        { fn: 'media.analyze', note: 'found the beats, the hits and the drop' },
        { fn: 'timeline.create', note: 'vertical, 24 fps' },
        { fn: 'clip.add', note: 'the beat, starting just before the drop' },
        { fn: 'edit.batch', note: 'the takes in order, a new angle on each hit' },
        { fn: 'edit.batch', note: 'the shots from the floor and a freeze on the point' },
        { fn: 'edit.batch', note: 'sped up into the spin, slow motion on the hit' },
        { fn: 'edit.batch', note: 'the night look on every take' },
        { fn: 'edit.batch', note: 'punch-ins, shakes and flashes on the hits' },
        { fn: 'edit.batch', note: '“One routine. Six angles.” at the top' },
        { fn: 'render.frames', note: 'checked every cut' },
        { fn: 'edit.batch', note: 'zoomed in on the wide shots, slowed the walk into the lens' },
        { fn: 'audio.set_master', note: 'loud, peaks under −1 dB' },
        { fn: 'qa.check', note: 'no gaps, loudness and peaks' },
        { fn: 'export.video', note: 'vertical, 0:22' },
      ],
      status: 'Cutting your angles on the hits…',
      done: 'Your 22-second cut is ready: it opens on your point, drops into the wide shot on the beat, switches angle on every hit, slows down into the spin and freezes on your point at the end. Want a version with your handle at the end, or a 15-second cut for Stories?',
      video: {
        src: '/demo/dance/cut.mp4',
        poster: '/demo/dance/cut.jpg',
        label: 'garage-dance.mp4 · 0:22',
        seconds: 21.8,
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

// Six sideline phone clips of one player at a local women's football club (generated footage,
// edited for real by cuttingfloor): a vertical tribute with a quiet start, slow motion on the goal,
// the music dropping as it goes in, a big-night grade and her name and number at the end.
const SPORTS: Demo = {
  id: 'sports',
  slug: 'make-a-football-player-tribute-edit',
  title: 'Make a tribute edit of your favourite player from sideline clips',
  description:
    'A fan gives ChatGPT six wide phone clips of Zola Mensah, the number 9 at their local women’s football club. cuttingfloor turns them into a 27-second vertical tribute: a quiet start in the changing room, the goal in slow motion with the music dropping as it goes in, a crowd roar, a big-night colour grade and her name and number at the end.',
  steps: [
    'Looked at all six clips to find the moments that matter: tying her boots, the shot at training, the nutmeg, the goal, the knee slide and the fans with their sign.',
    'Had an original music track made that starts quiet on a piano, builds, and drops hard, so there’s no copyright claim.',
    'Found the drop in the music and timed the edit so the ball goes past the keeper right on it.',
    'Made it vertical and moved the frame in every shot to keep her in view, since the clips were filmed wide.',
    'Started quiet: the changing room and training, with “every big night starts in here” on screen.',
    'Built up through the nutmeg and the run at goal, with “89th minute · 1–1” at the top.',
    'Went into slow motion on the goal, with new in-between frames so it plays smooth, then a white flash and a punch-in as the music drops.',
    'Added a riser into the goal, a big hit and a crowd roar on it, and kept the real crowd and the fans’ cheers under the celebration.',
    'Slowed down her knee slide and froze on her face for the end card: “ZOLA MENSAH”, “No. 9 · Harbour Town FC” and her season in one line.',
    'Made a big-night colour grade: deeper blacks, cool shadows, warm skin and a dark edge, with a little film grain.',
    'Checked the sound and peaks and exported it vertical. The music is an original track made for this demo.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Before the match', start: 0, end: 4.4 },
    { name: 'Training', start: 4.4, end: 6.4 },
    { name: 'The nutmeg', start: 6.4, end: 8.4 },
    { name: 'The goal, in slow motion', start: 8.4, end: 13.3 },
    { name: 'The knee slide', start: 13.3, end: 19.4 },
    { name: 'The fans', start: 19.4, end: 22 },
    { name: 'Zola Mensah, No. 9', start: 22, end: 26.75 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/sports/raw.mp4',
    poster: '/demo/sports/raw.jpg',
    label: 'match-highlights.mp4 · 0:22',
    seconds: 22,
    wide: true,
  },
  transcript: [
    { text: 'Clip 1: she ties her boots in the changing room and takes a breath' },
    { text: 'Clip 1: sitting still, eyes closed, looking ahead' },
    { text: 'Clip 2: training on a grey afternoon, jogging back after a shot at goal' },
    { text: 'Clip 3: she nutmegs a defender by the touchline' },
    { text: 'Clip 3: running on with the ball, the defender chasing her' },
    { text: 'Clip 4: under the floodlights, the shot and the goal' },
    { text: 'Clip 4: she runs to the fans behind the goal' },
    { text: 'Clip 5: the knee slide, her teammates running in' },
    { text: 'Clip 6: fans at the fence with a “ZOLA 9” sign' },
    { text: 'Crowd and pitch sound under every clip' },
  ],
  turns: [
    {
      prompt:
        'These are clips I filmed of Zola, our number 9, this season. Can you make her a proper tribute edit for TikTok? Emotional build, slow-mo on the goal, the music dropping when it goes in, crowd noise, her name and number at the end. Make it feel like a big night.',
      reply:
        'I’ll get an original track made that builds and drops, make your clips vertical and keep Zola in every shot, start quiet, slow the goal right down so the drop hits as it goes in, add a crowd roar and finish on her name and number, with a big-night grade.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for a tribute edit' },
        { fn: 'media.import', note: 'your six clips' },
        { fn: 'render.frames', note: 'looked at every clip for the moments' },
        { fn: 'media.import', note: 'an original track, made for this edit' },
        { fn: 'media.analyze', note: 'found the beats and the drop' },
        { fn: 'sounds.list', note: 'a crowd roar, a big hit, a riser' },
        { fn: 'media.import', note: 'the sounds and a colour grade (LUT)' },
        { fn: 'timeline.create', note: 'vertical, 24 fps' },
        { fn: 'edit.batch', note: 'the shots in order, the goal and the slide slowed down' },
        { fn: 'edit.batch', note: 'moved the frame in every shot to keep her in view' },
        { fn: 'edit.batch', note: 'the grade, the flash on the drop, the sounds, the titles' },
        { fn: 'render.frames', note: 'checked every shot and the slow motion' },
        { fn: 'media.import', note: 'her knee-slide face as a still for the end card' },
        { fn: 'edit.batch', note: 'a slow push on the end card' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'vertical, 0:27' },
      ],
      status: 'Timing the drop to the goal…',
      done: 'Zola’s tribute is ready: 27 seconds, vertical, from a quiet start in the changing room to the goal in slow motion right on the drop, the crowd roaring, and her name and number on the last frame. Want a 15-second cut for Stories too?',
      video: {
        src: '/demo/sports/cut.mp4',
        poster: '/demo/sports/cut.jpg',
        label: 'zola-tribute.mp4 · 0:27',
        seconds: 26.75,
      },
    },
  ],
};

// Six silent cartoon scenes of a short kids' story (generated animation, edited for real by
// cuttingfloor): a narrated story Short with a voice for each character, sound effects, music,
// big captions for early readers and an ending with the lesson.
const KIDS: Demo = {
  id: 'kids',
  slug: 'add-voices-and-sound-effects-to-a-kids-cartoon',
  title: 'Turn silent cartoon scenes into a kids’ story with voices and sound effects',
  description:
    'A parent gives Claude six silent cartoon scenes and a short script about Pip, a little cloud who is scared of thunder. cuttingfloor gives the narrator and each character their own voice, times every line to the action, adds a cartoon sound on every action and light music under the voices, and puts a title card, big captions for early readers and a friendly ending with the lesson on a 35-second Short.',
  steps: [
    'Looked at all six scenes to find when each thing happens: Rumble rolling in, the lightning, his shout, Daisy drooping, Pip’s deep breath, the rain and the rainbow.',
    'Made a warm storyteller voice for the narrator and a different voice for each character: a small bright voice for Pip, a big deep one for Rumble and a soft one for Daisy.',
    'Put the scenes in story order and trimmed the slow starts, with Rumble’s “BOOM!” landing just as his mouth opens.',
    'Added a sound on every action: a sparkle on the title, a swish when Pip waves, rumbles and thunder cracks for the storm, a slide when Pip hides and Daisy droops, a rising sound as Pip gets brave, a whoosh as she flies, rain, drips, a pop and chimes as Daisy blooms, and a giggle.',
    'Put an original light music track under the whole story, quiet under the voices and up a little at the end.',
    'Opened on a big friendly “Pip and the Thunder” title that pops in over Pip, read out by the narrator.',
    'Added big, simple captions at the top, a short phrase at a time, with the word being said lit up in each character’s colour so early readers can follow along.',
    'Held the last frame on the rainbow for a “The End” card with the lesson: being brave means helping, even when you’re scared.',
    'Made the voices loud and clear over the music with peaks under −1 dB. The music is an original track made for this demo.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Title: Pip and the Thunder', start: 0, end: 2 },
    { name: 'Pip, the smallest cloud', start: 2, end: 7 },
    { name: 'Rumble rolls in: “BOOM!”', start: 7, end: 14.4 },
    { name: 'Daisy is thirsty', start: 14.4, end: 17 },
    { name: 'Pip is brave', start: 17, end: 21.9 },
    { name: 'Rain, and Daisy blooms', start: 21.9, end: 27.4 },
    { name: 'The rainbow and the lesson', start: 27.4, end: 34.9 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/kids/raw.mp4',
    poster: '/demo/kids/raw.jpg',
    label: 'cartoon-scenes.mp4 · 0:36',
    seconds: 36,
  },
  transcript: [
    { text: 'Scene 1: Pip floats over the meadow and waves' },
    { text: 'Scene 2: the first moment, before Rumble moves', cut: 0 },
    { text: 'Scene 2: Rumble rolls in, lightning flashes, Pip shakes, Rumble shouts' },
    { text: 'Scene 3: the wide shot it opens on', cut: 0 },
    { text: 'Scene 3: Daisy droops in the dry ground, then Rumble crackles' },
    { text: 'Scene 4: Pip looks down, takes a deep breath and flies off' },
    { text: 'Scene 5: Pip rains on Daisy and she blooms' },
    { text: 'Scene 6: the wide shot it opens on', cut: 0 },
    { text: 'Scene 6: new flowers grow, a rainbow appears and Rumble smiles' },
    { text: 'No voices, sound or music' },
  ],
  turns: [
    {
      prompt:
        'I made these cartoon scenes for my kids’ channel but they have no sound. Can you make it a proper story Short? A narrator, a voice for each character (Pip is the little cloud, Rumble is the grumpy storm cloud, Daisy is the flower), sound effects, some light music, a title at the start and the lesson at the end. Here’s my script.',
      reply:
        'I’ll give the narrator a warm storytelling voice and Pip, Rumble and Daisy voices of their own, time each line to what they do on screen, add a cartoon sound on every action and light music underneath, then open on a “Pip and the Thunder” title and end on the lesson, with big captions kids can read along with.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for a kids’ story' },
        { fn: 'media.import', note: 'your six scenes' },
        { fn: 'render.frames', note: 'found when each thing happens in every scene' },
        { fn: 'create.voiceover', note: 'the narrator, Pip, Rumble and Daisy, one voice each' },
        { fn: 'media.get', note: 'when each word is said' },
        { fn: 'sounds.list', note: 'thunder, swishes, rain, drips, a pop, chimes, a giggle' },
        { fn: 'media.import', note: 'the sounds and the music' },
        { fn: 'create.still', note: 'the title card and the “The End” card' },
        { fn: 'timeline.create', note: 'vertical, 24 fps like the scenes' },
        { fn: 'edit.batch', note: 'scenes in story order, every line timed to the action' },
        { fn: 'clip.freeze', note: 'held the rainbow for the end card' },
        { fn: 'edit.batch', note: 'a sound on every action, the music, the title and end card' },
        { fn: 'render.frames', note: 'moved “BOOM!” to where Rumble opens his mouth' },
        { fn: 'edit.batch', note: 'deeper voice for Rumble, brighter for Pip, the levels' },
        { fn: 'edit.batch', note: 'big captions, a phrase at a time, in each character’s colour' },
        { fn: 'render.frames', note: 'moved the captions to the top, clear of Daisy' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'a copy to check the voices over the music' },
        { fn: 'edit.batch', note: 'music and rain down under the voices, up at the end' },
        { fn: 'qa.check', note: 'loudness, peaks, no black or silent gaps' },
        { fn: 'export.video', note: 'vertical, 0:35' },
        { fn: 'export.timeline', note: 'the captions as a subtitle file' },
      ],
      status: 'Giving everyone a voice…',
      done: 'Your story is ready: “Pip and the Thunder” in 35 seconds, with a narrator, a voice for Pip, Rumble and Daisy, a sound on every action, light music, big captions for early readers and “The End” with the lesson. Want a widescreen version for your long-form channel too?',
      video: {
        src: '/demo/kids/cut.mp4',
        poster: '/demo/kids/cut.jpg',
        label: 'pip-and-the-thunder.mp4 · 0:35',
        seconds: 34.9,
        captions: '/demo/kids/cut.vtt',
      },
    },
  ],
};

// Four shaky phone clips from a small coffee roastery with nobody talking (generated footage, edited
// for real by cuttingfloor): a 15-second "roaster to cup" Reel with a hook, music and an end card.
const BROLL: Demo = {
  id: 'broll',
  slug: 'make-a-small-business-reel-from-phone-clips',
  title: 'Make a small business Reel from a few phone clips',
  description:
    'A small coffee roaster gives ChatGPT four shaky phone clips with nobody talking and a music track. cuttingfloor puts a bold hook on the first frame, cuts the best moments into short shots on the beat, steadies and warms up the footage, keeps the pour and the beans audible under the music and ends on the shop name and a call to action: a 15-second Reel for Instagram.',
  steps: [
    'Looked at all four clips and picked the best moments: the beans pouring out of the roaster, the scoop going into the bag, the stamp, and the coffee pouring into the cup.',
    'Steadied the shaky phone footage, with a slight zoom so no edges show.',
    'Put “ROASTER TO CUP in 15 seconds” on the very first frame, big and easy to read, over the most eye-catching shot.',
    'Found every beat in the music and cut to a new shot every two beats, in the order the coffee is made.',
    'Pushed in slowly on most shots and closer on others, so every cut feels on purpose.',
    'Slowed the last pour down to half speed so it plays smooth and lingers.',
    'Gave every shot the same warm look: warmer colour, more contrast, richer colour and a soft dark edge.',
    'Kept the roaster’s rattle and the beans dropping into the bag under the music, and added a coffee pour and a soft thump where the phone barely caught them.',
    'Ended on Copper Lane Coffee Roasters, “Roasted fresh every Tuesday” and “Order a bag · link in bio” over the pour.',
    'Made it loud for phones with peaks under −1 dB and exported it vertical. The music is an original track made for this demo.',
  ],
  uploaded: '2026-11-26',
  moments: [
    { name: 'Roaster to cup: the beans pour out', start: 0, end: 2.5 },
    { name: 'Into the bag', start: 2.5, end: 5 },
    { name: 'The stamp', start: 5, end: 7.5 },
    { name: 'The pour, in slow motion', start: 7.5, end: 11.9 },
    { name: 'Name and call to action', start: 11.9, end: 15.6 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/broll/raw.mp4',
    poster: '/demo/broll/raw.jpg',
    label: 'shop-broll.mp4 · 0:29',
    seconds: 29.4,
  },
  transcript: [
    { text: 'Clip 1: coffee poured into a white cup' },
    { text: 'Clip 1: waiting for the pour to start', cut: 0 },
    { text: 'Clip 2: the beans pour out of the roaster and the arms stir them' },
    { text: 'Clip 3: beans scooped and poured into a bag on the scale' },
    { text: 'Clip 3: standing by the empty bags', cut: 0 },
    { text: 'Clip 4: a hand stamps the bag' },
    { text: 'Clip 4: folding the top of the bag', cut: 0 },
    { text: 'No one talks: the roaster, the beans and the room' },
  ],
  turns: [
    {
      prompt:
        'We’re a little coffee roaster. Here are a few clips I took on my phone and the song we use. Can you edit them into a 12–18 second vertical Reel for our Instagram, with some text at the start? Shop’s called Copper Lane Coffee Roasters, and we want people to order a bag from the link in our bio.',
      reply:
        'I’ll open on the beans pouring out of the roaster with a bold line on the first frame, cut your best moments into short shots on the beat, steady and warm up the footage, keep the roaster and the pour audible under the music and end on Copper Lane with “Order a bag · link in bio”.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for a Reel from clips' },
        { fn: 'media.import', note: 'your clips and the song' },
        { fn: 'media.analyze', note: 'found every beat in the song' },
        { fn: 'media.analyze', note: 'found where each clip starts' },
        { fn: 'render.frames', note: 'looked at every clip for the best moments' },
        { fn: 'create.stabilized', note: 'steadied the shaky footage' },
        { fn: 'create.still', note: 'the end card: name, offer, link in bio' },
        { fn: 'timeline.create', note: 'vertical, 30 fps' },
        {
          fn: 'edit.batch',
          note: 'eight shots on the beat, the pour in slow motion, the warm look, the song',
        },
        { fn: 'edit.batch', note: 'the hook on the first frame, the end card, slow push-ins' },
        { fn: 'render.frames', note: 'made the hook bigger so it reads in a second' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'a quick copy to check the sound' },
        { fn: 'sounds.list', note: 'a coffee pour and a soft thump' },
        { fn: 'edit.batch', note: 'the pour and the stamp under the music, levels' },
        { fn: 'media.analyze', note: 'checked the pour and the roaster can be heard' },
        { fn: 'qa.check', note: 'loudness, peaks, no black frames' },
        { fn: 'export.video', note: 'vertical, 0:15' },
      ],
      status: 'Cutting your clips to the beat…',
      done: 'Your 15-second Reel is ready: “ROASTER TO CUP in 15 seconds” on the first frame, the beans, the bag, the stamp and the pour cut on the beat, steadied and warm, the roaster and the pour still there under the music, and Copper Lane with “Order a bag · link in bio” at the end. Want a version that opens on the pour instead, to test which hook does better?',
      video: {
        src: '/demo/broll/cut.mp4',
        poster: '/demo/broll/cut.jpg',
        label: 'copper-lane-roaster-to-cup.mp4 · 0:15',
        seconds: 15.7,
      },
    },
  ],
};

// A happy client of a kitchen renovation company talking in Spanish, plus four before and after
// photos (generated footage and photos, edited for real by cuttingfloor): a testimonial Reel with
// slider reveals and Spanish subtitles.
const TESTIMONIAL: Demo = {
  id: 'testimonial',
  slug: 'make-a-before-and-after-client-testimonial-reel',
  title: 'Turn a client testimonial into a before-and-after Reel with Spanish subtitles',
  description:
    'A kitchen renovation company gives Claude a 36-second phone video of a happy client talking in Spanish, four before and after photos of her kitchen and a music track. cuttingfloor opens on the finished kitchen, cuts her restart, the long pause and the line she said twice, reveals each before and after with a slider over her voice, adds bold word-by-word Spanish subtitles and ends on the company name and a call to action: a 23-second Reel.',
  steps: [
    'Wrote down every word she says with its time, and fixed the company name where it was heard wrong (Seiba to Ceiba).',
    'Opened on the finished kitchen with her best line, “Ahora la cocina es mi lugar favorito de la casa”, and a headline: “Su cocina, lista en solo 2 semanas”.',
    'Cut her false start and restart, the long pause while she looks around, and “En solo dos semanas” said twice.',
    'Put the before photos over her voice while she describes the old kitchen, with a slow push-in and an “ANTES” tag.',
    'Revealed each before and after with a white slider sweeping across the photo, a soft swoosh under it and the tag turning to “DESPUÉS”.',
    'Added bold Spanish subtitles, three or four words at a time, with the word she is saying and the key words in yellow.',
    'Pushed in a little closer on every other shot of her so the cuts feel on purpose, and put her name on screen the first time we see her.',
    'Ended on the company name, “Pide tu presupuesto gratis” and the WhatsApp number, with the music coming up.',
    'Put the music bed low under her voice and made her voice loud and even for phones, with peaks under −1 dB. The music is an original track made for this demo.',
  ],
  uploaded: '2026-11-26',
  skill: 'cut-pauses-ums-and-restarts',
  moments: [
    { name: 'The finished kitchen', start: 0, end: 2.7 },
    { name: 'Before: “mi cocina era un desastre”', start: 2.7, end: 10.5 },
    { name: 'The before and after reveals', start: 10.5, end: 16.6 },
    { name: '“Si están pensando en remodelar, llámenlos”', start: 16.6, end: 20.3 },
    { name: 'Name and call to action', start: 20.3, end: 22.8 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/testimonial/raw.mp4',
    poster: '/demo/testimonial/raw.jpg',
    label: 'client-testimonial.mp4 · 0:44',
    seconds: 44.1,
    captions: '/demo/testimonial/raw.vtt',
  },
  transcript: [
    { text: 'Hola, soy Rosa.', cut: 0 },
    { text: 'Hace tres meses mi cocina estaba…', cut: 0 },
    { text: 'Ay, no, perdón. Empiezo otra vez.', cut: 0 },
    { text: 'Hace tres meses mi cocina era un desastre.' },
    { text: 'Los gabinetes rotos, la luz horrible… yo no quería ni cocinar.' },
    { text: '[a long pause while she looks around]', cut: 0 },
    { text: 'Y el equipo de Ceiba la dejó como nueva en solo dos semanas.' },
    { text: 'En solo dos semanas.', cut: 0 },
    { text: 'Limpios, puntuales, todo perfecto.' },
    { text: 'Ahora la cocina es mi lugar favorito de la casa.' },
    { text: 'Si están pensando en remodelar, llámenlos. De verdad.' },
  ],
  turns: [
    {
      prompt:
        'This is my client Rosa talking about the kitchen we redid, plus the before and after photos and the song we use. Make me a Reel for Instagram: a hook at the start, take out where she starts over, repeats herself and stops, put the before and after photos over her voice, subtitles in Spanish, and end with our name, Remodelaciones Ceiba, and a call to action.',
      reply:
        'I’ll open on the finished kitchen with her best line, cut the restart, the pause and the repeat, show each before and after with a slider over her voice, add bold Spanish subtitles and finish on Remodelaciones Ceiba with a free quote offer.',
      calls: [
        { fn: 'skills.search', note: 'checked for a method for cutting restarts and pauses' },
        { fn: 'skills.get', note: 'read it' },
        { fn: 'media.import', note: 'her video, the four photos and the song' },
        { fn: 'media.analyze', note: 'every word in Spanish, timed' },
        { fn: 'media.analyze', note: 'where she speaks and where she stops' },
        { fn: 'sounds.list', note: 'a soft swoosh for the reveals' },
        { fn: 'create.still', note: 'the slider line with its handle' },
        { fn: 'create.still', note: 'the end card: name, offer, WhatsApp' },
        { fn: 'timeline.create', note: 'vertical, 24 fps' },
        {
          fn: 'edit.batch',
          note: 'the kept lines, photos over her voice, slider reveals, tags, Spanish subtitles, music',
        },
        { fn: 'render.frames', note: 'looked at every part' },
        { fn: 'edit.batch', note: 'lined the reveal up with the slider, split the tags' },
        { fn: 'qa.check', note: 'loudness, peaks and every cut' },
        { fn: 'edit.batch', note: 'her voice louder and even' },
        { fn: 'audio.set_master', note: 'loud for phones, peaks under −1 dB' },
        { fn: 'audio.set_gain', note: 'music low under her voice, up on the end card' },
        { fn: 'edit.batch', note: 'the headline on screen from the very first frame' },
        { fn: 'export.video', note: 'vertical, 0:23' },
        { fn: 'export.timeline', note: 'the subtitles as a VTT file' },
      ],
      status: 'Lining up the before and after photos…',
      done: 'Your 23-second Reel is ready: it opens on the finished kitchen, her restart, the long pause and the repeated line are gone, each before and after slides open over her voice, the Spanish subtitles follow every word, and it ends on Remodelaciones Ceiba with “Pide tu presupuesto gratis”. I also saved the subtitles as a file. Want a version with the subtitles in English too?',
      video: {
        src: '/demo/testimonial/cut.mp4',
        poster: '/demo/testimonial/cut.jpg',
        label: 'testimonio-cocina-ceiba.mp4 · 0:23',
        seconds: 22.8,
        captions: '/demo/testimonial/cut.vtt',
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
        { fn: 'export.video', note: 'vertical, 0:27' },
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

// Five product shots of a made-up soda and its logo (generated footage, edited for real by
// cuttingfloor): a 15-second ad with a jingle made for it, whose last note lands as the logo appears.
const JINGLE: Demo = {
  id: 'jingle',
  slug: 'make-a-jingle-for-a-product-ad',
  title: 'Make a 15-second product ad with a jingle that ends on your logo',
  description:
    'A soda maker gives Claude five product shots and a logo. cuttingfloor cuts them into a 15-second ad and makes the jingle for it from instruments and notes: a bouncy tune on marimba with piano chords, bass and drums, whose last note lands on the exact frame the logo appears. The cap’s hiss and the clink of the glasses stay in.',
  steps: [
    'Looked at the five shots and found the two sounds to keep: the hiss when the cap comes off and the clink of the glasses.',
    'Cut the shots down to 15 seconds: the bottle, the cap, the pour, the clink and the laugh, then the bottle beside the full glass.',
    'Made a clean cream end card for the logo, because the logo over the bottle put two logos on screen.',
    'Wrote a bright eight-bar tune and set its speed so the last note falls on the frame the logo appears, 12.5 seconds in.',
    'Built it in layers: the tune on marimba with a plucked sound on top, electric piano chords, bass and a drum kit, with a cymbal crash on the last note.',
    'Played the tune back note by note to check it, and swapped a bell sound whose notes could not be read back cleanly for a plucked one.',
    'Left a gap in the music for the clink and turned the music down under the cap’s hiss, so you hear both.',
    'Checked the frames either side of the logo and the sound at that moment: the last note and the logo arrive together.',
    'Made it loud enough for a feed, with peaks under −1 dB, and exported it. The jingle was made for this ad: no singer, no lyrics, and every part of it can still be changed.',
  ],
  uploaded: '2026-11-27',
  guide: 'make-a-jingle-for-a-video',
  moments: [
    { name: 'The bottle', start: 0, end: 1 },
    { name: 'The cap comes off', start: 1, end: 3.9 },
    { name: 'The pour', start: 3.9, end: 7.6 },
    { name: 'The clink and the laugh', start: 7.6, end: 11.4 },
    { name: 'Bottle and glass', start: 11.4, end: 12.5 },
    { name: 'The last note and the logo', start: 12.5, end: 15 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/jingle/raw.mp4',
    poster: '/demo/jingle/raw.jpg',
    label: 'product-shots.mp4 · 0:19',
    seconds: 19.4,
    wide: true,
    sound: true,
  },
  transcript: [
    { text: 'Shot 1: the cold bottle on a sunny kitchen table' },
    { text: 'Shot 1: the slow push in before anything happens', cut: 0 },
    { text: 'Shot 2: a hand twists the cap off, with a hiss' },
    { text: 'Shot 3: the soda pours over ice' },
    { text: 'Shot 4: two friends clink glasses and laugh' },
    { text: 'Shot 5: the bottle beside the full glass' },
    { text: 'Shot 5: the last three seconds, replaced by the logo', cut: 0 },
    { text: 'Room sound only: no music yet' },
  ],
  turns: [
    {
      prompt:
        'I make a soda called Merrow Fizz. Here are my product shots and my logo. Make me a 15-second ad with a jingle: bright, bouncy, something you’d hum after, and the last note has to land exactly when the logo comes on at the end. Keep the fizz and the clink in there.',
      reply:
        'I’ll find the cap’s fizz and the clink in your footage, cut the five shots down to 15 seconds around them, and write a jingle whose last note falls on the frame your logo appears. The music will dip so the fizz and the clink come through.',
      calls: [
        { fn: 'media.import', note: 'the product shots and the logo' },
        { fn: 'media.analyze', note: 'found the five shots' },
        { fn: 'media.listen', note: 'found the clink, the pour and the laugh' },
        { fn: 'media.analyze', note: 'found the cap’s hiss by its sudden rise' },
        { fn: 'render.frames', note: 'looked at every shot' },
        { fn: 'timeline.create', note: 'wide, 24 fps' },
        { fn: 'edit.batch', note: 'five shots cut to 15 seconds, the logo at 12.5' },
        { fn: 'render.frames', note: 'two logos on screen, so a clean end card instead' },
        { fn: 'create.matte', note: 'a cream end card' },
        { fn: 'score.create', note: 'a speed that puts bar 8 on the logo’s frame' },
        { fn: 'score.batch', note: 'the tune, chords, bass and drums, with a rest for the clink' },
        { fn: 'score.render', note: 'the jingle, and the tune alone' },
        { fn: 'media.analyze', note: 'read the notes back: the bells would not read cleanly' },
        { fn: 'score.batch', note: 'bells out, a plucked sound in' },
        { fn: 'score.render', note: 'every note reads back as written' },
        { fn: 'edit.batch', note: 'the jingle in, quieter under the hiss and the clink' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'audio.set_master', note: 'louder, peaks under −1 dB' },
        { fn: 'export.video', note: 'wide, 0:15' },
        { fn: 'media.analyze', note: 'the last note and the logo, on the finished file' },
      ],
      status: 'Writing a jingle that ends on your logo…',
      done: 'Your 15-second Merrow Fizz ad is ready. It opens on the bottle and the cap’s hiss, then the pour, the clink and the laugh, and ends on your logo on a clean cream card. The jingle is a bouncy tune on marimba, and its last note lands on the frame your logo appears, 12.5 seconds in. Want the tune on a different instrument, or a 6-second version?',
      video: {
        src: '/demo/jingle/cut.mp4',
        poster: '/demo/jingle/cut.jpg',
        label: 'merrow-fizz-ad.mp4 · 0:15',
        seconds: 15,
        wide: true,
      },
    },
  ],
};

// Fourteen clips of a made-up rec league basketball game with a commentator (generated footage,
// edited for real by cuttingfloor): a 30-second highlight reel cut to music made for it, then the
// names and flashes added, then the same music made darker.
const HOOPS: Demo = {
  id: 'hoops',
  slug: 'make-a-basketball-highlight-reel-with-music',
  title: 'Make a highlight reel with music made for it, cut on the beat',
  description:
    'A player gives Claude 75 seconds of clips from a rec league game, with the commentator talking over them, and no song. cuttingfloor makes the music from instruments and notes: a hard track that builds, drops out for one beat and hits hardest as the winning three drops through the rim in slow motion. Every cut is on a beat, his best calls come through, and when the player asks for it darker with more bass, the same music is changed, not replaced.',
  steps: [
    'Found every basket and every one of the commentator’s calls in the clips, down to the frame the ball goes through the net.',
    'Made a hard track at 144 beats a minute, so one beat is exactly ten frames and every cut can sit on a beat.',
    'Built it in layers: two drum machines, a synth bass, brass stabs and a synth lead. It builds, drops out for one beat, then hits hardest on beat 52.',
    'Cut every play on a beat: 15 cuts, none of them off the beat by even a frame.',
    'Slowed the winning three down so the ball drops through the rim on the frame the biggest hit lands, 21.6 seconds in.',
    'Put a graphic and a sound on each basket: a boom, an explosion, a cash register and an airhorn for the winner.',
    'Turned the music down under each of his calls, then checked the finished file: every call still reads.',
    'Ended on “EMBERS WIN” over the celebration.',
    'Added each scorer’s name to his graphic, and one-beat flashes of the crowd, the bench and two players’ faces between the plays, without touching the sound.',
    'Made the same music darker: the lead an octave lower and duller, a darker note in the riff, more weight in the bass and the low drum, and a new low layer under the bass line. On the finished file the bass is about 6 dB stronger and the brightness about 5 dB lower, and the picture is the same frame for frame.',
    'Kept it loud with peaks under −1 dB and exported it. The music was made for this reel: no singer, no lyrics, and every part of it can still be changed.',
  ],
  uploaded: '2026-11-27',
  guide: 'make-background-music-for-a-video',
  moments: [
    { name: 'Tip-off', start: 0, end: 1.7 },
    { name: 'Okafor’s corner three', start: 1.7, end: 4.6 },
    { name: 'Adeyemi’s steal and slam', start: 4.6, end: 8.75 },
    { name: 'Baptiste’s block', start: 8.75, end: 11.25 },
    { name: 'The bench and the crowd', start: 11.25, end: 14.6 },
    { name: 'Reyes steps back', start: 14.6, end: 17.5 },
    { name: 'The game winner, in slow motion', start: 17.5, end: 23.75 },
    { name: 'Embers win', start: 23.75, end: 30 },
  ],
  agent: 'Claude',
  raw: {
    src: '/demo/hoops/raw.mp4',
    poster: '/demo/hoops/raw.jpg',
    label: 'game-clips.mp4 · 1:15',
    seconds: 74.6,
    captions: '/demo/hoops/raw.vtt',
    wide: true,
    sound: true,
  },
  transcript: [
    { text: 'Good evening, everybody, and welcome to the rec centre!', cut: 0 },
    {
      text: 'Kilnworth Embers in orange, Fernwick Frost in white. Decent crowd in tonight.',
      cut: 0,
    },
    { text: 'Ball’s up, and we’re under way.' },
    { text: 'Okafor, in the corner... Bang! Three!' },
    { text: 'Adeyemi picks his pocket! All the way... oh, he throws it down!' },
    { text: 'Frost come right back. Easy two at the other end.', cut: 0 },
    { text: 'Baptiste says no! Get that out of here!' },
    { text: 'The Embers bench enjoying that one.' },
    { text: 'Listen to this place!' },
    { text: 'And a reminder, the snack bar is open at the break.', cut: 0 },
    { text: 'Reyes, step back... got it!' },
    { text: 'Okafor, from deep, for the win... Bang! Embers win it! Unbelievable!' },
    { text: 'They’re all over him!' },
    { text: 'Long night for both sides. Legs getting heavy now.', cut: 0 },
  ],
  turns: [
    {
      prompt:
        'These are my clips from our rec league game last night, with our commentator talking over them. Make me a 30-second highlight reel. I don’t have a song, so make the music for it: something hard that builds, with the cuts on the beat and the biggest hit when the winning three goes in. Let his best calls come through the music. Put a graphic and a sound on each basket, slow the winner down, and end on EMBERS WIN.',
      reply:
        'I’ll find each basket and his calls in your footage, write a hard track whose beats line up with the frames, then cut every play on a beat so the biggest hit lands as the winning three drops through the net.',
      calls: [
        { fn: 'media.import', note: 'your clips' },
        { fn: 'media.analyze', note: 'his words with times, and the 14 shots' },
        { fn: 'media.seek', note: 'found the ball going in on each basket' },
        { fn: 'render.frames', note: 'pinned the frame the winner drops through the net' },
        { fn: 'score.create', note: '144 beats a minute: one beat is ten frames' },
        { fn: 'score.batch', note: 'two drum machines, bass, brass stabs and a lead' },
        { fn: 'score.batch', note: 'the notes: a build, one beat of silence, the big hit' },
        { fn: 'score.render', note: 'the music' },
        { fn: 'sounds.list', note: 'a boom, an explosion, a cash register, an airhorn' },
        { fn: 'timeline.create', note: 'wide, 24 fps' },
        { fn: 'edit.batch', note: '11 clips, every cut on a beat, the winner slowed' },
        { fn: 'create.motion', note: 'a graphic for each basket, and EMBERS WIN' },
        {
          fn: 'edit.batch',
          note: 'graphics and sounds on the baskets, music down under his calls',
        },
        { fn: 'render.frames', note: 'moved a graphic off a player’s head' },
        { fn: 'media.analyze', note: 'his calls hid the big hit, so the levels were set again' },
        { fn: 'clip.set_speed', note: 'the ball drops through the rim on the hit' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'wide, 0:30' },
        { fn: 'media.analyze', note: 'the biggest hit and the ball, on the finished file' },
      ],
      status: 'Making the music and cutting on the beat…',
      done: 'Here is your 30-second reel. The music is a hard track made for it at 144 beats a minute: it builds, drops out for one beat and hits hardest as the winning three drops through the rim in slow motion. Every cut is on a beat, each basket has a graphic and a sound, the music dips under his calls, and it ends on EMBERS WIN.',
      video: {
        src: '/demo/hoops/cut1.mp4',
        poster: '/demo/hoops/cut1.jpg',
        label: 'embers-reel.mp4 · 0:30',
        seconds: 30,
        captions: '/demo/hoops/cut.vtt',
        wide: true,
      },
    },
    {
      prompt:
        'Love it. Put each scorer’s name on his graphic: Okafor, Adeyemi and Reyes, spelled like that. And flash the crowd, the bench and the players’ faces in between the plays.',
      reply:
        'I’ll remake the graphics with the names, then slip one-beat flashes of the crowd, the bench and two faces between the plays, picture only, so the music, his calls and the beats stay where they are.',
      calls: [
        { fn: 'render.frames', note: 'picked the crowd, bench and face moments' },
        { fn: 'create.motion', note: 'four graphics with the names' },
        { fn: 'edit.batch', note: 'new graphics in, five one-beat flashes' },
        { fn: 'render.frames', note: 'moved a flash that sat under a graphic' },
        { fn: 'timeline.diff', note: 'only the picture changed' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'wide, 0:30' },
      ],
      status: 'Adding the names and the flashes…',
      done: 'Each graphic now carries the scorer’s name, spelled Okafor, Adeyemi and Reyes. The reel flashes the crowd, the bench and two players’ faces for one beat each between the plays, and the sound is exactly as it was.',
      video: {
        src: '/demo/hoops/cut2.mp4',
        poster: '/demo/hoops/cut2.jpg',
        label: 'embers-reel-names.mp4 · 0:30',
        seconds: 30,
        captions: '/demo/hoops/cut.vtt',
        wide: true,
      },
    },
    {
      prompt: 'Make the music darker, with more bass. Keep everything else.',
      reply:
        'I’ll change the same music: a lower, duller lead and stabs, a darker note in the riff, more weight on the bass and the low drum, and a low layer under the bass line. Then I’ll swap only the music in the edit.',
      calls: [
        { fn: 'score.batch', note: 'the lead down an octave, a darker note, heavier bass' },
        { fn: 'score.diff', note: 'what changed in the music' },
        { fn: 'score.render', note: 'too much low end, so the new layer came down' },
        { fn: 'score.batch', note: 'the low layer quieter and an octave up' },
        { fn: 'score.render', note: 'the darker music' },
        { fn: 'media.analyze', note: 'read the riff back: the darker note is there' },
        { fn: 'edit.batch', note: 'only the music swapped' },
        { fn: 'qa.check', note: 'loudness, peaks, every call still heard' },
        { fn: 'export.video', note: 'wide, 0:30' },
        { fn: 'media.analyze', note: 'bass and brightness against the last version' },
      ],
      status: 'Making the music darker…',
      done: 'It’s the same track, darker and heavier. On the finished file the bass is about 6 dB stronger and the brightness about 5 dB lower, the riff turns on a darker note, and the big hit still lands on the winning shot. The picture is the same as the last version, frame for frame. Want the build longer, or the airhorn gone?',
      video: {
        src: '/demo/hoops/cut.mp4',
        poster: '/demo/hoops/cut.jpg',
        label: 'embers-reel-dark.mp4 · 0:30',
        seconds: 30,
        captions: '/demo/hoops/cut.vtt',
        wide: true,
      },
    },
  ],
};

// One take of a man talking to his phone, voice only (generated footage, edited for real by
// cuttingfloor): background music made for it and set under the voice, with captions.
const TALK: Demo = {
  id: 'talk',
  slug: 'add-background-music-to-a-talking-video',
  title: 'Add background music to a talking video, with every word still clear',
  description:
    'A creator gives ChatGPT one take of himself talking, with no music. cuttingfloor makes the music for it from instruments and notes: a warm electric piano, a soft pad and bass, kept well under his voice, a little louder in his pauses, and ending on a held chord as he says his last words. Word-by-word captions sit below his face.',
  steps: [
    'Got every word and when it is said, and found where his face is in the frame.',
    'Wrote a short, warm piece at a speed that puts its last chord on his last sentence, 20 seconds in.',
    'Built it in layers: electric piano chords with a gentle rising figure, a soft pad and an upright bass.',
    'Set the music about 13 dB under his voice, and a little louder in the gaps between his sentences.',
    'Checked that every word survives: the finished video’s words match the original’s one for one. An earlier, louder try blurred one word, so the music came down a touch under the speech.',
    'Let the last chord ring out as he finishes, so the music ends with him instead of being chopped off.',
    'Added captions that light up word by word, in short lines below his face.',
    'Made it loud enough for a feed, with peaks under −1 dB, and exported it vertical. The music was made for this video: no singer, no lyrics, and every part of it can still be changed.',
  ],
  uploaded: '2026-11-27',
  guide: 'make-background-music-for-a-video',
  fix: 'add-music',
  moments: [
    { name: 'The free upgrade', start: 0, end: 4.2 },
    { name: 'Face a window', start: 4.2, end: 9.6 },
    { name: 'Turn around and step back', start: 9.6, end: 15.7 },
    { name: 'The best time of day', start: 15.7, end: 18.7 },
    { name: 'The last chord', start: 18.7, end: 22.3 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/talk/raw.mp4',
    poster: '/demo/talk/raw.jpg',
    label: 'window-tip.mp4 · 0:22',
    seconds: 22.3,
    captions: '/demo/talk/raw.vtt',
    sound: true,
  },
  transcript: [
    { text: 'Here’s the easiest upgrade for your videos, and it costs nothing.' },
    { text: 'Face a window.' },
    { text: 'Don’t put the window behind you, because that turns you into a shadow.' },
    { text: 'Turn around so the daylight lands on your face,' },
    { text: 'then take one step back so it’s nice and soft.' },
    { text: 'Morning or late afternoon light works best.' },
    { text: 'Try it on your next video, and you’ll see the difference straight away.' },
  ],
  turns: [
    {
      prompt:
        'Here’s my video. It’s just me talking. Can you put some background music under it? Something warm and easy that doesn’t get in the way, I still need every word to be clear. Add captions too.',
      reply:
        'I’ll write a short, warm piece for it: electric piano, a soft pad and bass, set under your voice so every word stays on top, ending on a held chord as you finish. Then I’ll add word-by-word captions below your face.',
      calls: [
        { fn: 'media.import', note: 'your video' },
        { fn: 'media.analyze', note: 'every word and when it is said' },
        { fn: 'media.analyze', note: 'where your face is, to keep captions off it' },
        { fn: 'score.create', note: 'a speed that puts the last chord at 0:20' },
        { fn: 'score.batch', note: 'electric piano, a soft pad and bass' },
        { fn: 'score.render', note: 'the music' },
        { fn: 'render.spectrogram', note: 'checked the chords and the ending' },
        { fn: 'timeline.create', note: 'vertical, 25 fps' },
        { fn: 'edit.batch', note: 'your video, the music under it, captions' },
        { fn: 'render.frames', note: 'captions in time, below your face' },
        { fn: 'score.batch', note: 'a brighter piano with a gentle rising figure' },
        { fn: 'audio.set_gain', note: 'music under your voice, a little up in the pauses' },
        { fn: 'media.analyze', note: 'every word still there, one for one' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'vertical, 0:22' },
      ],
      status: 'Making music to sit under your voice…',
      done: 'Your video now has a warm electric piano under it, with a soft pad and bass, about 13 dB below your voice. It lifts a little in your pauses and ends on a held chord as you say your last words. Captions light up word by word below your face, and every word comes through. Want the music a bit brighter, or without the bass?',
      video: {
        src: '/demo/talk/cut.mp4',
        poster: '/demo/talk/cut.jpg',
        label: 'window-tip-music.mp4 · 0:22',
        seconds: 22.3,
        captions: '/demo/talk/cut.vtt',
      },
    },
  ],
};

// Seven travel clips with no sound at all (generated footage, edited for real by cuttingfloor):
// piano and strings made for it that swell as she reaches the top at sunrise, and one grade.
const TRIP: Demo = {
  id: 'trip',
  slug: 'make-music-for-a-travel-video',
  title: 'Make music for a silent travel video that swells on the best shot',
  description:
    'A traveller gives ChatGPT seven clips from a sunrise walk up to a viewpoint, with no sound on them. cuttingfloor makes the music from instruments and notes: a quiet piano, strings that come in on the stairs, a swell as she reaches the top and the sun comes up, and one last chord on the harbour. Every clip gets the same warmer look.',
  steps: [
    'Found the cuts between the seven clips, and the moment she reaches the top with the sun over the sea, 26 seconds in.',
    'Set the music’s speed so a new bar starts on the first three cuts.',
    'Started with a quiet piano alone over the harbour and the alley.',
    'Brought the low strings in on the cut to the stairs, and the violins on the cut to the view over the coast.',
    'Built the strings up so the biggest chord lands as she walks out to the edge: the loudest two seconds of the music start the moment she stands at the top.',
    'Eased it back down over the close-up, and ended on one last piano chord that fades out before the last frame.',
    'Gave every clip the same look: a little more contrast, richer colour and warmer light, with the bright sky kept.',
    'Checked the loudness second by second against the picture, kept peaks under −1 dB, and exported it. The music was made for this video: no singer, no lyrics, and every part of it can still be changed.',
  ],
  uploaded: '2026-11-27',
  guide: 'make-background-music-for-a-video',
  moments: [
    { name: 'Harbour at dawn, piano alone', start: 0, end: 6 },
    { name: 'The old town', start: 6, end: 12 },
    { name: 'The stairs, strings come in', start: 12, end: 18 },
    { name: 'The view over the coast', start: 18, end: 23.5 },
    { name: 'The top at sunrise, the swell', start: 23.5, end: 30.2 },
    { name: 'Looking out', start: 30.2, end: 36.7 },
    { name: 'The harbour in the sun', start: 36.7, end: 42.7 },
  ],
  agent: 'ChatGPT',
  raw: {
    src: '/demo/trip/raw.mp4',
    poster: '/demo/trip/raw.jpg',
    label: 'trip-clips.mp4 · 0:43',
    seconds: 42.7,
    wide: true,
  },
  transcript: [
    { text: 'Clip 1: the harbour before sunrise' },
    { text: 'Clip 2: walking through the old town as a shop opens' },
    { text: 'Clip 3: up the stairs above the rooftops' },
    { text: 'Clip 4: the view over the coast' },
    { text: 'Clip 5: she reaches the top as the sun comes up' },
    { text: 'Clip 6: close up, looking out to sea' },
    { text: 'Clip 7: the harbour in the morning sun' },
    { text: 'No sound on any clip' },
  ],
  turns: [
    {
      prompt:
        'These are clips from my trip, there’s no sound on them. Can you make music for it? Quiet piano to start, strings coming in, and it should swell when she gets to the top and the sun comes up, then settle for the last shot. Make the picture look nicer too. I want one finished video.',
      reply:
        'I’ll find the moment she reaches the top and the sun comes up, write a piano and strings piece that peaks right there, and give every clip the same warmer look. I’ll keep your edit as it is, since no shot drags.',
      calls: [
        { fn: 'media.import', note: 'your clips' },
        { fn: 'media.analyze', note: 'found the six cuts' },
        { fn: 'render.frames', note: 'looked at every clip' },
        { fn: 'media.seek', note: 'found when she reaches the top and the sun is up' },
        { fn: 'score.create', note: 'a speed that puts bars on the cuts' },
        { fn: 'score.batch', note: 'piano, low strings and violins, with the swell at the top' },
        { fn: 'score.render', note: 'the music' },
        { fn: 'timeline.create', note: 'wide, 24 fps' },
        { fn: 'edit.batch', note: 'your clips with more contrast, colour and warmth' },
        { fn: 'render.frames', note: 'compared the new look with the clips' },
        { fn: 'media.analyze', note: 'the music’s loudness, second by second' },
        { fn: 'edit.batch', note: 'the music in, and louder overall' },
        { fn: 'score.render', note: 'each layer alone, to check when it comes in' },
        { fn: 'qa.check', note: 'no gaps, loudness and peaks' },
        { fn: 'export.video', note: 'wide, 0:43' },
        { fn: 'media.analyze', note: 'the swell against the picture, on the finished file' },
      ],
      status: 'Writing piano and strings for your trip…',
      done: 'Here’s your finished video. A quiet piano plays over the harbour and the alley, strings come in on the stairs, and it all swells as she reaches the top and the sun breaks over the sea, then settles into one last piano chord on the harbour. Every clip has the same warmer look. Want the swell bigger, or a flute on the tune instead of the violins?',
      video: {
        src: '/demo/trip/cut.mp4',
        poster: '/demo/trip/cut.jpg',
        label: 'sunrise-walk.mp4 · 0:43',
        seconds: 42.7,
        wide: true,
      },
    },
  ],
};

// Eight seconds of a hummed tune (a generated recording, edited for real by cuttingfloor): the
// same twelve notes played on instruments as a 10-second podcast intro, on an animated card.
const HUM: Demo = {
  id: 'hum',
  slug: 'turn-a-hummed-tune-into-a-podcast-intro',
  title: 'Turn a tune you hummed into a podcast intro theme',
  description:
    'A podcaster hums eight seconds of a tune and sends the recording to Kazi. cuttingfloor reads the twelve notes of the hum and plays the same tune on a marimba, with electric piano chords, an upright bass and light drums: a 10-second intro theme on an animated card with the show’s name, vertical for Shorts.',
  steps: [
    'Read the notes of the hum: twelve notes, their pitch and when each one starts.',
    'Worked out the key and the speed from the hum itself, so the theme sits where it was hummed.',
    'Wrote the same twelve notes for a marimba, in the same order, tidied onto the beat and tuned (the hum was a little flat in places).',
    'Added layers under the tune: warm electric piano chords, an upright bass and light drums that come in one at a time.',
    'Played the tune back alone and read its notes again: the same twelve, each where it was written.',
    'Turned the tune up and the chords down after the first try buried it.',
    'Ended on one last hit that rings out, so it finishes like a theme instead of stopping.',
    'Made an animated card: a paper kettle that bounces and puffs steam on the beat, the show’s name popping in as the bass arrives, and the lid popping on the last hit.',
    'Made it loud enough for a feed, with peaks under −1 dB, and exported it vertical. The theme is the podcaster’s own tune: no singer, no lyrics, and every part of it can still be changed.',
  ],
  uploaded: '2026-11-27',
  guide: 'turn-a-hummed-melody-into-music',
  moments: [
    { name: 'The chords start', start: 0, end: 1.3 },
    { name: 'The hummed tune comes in', start: 1.3, end: 2.9 },
    { name: 'The name, the bass and the drums', start: 2.9, end: 5.9 },
    { name: 'The tune comes home', start: 5.9, end: 8.8 },
    { name: 'The last hit', start: 8.8, end: 10 },
  ],
  agent: 'Kazi',
  raw: {
    src: '/demo/hum/raw.mp4',
    poster: '/demo/hum/raw.jpg',
    label: 'my-tune.wav · 0:08',
    seconds: 8.5,
    sound: true,
  },
  transcript: [
    { text: 'Two notes to lead in' },
    { text: 'Four notes climbing up' },
    { text: 'Four notes coming back down' },
    { text: 'Two notes to come home, the last one held' },
    { text: 'Just a voice humming: no words, no instrument' },
  ],
  turns: [
    {
      prompt:
        'I hummed a tune for my podcast intro. The show is called Paper Kettle. Turn my tune into a proper 10-second intro theme, warm and a bit playful, and put it on an intro card with the show’s name. Make it vertical so I can post it as a Short too.',
      reply:
        'I’ll read the notes of your hum first, so the theme plays your exact tune. Then I’ll put it on real instruments with chords, bass and a little rhythm under it, and make a vertical card where Paper Kettle bounces along to the beat.',
      calls: [
        { fn: 'media.import', note: 'your hum' },
        { fn: 'media.analyze', note: 'read the twelve notes you hummed' },
        { fn: 'media.analyze', note: 'the key and the speed of your hum' },
        { fn: 'render.spectrogram', note: 'looked at the hum against the notes read' },
        { fn: 'score.create', note: 'your speed, 82 beats a minute' },
        { fn: 'score.batch', note: 'your tune on marimba, with chords, bass and drums' },
        { fn: 'score.render', note: 'the theme, and the tune alone' },
        { fn: 'media.analyze', note: 'read the tune back: the same twelve notes' },
        { fn: 'score.batch', note: 'the tune louder, the chords quieter' },
        { fn: 'score.render', note: 'the theme again' },
        { fn: 'create.motion', note: 'an animated card that moves on the beat' },
        { fn: 'render.frames', note: 'a bigger kettle, the name clear of the confetti' },
        { fn: 'timeline.create', note: 'vertical, 30 fps' },
        { fn: 'edit.batch', note: 'the card and the theme together' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'vertical, 0:10' },
      ],
      status: 'Turning your hum into a theme…',
      done: 'Here’s your Paper Kettle intro. It’s your hummed tune, note for note, at your own speed: a marimba plays it over warm electric piano chords, with an upright bass and light drums. It ends on one last hit that rings out while the kettle pops its lid. Want the tune on a guitar or a flute instead?',
      video: {
        src: '/demo/hum/cut.mp4',
        poster: '/demo/hum/cut.jpg',
        label: 'paper-kettle-intro.mp4 · 0:10',
        seconds: 10,
      },
    },
  ],
};

// Phone clips of a dog in a park, with a few barks (generated footage, edited for real by
// cuttingfloor): his own bark played as a drum in a beat made for the video, cuts on the beat.
const BARK: Demo = {
  id: 'bark',
  slug: 'make-a-beat-from-your-dogs-bark',
  title: 'Make a beat out of your dog’s bark and cut his video to it',
  description:
    'A dog owner gives Kazi 24 seconds of phone clips of Biscuit in the park. cuttingfloor finds his four barks, takes the cleanest one and plays it as a drum in a beat made for the video, with a kick, hi-hats, bass and a short tune. Every cut lands on the beat, and he barks on screen as his bark drum hits: a 15-second Short.',
  steps: [
    'Found the four barks in the clips and measured each one: how loud it is, how quiet it is just before, and how fast it dies away.',
    'Took the cleanest bark, a quarter of a second long, and loaded it as a drum.',
    'Made a beat at 120 beats a minute in layers: a kick and hi-hats, a bass line and a short tune, with the bark where the snare would be, on every second and fourth beat.',
    'Rendered the bark alone and the rest alone to check the bark stands out: 12 dB above everything else through the middle of the beat.',
    'Evened the bark out between the left and right speakers, because the phone recorded it louder on one side.',
    'Picked his best moments: the barks, the run at the camera, the catch, the trot with the ball and the head tilt.',
    'Put every cut on a beat, and lined up four of his barks on screen with the bark drum.',
    'Added his name at the start and “GOOD BOY!” on the last hit, with a punch-in.',
    'Made it loud enough for a feed, with peaks under −1 dB, and exported it vertical. The beat was made for this video from his own bark: every part of it can still be changed.',
  ],
  uploaded: '2026-11-27',
  guide: 'make-a-beat-for-a-montage',
  moments: [
    { name: 'Bark, bark, and his name', start: 0, end: 3 },
    { name: 'The run at the camera', start: 3, end: 5.5 },
    { name: 'The catch', start: 5.5, end: 7.5 },
    { name: 'Off with the ball', start: 7.5, end: 10.5 },
    { name: 'The head tilt and a bark', start: 10.5, end: 13 },
    { name: 'Good boy', start: 13, end: 15 },
  ],
  agent: 'Kazi',
  raw: {
    src: '/demo/bark/raw.mp4',
    poster: '/demo/bark/raw.jpg',
    label: 'biscuit-clips.mp4 · 0:24',
    seconds: 24,
    sound: true,
  },
  transcript: [
    { text: 'Clip 1: Biscuit barks at the camera three times' },
    { text: 'Clip 2: he runs straight at the phone' },
    { text: 'Clip 3: he jumps, catches a red ball and trots off with it' },
    { text: 'Clip 4: he sits, tilts his head and barks once more' },
    { text: 'The waits between the moments', cut: 0 },
    { text: 'The clips’ own sound, apart from one bark', cut: 0 },
  ],
  turns: [
    {
      prompt:
        'These are clips of my dog Biscuit. Make a fun 15-second video with a beat made out of his bark: use his bark as one of the drums. Cuts on the beat.',
      reply:
        'I’ll find Biscuit’s barks in your clips and take the cleanest one. I’ll load it as a drum in a beat with a kick, hi-hats, bass and a short tune, then cut his best moments on the beat, so you see him bark when his bark drum hits.',
      calls: [
        { fn: 'media.import', note: 'your clips' },
        { fn: 'media.listen', note: 'found four barks' },
        { fn: 'media.analyze', note: 'each bark’s exact start, level and tail' },
        { fn: 'render.frames', note: 'looked at every clip' },
        { fn: 'score.create', note: '120 beats a minute' },
        { fn: 'score.batch', note: 'a drum kit, his bark as a drum, bass and a tune' },
        { fn: 'score.batch', note: 'the pattern: his bark on every second and fourth beat' },
        { fn: 'score.render', note: 'the beat, the bark alone and the rest alone' },
        { fn: 'media.analyze', note: 'the bark against the rest, hit by hit' },
        { fn: 'score.batch', note: 'the bark evened out left to right, and louder' },
        { fn: 'timeline.create', note: 'vertical, 24 fps' },
        { fn: 'edit.batch', note: 'eight shots, every cut on a beat' },
        { fn: 'edit.batch', note: 'the beat, a punch-in, his name' },
        { fn: 'title.add', note: '“GOOD BOY!” on the last hit' },
        { fn: 'qa.check', note: 'loudness and peaks' },
        { fn: 'export.video', note: 'vertical, 0:15' },
        { fn: 'media.listen', note: 'his bark found on the finished file, hit after hit' },
      ],
      status: 'Making a beat out of his bark…',
      done: 'Here’s Biscuit’s 15-second beat video. His own bark, the cleanest one in your clips, is the snare on every second and fourth beat, and every cut lands on a beat. You see him bark as the bark drum hits four times, the last on the final hit. It opens on his name and ends on “GOOD BOY!”. Want it faster, or a different bark as the drum?',
      video: {
        src: '/demo/bark/cut.mp4',
        poster: '/demo/bark/cut.jpg',
        label: 'biscuit-bark-beat.mp4 · 0:15',
        seconds: 15,
      },
    },
  ],
};

export const DEMOS: Demo[] = [
  SPORTS,
  KIDS,
  BROLL,
  HOOPS,
  TALK,
  JINGLE,
  TRIP,
  HUM,
  BARK,
  TESTIMONIAL,
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
