import { fileURLToPath } from 'node:url';

// The onboarding shelf: short raw clips that ship with the server (assets/onboarding/), one per
// kind of job people bring. credits.claim puts the one that fits the user's task in their
// library, so their first edit is one prompt away. Adding a kind of job is adding a clip and its
// card here. The cards are the router's options: `fits` is what Jev reads to pick one.

export interface Sample {
  /** The card's name, and the Jev choice. */
  slug: string;
  /** The file under assets/onboarding/, and the name it takes in the library. */
  file: string;
  /** What the clip is, for the assistant. */
  shows: string;
  /** The jobs it fits, for the router. */
  fits: string;
  /** A first edit to offer, in one prompt. */
  starter: string;
}

/** Shown when nothing else fits, or the router can't answer. */
export const FALLBACK_SAMPLE = 'animation-short';

export const SAMPLES: Sample[] = [
  {
    slug: 'gaming-stream',
    file: 'gaming-stream.mp4',
    shows: 'a 2-minute gaming stream with the streamer’s facecam and commentary',
    fits: 'gaming, game streams and Twitch or YouTube gameplay, esports, kill highlights, montages, meme and reaction edits, facecam videos',
    starter:
      'Find the best moment in this stream and make a 30-second vertical Short: facecam on top, gameplay below, big word-by-word captions and a zoom on the big play.',
  },
  {
    slug: 'podcast-interview',
    file: 'podcast-interview.mp4',
    shows: 'a 48-second podcast interview between two people',
    fits: 'podcasts, interviews, conversations, panels, multi-camera talk, clips from long talks, webinars, church sermons',
    starter:
      'Cut this interview into a 30-second vertical Short: open on the strongest line, remove the ums and dead air, add captions and name cards.',
  },
  {
    slug: 'product-review',
    file: 'product-review.mp4',
    shows: 'a 24-second beauty product review by a creator, filmed in takes',
    fits: 'product reviews, ads, e-commerce, beauty and fashion, UGC, app, brand or product promos, marketing videos',
    starter:
      'Make this review a 15-second Short: open on the best line, speed through the demo, pop up callouts as she says them and end on a card with the price.',
  },
  {
    slug: 'real-estate-listing',
    file: 'real-estate-listing.mp4',
    shows: 'a 20-second real estate listing walkthrough by an agent',
    fits: 'real estate, property tours, listings, travel and places, hotels, restaurants, local business walkthroughs',
    starter:
      'Turn this listing into a vertical post: cut the dead air and the wrong address, add captions and a price card at the end.',
  },
  {
    slug: 'talking-tips',
    file: 'talking-tips.mp4',
    shows: 'a 40-second talking-head tips video with pauses and a restart',
    fits: 'talking-head videos, tips, education, tutorials, courses, explainers, coaching, vlogs, motivational or faith talks, personal brand',
    starter:
      'Remove the pauses and the restart, add big word-by-word captions and a hook title at the top.',
  },
  {
    slug: 'dance-takes',
    file: 'dance-takes.mp4',
    shows: 'a 34-second dance routine filmed in several takes',
    fits: 'dance, choreography, music performances and covers, fitness, cutting a person’s takes together on the beat',
    starter:
      'Cut these takes together on the beat into one vertical video, switching takes on the big moves.',
  },
  {
    slug: 'car-takes',
    file: 'car-takes.mp4',
    shows:
      'a 36-second set of five phone clips of a dark sports car on a coast road at sunset, flat colours, with wind and engine sound',
    fits: 'car, motorbike and supercar edits, skate, surf and action sports, cinematic edits, speed ramps, road trips and drone b-roll, colour grading, making phone footage look cinematic',
    starter:
      'Make a 20-second cinematic Short from these clips: a hook in the first second, speed ramps on the best moments, cuts on the beat, a moody colour grade, whooshes and a title.',
  },
  {
    slug: 'ai-film-clips',
    file: 'ai-film-clips.mp4',
    shows:
      'a 53-second set of six AI-generated clips of a lighthouse keeper on a stormy night, out of story order, each with its own colour and loudness, slow starts and one clip with no sound',
    fits: 'AI-generated clips from Kling, Runway, Sora, Veo or Midjourney video: putting AI shots in story order, matching colour across shots, AI short films and animal shorts, trailers, cinematic scenes, sound design and a score for AI video',
    starter:
      'Cut these AI clips into a 40-second short film: put them in story order, trim the dead starts, give every shot the same look, add a score, storm and footstep sounds, an opening title and an end title.',
  },
  {
    slug: FALLBACK_SAMPLE,
    file: 'big-buck-bunny.mp4',
    shows: 'a 30-second scene from Big Buck Bunny, an open animated film',
    fits: 'anything else: films and animation, family or travel memories, general editing, or a task too broad to place',
    starter:
      'Make this a 15-second vertical teaser with a title card at the start and an end card.',
  },
];

/**
 * Clips a demo of ours opens with, registered on purpose and never offered by the router: the
 * account is activated with one when it signs up through that demo, so the clip is in its library
 * before the demo starts. Another demo video is another entry and its file under assets/onboarding/.
 */
export const DEMO_CLIPS: Sample[] = [
  {
    slug: 'kazi-demo',
    file: 'big-buck-bunny-ending.mp4',
    shows: 'the last minute of Big Buck Bunny, an open animated film',
    fits: '',
    starter: 'Give this ending a happier ending.',
  },
];

/** A sample's file on disk. */
export const samplePath = (sample: Sample) =>
  fileURLToPath(new URL(`../assets/onboarding/${sample.file}`, import.meta.url));

export const sampleBySlug = (slug: string | undefined) =>
  [...SAMPLES, ...DEMO_CLIPS].find((s) => s.slug === slug) ?? (SAMPLES.at(-1) as Sample);
