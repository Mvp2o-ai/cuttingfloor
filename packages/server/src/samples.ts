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
    fits: 'gaming videos with a facecam or commentary: Twitch, Kick and YouTube streams and VODs, stream highlights and funny moments, gaming memes, meme and reaction edits, kill highlights with memes, esports casts, facecam on top and gameplay below',
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
    fits: 'product reviews, unboxings and try-ons by a person on camera, UGC ads, beauty and fashion creators, app, brand or product promos filmed with a person, marketing videos',
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
    shows:
      'a 60-second dance routine filmed in six takes from different angles (wide, waist-up, low from the floor, side, feet, close-up) in a parking garage at night, with only room sound',
    fits: 'dance and choreography videos, dance challenges and trends, TikTok and Reels dance edits, cutting one routine filmed from several angles or takes together on the beat, music performances and covers, fitness',
    starter:
      'Cut these six takes into one vertical dance video: open on the final point, switch angles on the big moves, slow down into the spin and punch in on the hits.',
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
    slug: 'promo-stills',
    file: 'promo-stills.mp4',
    shows:
      'a 22-second set of six product photos of a small studio’s handmade mugs, shown one after another with no motion, under the seller’s own recorded voiceover with the price and offer, and no music',
    fits: 'promos and ads made from photos or product images with no filming: book, product and shop launches, slideshows with a voiceover, photo promos with music, WhatsApp Status and Instagram promos, sale and offer videos, A/B versions with different hooks',
    starter:
      'Make a 20-second promo for Reels from these photos: open on a hook, move every photo, put the key words on screen as they are said, end on the price and a call to action, then make a second version that opens with the offer.',
  },
  {
    slug: 'lyric-video',
    file: 'song-and-footage.mp4',
    shows:
      'a 38-second original pop song with clear sung words, played over six raw phone clips of the singer in her home music room at night, with no words on screen, no grade and no cuts to the beat',
    fits: 'lyric videos and lyric Shorts: the words of a song on screen in time with the singing, karaoke-style text, music promos and song teasers for an artist, rapper or band on Reels, TikTok and Shorts, a new single or release announced with its lyrics',
    starter:
      'Make a 30-second lyric Short of this song: every line on screen as she sings it, the key words big, the words moving with the beat, the footage cut to the beat with a warm grade, and the hook line as the big moment.',
  },
  {
    slug: 'background-swap',
    file: 'messy-room-talk.mp4',
    shows:
      'a 28-second phone video of a creator giving money tips to camera in a cluttered, badly lit bedroom (laundry on the bed, a messy shelf, an open doorway), with clear speech and no captions',
    fits: 'removing or replacing the background behind a person: green screen without a green screen, a clean studio, black or coloured backdrop, blurring or hiding a messy room, cutting a person out and putting them in front of a new scene or picture, with captions on top',
    starter:
      'Swap the messy room behind him for a cinematic black backdrop with a soft light, light him to match so it looks real, and add bold word-by-word captions.',
  },
  {
    slug: 'testimonial',
    file: 'client-testimonial.mp4',
    shows:
      'a 44-second vertical phone video of a happy customer talking to camera in Spanish about her kitchen renovation, with a restart, a long pause and a repeated line, then four before and after photos of the same kitchen shown plainly at the end, with no captions or music',
    fits: 'client and customer testimonials and reviews for a small local business (salons, barbers, cleaners, painters, renovators, trainers, clinics): before and after transformations and reveals, a happy client talking with before and after photos over their voice, a business Reel with the business name and a call to action, subtitles in Spanish or another language',
    starter:
      'Make a 25-second Reel from this testimonial: open on the best after photo with a hook, cut the restart, the pause and the repeated line, reveal each before and after photo with a slider over her voice, bold Spanish subtitles word by word, and end on the business name and a call to action with light music.',
  },
  {
    slug: 'broll-reel',
    file: 'shop-broll.mp4',
    shows:
      'a 29-second set of four shaky, ungraded vertical phone clips from a small coffee roastery with nobody talking: a coffee being poured into a cup, beans tumbling out of the roaster, beans scooped into a bag, and a hand stamping the bag, with natural room sound and no text or music',
    fits: 'Reels and TikToks from b-roll or clips with nobody talking: small business and brand Reels (food, coffee, bakeries, crafts, farms, shops), behind the scenes and how it’s made videos, opening text hooks, short 10–20 second cuts of a few clips to music',
    starter:
      'Make a 15-second Reel from these clips: a bold hook line on the first frame, only the best moments in short shots cut to music, a warm grade, the shaky shots steadied, the pour and the beans still audible under the music, and the shop name with a call to action at the end.',
  },
  {
    slug: 'kids-story',
    file: 'cartoon-scenes.mp4',
    shows:
      'a 36-second set of six silent vertical 3D cartoon scenes of a short kids’ story, in order: Pip, a small white cloud, floats over a meadow; Rumble, a grumpy storm cloud, rolls in with lightning and shouts; Daisy, a thirsty flower, droops in dry ground; Pip takes a deep breath and flies down; Pip rains on Daisy and she blooms; a rainbow ends it. No voices, sound, music or text',
    fits: 'kids’ stories and cartoons for children: bedtime and moral stories, fables and fairy tales, animated characters with their own voices and a narrator, nursery and storybook videos, educational videos for kids, adding character voices, sound effects and music to animation',
    starter:
      'Make this a 35-second kids’ story Short: a narrator and a different voice for Pip, Rumble and Daisy timed to what they do, a cartoon sound effect on every action, light music under the voices, a title card at the start, big simple captions for early readers and a friendly ending with the lesson.',
  },
  {
    slug: 'sports-tribute',
    file: 'match-highlights.mp4',
    shows:
      'a 22-second set of six wide phone clips from the sideline of a local women’s football (soccer) club, all of one player, a young Black woman striker, number 9 in sky blue: tying her boots in the changing room, jogging back after a shot at training, a nutmeg past a defender, a goal under the floodlights, a knee slide with her teammates running in, and fans at the fence with a “ZOLA 9” sign. Crowd and pitch sound, no music or text',
    fits: 'sports highlights and tributes: a player or team montage, fan edits of a favourite or retiring player, goals, plays and game-winners in slow motion, a season recap, highlight reels for scouts and recruiting, football, soccer, basketball and other team sports filmed from the sideline',
    starter:
      'Make a 27-second vertical tribute to the number 9 from these clips, following her in every shot: a quiet start, slow motion on the goal, the music dropping as it goes in with a crowd roar, her name and number as titles at the end, and a grade that makes it feel like a big night.',
  },
  {
    slug: 'screen-recording',
    file: 'app-walkthrough.mp4',
    shows:
      'a 49-second screen recording of someone sending an invoice in a made-up web app, the cursor clicking through each step while he explains it out loud, with a long pause and a price he types wrong and fixes',
    fits: 'screen recordings: app, website and software walkthroughs, how-to and tutorial videos recorded on a computer screen, SaaS and product demos, Loom-style recordings, turning a screen recording into a vertical how-to Short with zooms on the clicks and numbered steps',
    starter:
      'Make a 30-second vertical how-to Short from this recording: cut the long pause and the mistake, follow the cursor and zoom in on every click, number the steps on screen and add captions from his voice.',
  },
  {
    slug: 'gameplay-montage',
    file: 'gameplay-clips.mp4',
    shows:
      'a 39-second set of six gameplay clips from a made-up fantasy action game, with no facecam, commentary or music: a jump across a chasm, a fight with stone golems, a glide from a tower, a shockwave spell, a crystal boss kill and a last fight, with game sound only',
    fits: 'gameplay montages and edits with no facecam: game clips cut to a song or soundtrack, epic and cinematic game edits, boss fights, best plays and clutch moments with slow motion and impacts, game trailers and highlight reels made from recorded gameplay',
    starter:
      'Cut these clips into a 30-second gameplay montage on the beat of a track: open on the boss kill, slow motion into the big hits with a flash and a hit sound on each impact, and a title at the end.',
  },
  {
    slug: 'event-highlights',
    file: 'award-night.mp4',
    shows:
      'a 50-second set of seven phone clips from a community awards night in a local hall: the room filling up, the host announcing the Volunteer of the Year, the winner’s surprised reaction and walk to the stage, the award handed over, her short thank-you speech, a standing ovation and dancing later, with room sound and no music or text',
    fits: 'event highlight videos and recaps: award nights, galas and fundraisers, weddings and receptions, toasts, birthdays and parties, graduations, church and community events, turning a night of event footage into a short highlight reel with the cheers, the toasts and the best moments of the night',
    starter:
      'Make a 40-second highlight reel of this awards night: open on the crowd cheering, keep the announcement and the best line of her thank-you speech with captions, cut the rest to music with a warm grade, and end on the standing ovation with a title for the night.',
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
