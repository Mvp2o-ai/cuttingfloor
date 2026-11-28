# Onboarding assets

The shelf credits.claim (activating the account) picks from (src/samples.ts holds each clip's card:
what it shows, the jobs it fits, a first edit to offer). Jev picks the card that fits the user's
task; the clip is imported into their library as their own media, never marked.

Ours (generated footage from the site's demos, apps/site/public/demo/<demo>/raw.mp4):
`gaming-stream.mp4`, `podcast-interview.mp4`, `product-review.mp4`, `real-estate-listing.mp4`,
`talking-tips.mp4`, `dance-takes.mp4`, `car-takes.mp4`, `ai-film-clips.mp4`,
`promo-stills.mp4`, `song-and-footage.mp4`, `messy-room-talk.mp4`, `client-testimonial.mp4`,
`shop-broll.mp4`, `cartoon-scenes.mp4`, `match-highlights.mp4`, `silent-trip.mp4` (travel clips with no
audio stream, for music made to fit) and `hummed-tune.mp4` (a generated hum of an original tune, shown
as its sound wave).

Starters with no demo page (footage only, made for the shelf): `app-walkthrough.mp4`, a screen
recording of a made-up invoicing web app (Fernbill), built in HTML with create.motion and voiced with
create.voiceover. `gameplay-clips.mp4`, six clips of a made-up fantasy action game (generated with
Gemini Omni), with no facecam or commentary. `award-night.mp4`, seven phone clips of a made-up community awards
night (Gemini Omni), with the host's announcement and the winner's thank-you speech.

`big-buck-bunny.mp4`, the fallback: 30 seconds (2:52 to 3:22) of Big Buck Bunny, 1280×720,
H.264 and AAC. (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org, licensed under
Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/). Cut from
Blender's `big_buck_bunny_720p_h264.mov`; the credit is also in the file's metadata.

Demo clips (src/samples.ts `DEMO_CLIPS`, never routed): an account signing up through one of our
demos is activated with its clip. `big-buck-bunny-ending.mp4`, the Kazi live demo's clip: the last
minute (59 seconds) of Big Buck Bunny, 640×360, the same bytes Kazi's demo link served
(sha256 dd9a49ff…). (c) copyright 2008, Blender Foundation / www.bigbuckbunny.org, licensed under
Creative Commons Attribution 3.0; the licence is also in the file's metadata.
