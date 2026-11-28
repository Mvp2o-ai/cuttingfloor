import { kaziUrl } from '../app/kazi.tsx';

// Posts: what a feature does, told from the user's side and checked against the server. Every
// fact in a post comes from running it on production; the pictures are real screens and outputs.

export type BlogBlock =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'img'; src: string; alt: string; caption: string; width: number; height: number };

export type BlogPost = {
  slug: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  /** The first paragraph, under the title. */
  lede: string;
  updated: string;
  sections: { heading: string; blocks: BlogBlock[] }[];
  /** Where to try it, with a prompt to paste. */
  tryIt: { href: string; label: string; prompt: string };
};

export const BLOG_UPDATED = '2026-11-28';

export const POSTS: BlogPost[] = [
  {
    slug: 'make-music-in-layers-with-ai',
    title: 'How to make music in layers with AI',
    metaTitle: 'How to make music in layers with AI, and tap your own drums over it | cuttingfloor',
    metaDescription:
      'When your AI assistant makes music for a video with cuttingfloor, it builds it in layers: drums, bass, chords and a lead, each changeable on its own in words. You can add a layer yourself by tapping drum pads or humming over the loop.',
    lede: 'When your AI assistant makes music for a video with cuttingfloor, it builds the music in layers: drums, bass, chords, a lead. Each layer is one instrument playing its own notes at its own level. You change a layer by saying so, and the other layers stay as they were. You can also add a layer yourself, by tapping drum pads or humming over the music while it loops.',
    updated: '2026-11-28',
    sections: [
      {
        heading: 'What a layer is',
        blocks: [
          {
            kind: 'p',
            text: 'A layer holds one instrument and the notes it plays. A drum layer plays a drum kit, a bass layer plays a bass sound, a chord layer plays held chords. Each has its own volume and can be muted or played on its own. The finished music is all the layers playing together, turned into one audio file that goes under your video.',
          },
          {
            kind: 'p',
            text: 'The picture below is a 10-second piece made this way: four bars at 96 beats a minute, with four layers. Time runs left to right and pitch runs bottom to top. Blue is the drums, orange the bass, green the chords, and pink the three notes tapped in on the drum pads: two claps and an open hi-hat.',
          },
          {
            kind: 'img',
            src: '/blog/layering/layers.png',
            alt: 'A piano roll of four bars: drum hits in blue near the bottom, a bass line in orange below them, held chords in green above, and three pink percussion notes.',
            caption:
              'Four layers, drawn by cuttingfloor: drums, bass, chords, and percussion tapped in by hand.',
            width: 1280,
            height: 726,
          },
        ],
      },
      {
        heading: 'How you build one',
        blocks: [
          {
            kind: 'p',
            text: 'You describe the music, and your assistant builds and changes the layers. In order, it goes like this:',
          },
          {
            kind: 'list',
            items: [
              'Say what the video needs: the feel (“warm”, “hard and building”), how long, and any moment the music should hit, such as a goal, a reveal or the last line.',
              'Your assistant sets the tempo and adds the layers one at a time, usually the beat and the bass first, then chords, then a lead or a hit for the big moment.',
              'It renders the music to audio and puts it under your video. It can render one layer on its own so you can hear just the drums or just the bass.',
              'Ask for changes in words: “quieter drums”, “a darker bass”, “drop the chords in the first bar”, “swap the lead for a piano”. Only that layer changes.',
            ],
          },
          {
            kind: 'p',
            text: 'Every change makes a new version of the music, and the earlier versions stay available for 7 days after you last use them, so you can go back. The music stays editable after it is in your video: “make it darker” changes the same notes and instruments, it does not start over.',
          },
        ],
      },
      {
        heading: 'Add a layer yourself with the drum pads',
        blocks: [
          {
            kind: 'p',
            text: 'Ask your assistant for pads to play, for example “let me tap a clap over it”. It opens a page of drum pads, each named for its sound. In a chat app that shows cuttingfloor’s views, the pads appear in the chat; anywhere else your assistant gives you a link that opens them in a browser, on a phone or a computer.',
          },
          {
            kind: 'img',
            src: '/blog/layering/pads-playing.png',
            alt: 'The cuttingfloor play-the-pads page while the loop plays: a red Stop button, pass 1, four pads named Clap, Side stick, Open hi-hat and Crash cymbal, and a speed slider at 1.00×.',
            caption:
              'Playing: the music loops under you while you tap. The strip of dashes marks the count-in clicks and the beats of the loop.',
            width: 560,
            height: 308,
          },
          {
            kind: 'list',
            items: [
              'Tap Start. You hear a count-in of clicks if your assistant asked for one, then the music loops.',
              'Tap the pads in time with it. Keep going for as many passes of the loop as you like, then tap Stop.',
              'The Speed slider slows down or speeds up what you hear while you play, from a quarter speed to double. The music’s own tempo does not change, so a part tapped slowly plays back at full speed.',
              'Turn on “Hear the pads as I tap” to hear each pad as you hit it.',
            ],
          },
          {
            kind: 'img',
            src: '/blog/layering/pads-review.png',
            alt: 'The pad page after Stop: “2 taps. Listen back, redo it, or send it.”, with Stop, Redo and a green Send button.',
            caption:
              'After Stop: listen back, redo it, or send it. Nothing is sent until you tap Send.',
            width: 560,
            height: 314,
          },
          {
            kind: 'p',
            text: 'When you tap Send, the take goes into the music as a new layer of notes. Each tap becomes a note at the moment you played it, not moved onto the nearest beat, so a clap played slightly late stays slightly late. In the take behind the picture above, the first clap landed at beat 3.12 of the loop. If you want it exactly on the beat, ask your assistant to move it.',
          },
          {
            kind: 'p',
            text: 'Taps you play on a second pass of the loop are kept but silent, until you ask for the layer to be made longer. Most phones don’t report how hard you hit the screen, so every tap is stored at the same strength, which your assistant chooses and can change afterwards. The page also reads your device’s sound delay (31 milliseconds on the laptop we used) and takes it off each tap, so the notes line up with what you heard.',
          },
        ],
      },
      {
        heading: 'Or hum it',
        blocks: [
          {
            kind: 'p',
            text: 'The same page can record from your microphone instead of the pads. Hum a tune, tap a rhythm on the table or say a line over the loop, and the recording comes back as an audio layer placed on the beat you heard. Use headphones if you can: recorded over a speaker, the take also picks up the music, and your assistant is told where.',
          },
        ],
      },
      {
        heading: 'Limits',
        blocks: [
          {
            kind: 'list',
            items: [
              'A loop can be up to 120 seconds, and a page can hold up to 64 pads.',
              'A microphone take can be up to 10 minutes.',
              'One take per page. A page waits 24 hours for you, then expires.',
              'The music is instrumental: no singing and no lyrics are generated.',
            ],
          },
        ],
      },
    ],
    tryIt: {
      href: kaziUrl('home'),
      label: 'Try it now in Kazi, free',
      prompt:
        'Make a short beat for this clip with drums, bass and chords, then give me drum pads so I can tap a clap over it.',
    },
  },
];

export const blogPath = (p: Pick<BlogPost, 'slug'>) => `/blog/${p.slug}`;

export function post(slug: string): BlogPost | undefined {
  return POSTS.find((p) => p.slug === slug);
}
