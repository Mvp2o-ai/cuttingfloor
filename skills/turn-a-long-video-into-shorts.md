---
name: turn-a-long-video-into-shorts
description: Turn a long video (a gaming stream, a livestream, a podcast, a film, a lecture) into several vertical Shorts, Reels or TikToks with cuttingfloor - one import, the moments the user wants cut to 15 to 60 seconds with the hook first, each panned and scanned to full-screen 9:16, captioned, and exported once. Use when someone asks for Shorts, Reels, TikToks or clips from a long video, or to repurpose, clip or cut down a stream, episode or film.
version: 2
type: playbook
source: system
author: Ken Wiltshire
related: pan-and-scan:prerequisite, shorts-style-captions:related
---

# Turn a long video into Shorts

The techniques are their own skills: pan-and-scan (with subject-tracking) for the vertical picture, shorts-style-captions for the words. This adds what is particular to Shorts.

## When to use
- A long video and a request for several short vertical clips from it.

## Prerequisites
- The cuttingfloor MCP server is connected.
- The video is reachable as a file: a direct public link, an upload, or the user's upload page. A video site's page (YouTube, Twitch) is not a file; ask the user for the file itself.

## Steps
1. The assistant should import the video once and start, together, the analyses every Short will share: `transcript` (model `base`), `scenes {threshold: 10}` and the subject positions pan-and-scan needs (`faces`, or `track`). One `job.get {job_ids}` waits for all of them.
2. The assistant should choose the moments the user asked for, using the transcript and `media.seek` in plain words for what they describe ("the clutch play", "when she laughs"), and check each on a 16-frame `render.frames` sheet of the media (free). Each Short is 15 to 60 seconds and opens on its hook: the line or action that makes someone stop scrolling, in the first two seconds.
3. The assistant should build each Short on its own 1080×1920 timeline at the video's frame rate, cut with `clip.add {source: {in, out}}`, and pan and scan it to full-screen vertical (pan-and-scan).
4. The assistant should caption it from the transcript with `caption.add {in_clip}` in transcript seconds, 3 to 6 words a segment with word timings, leaving out bracketed sound tags such as `[Music playing]`; for a styled band or box, shorts-style-captions.
5. The assistant should look at one frame per shot, then start every Short's `export.video` (`mp4_h264`) together, and hand back each download link and page link with where in the long video it came from.

## Decision table
| Situation | Do |
|---|---|
| A gaming stream with a facecam in a corner | A stack: the facecam cropped (`crop`) across the top third, the gameplay panned below |
| Music drowns the speech in the transcript | Retime or retype those captions; caption no sound tags |
| The user names the moments | Use their times; search only what they didn't name |
| Many Shorts | One import and one set of analyses; one timeline and one export each |

## Required behavior
- One import and one set of analyses for all Shorts.
- Every Short opens on its hook and says where it came from.
