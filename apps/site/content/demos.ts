// Agent demos: a creator's own assistant (Claude, ChatGPT, Kazi) with cuttingfloor plugged in as
// an MCP tool, editing a real clip. Every video here is a real cuttingfloor render of that clip.

export type DemoCall = { fn: string; note: string };

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
  video: { src: string; poster?: string; label: string };
};

export type DemoWord = {
  text: string;
  /** The turn (0-based) that cuts it. */
  cut?: number;
};

export type Demo = {
  id: string;
  agent: 'Claude' | 'ChatGPT' | 'Kazi';
  /** The clip as it came in. */
  raw: { src: string; poster?: string; label: string };
  transcript: DemoWord[];
  turns: DemoTurn[];
};

// A creator's raw tips video (generated footage, edited for real by cuttingfloor).
const TIPS: Demo = {
  id: 'tips',
  agent: 'Claude',
  raw: {
    src: '/demo/tips/raw.mp4',
    poster: '/demo/tips/raw.jpg',
    label: 'posting-tips.mp4 · 0:40',
  },
  transcript: [
    { text: 'Okay, so three things I wish I knew before I started posting.' },
    { text: '[2 s pause]', cut: 0 },
    { text: 'Number one, nobody, nobody, wait, let me start that again.', cut: 0 },
    { text: 'Number one: nobody watches past three seconds unless you give them a reason.' },
    { text: '[pause]', cut: 0 },
    { text: 'Number two,' },
    { text: 'uh…', cut: 0 },
    { text: 'your first 50 videos are practice. And that’s fine.' },
    { text: '[4 s sipping coffee]', cut: 0 },
    { text: 'Number three: just post it. Seriously, just post the thing.' },
    { text: 'Just post the thing.', cut: 0 },
    { text: 'Okay, follow for part two.' },
  ],
  turns: [
    {
      prompt: 'Cut out the long pauses, the ums and the bits where I start over.',
      reply:
        'I can see a long pause, a restart, a coffee break and a line you said twice. I’ll cut those and smooth every cut.',
      calls: [
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'edit.batch', note: '6 cuts' },
        { fn: 'edit.batch', note: 'smoothed every cut' },
        { fn: 'audio.set_loudness', note: 'even, −14 LUFS' },
        { fn: 'render.frames', note: 'checked the cuts' },
      ],
      status: 'Cutting the pauses…',
      done: 'Done: 40 seconds down to 22, and everything you meant to say is still there. Want captions on it?',
      video: {
        src: '/demo/tips/clean.mp4',
        poster: '/demo/tips/clean.jpg',
        label: 'posting-tips-clean.mp4 · 0:22',
      },
    },
    {
      prompt: 'Yes, big captions.',
      reply: 'Adding them word by word, so it’s ready to post.',
      calls: [
        { fn: 'caption.add', note: 'word by word' },
        { fn: 'export.video', note: 'vertical, 0:22' },
      ],
      status: 'Adding captions…',
      done: 'Here it is, ready to post. Want a version for YouTube too?',
      video: {
        src: '/demo/tips/short.mp4',
        poster: '/demo/tips/short.jpg',
        label: 'posting-tips-captioned.mp4 · 0:22',
      },
    },
  ],
};

// A real estate agent's listing clip (generated footage, edited for real by cuttingfloor).
const LISTING: Demo = {
  id: 'listing',
  agent: 'ChatGPT',
  raw: {
    src: '/demo/listing/raw.mp4',
    poster: '/demo/listing/raw.jpg',
    label: 'listing-214-maple.mp4 · 0:20',
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
      reply: 'Got it. I’ll cut the wrong address and the pause, and even out the sound.',
      calls: [
        { fn: 'media.analyze', note: 'every word, timed' },
        { fn: 'edit.batch', note: '3 cuts' },
        { fn: 'edit.batch', note: 'smoothed the cuts' },
        { fn: 'audio.set_loudness', note: 'even, −14 LUFS' },
      ],
      status: 'Cutting…',
      done: 'Done: 20 seconds down to 15, and the address is right all the way through. Want captions and the price on screen?',
      video: {
        src: '/demo/listing/clean.mp4',
        poster: '/demo/listing/clean.jpg',
        label: 'listing-clean.mp4 · 0:15',
      },
    },
    {
      prompt: 'Yes. $485,000, 3 bed, 2 bath.',
      reply: 'Adding captions and a listing card up top.',
      calls: [
        { fn: 'caption.add', note: 'word by word' },
        { fn: 'title.add', note: '214 Maple · $485,000' },
        { fn: 'export.video', note: 'vertical, 0:15' },
      ],
      status: 'Adding the listing card…',
      done: 'Ready to post. Want a square one for Instagram too?',
      video: {
        src: '/demo/listing/short.mp4',
        poster: '/demo/listing/short.jpg',
        label: 'listing-214-maple-post.mp4 · 0:15',
      },
    },
  ],
};

export const DEMOS: Demo[] = [TIPS, LISTING];
