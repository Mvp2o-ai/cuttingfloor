---
name: sync-video-to-music
description: Sync a video to music with cuttingfloor, either way round. Cut the video to the song (shots change on the beat or the bar, the big move lands on the drop, the end lands on the last hit), or fit the song to a finished video (trimmed to its length on a bar line, ending on a hit, faded right), with the music turned down wherever someone speaks. Use when someone asks to sync video to music, edit or cut to the beat, make a beat-synced, rhythmic or music-video edit, cut clips to a song, fit or trim a song to a video's length, score a finished video, or put music under a talking video.
version: 1
type: playbook
source: system
author: Ken Wiltshire
---

# Sync video to music

Measure the beats, turn every beat into a frame, and put cuts, hits and the ending on those frames. The music never drifts because nothing is placed by ear or by tempo arithmetic.

## When to use
- Music leads: clips, takes or B-roll to cut into a Short, a promo or a dance video on a song ("cut these to the beat", "make it rhythmic", "change shots on the bar").
- Picture leads: a finished video that needs a song fitted to it ("fit this song to my video", "trim the music to the video's length", "end the music when the video ends").
- Speech over music: a talking video that needs music under it, turned down while someone speaks.
- Several of these at once, which is common: a cut to the beat with a voice line kept, or a fitted song under a talking intro.

## Prerequisites
- The cuttingfloor MCP server is connected.
- The video and the song are reachable: a URL for `media.import {source: {url}}`, a file attached in the chat, or a file on the user's machine sent to the upload URL `media.import {source: {upload: {name, bytes}}}` hands back.
- Music the user owns or has a licence for. cuttingfloor does not make music and does not clear rights; an original track has to come from the user or from their agent's own music tool.

## Steps
1. The assistant should import the video (or every clip) and the song with `media.import`, and check them all with one `job.get {job_ids}` until each is ready. It should read each with `media.get` for `fps`, `duration_seconds`, `width` and `height`, and settle which way round the job is (music leads, picture leads, or speech over music) from what the user said; ask only if it is truly unclear.

2. The assistant should measure the song: `media.analyze {media_id: <song>, kind: "beats"}`. It returns `bpm`, `beats` (every beat, media seconds), `downbeats` and `strengths` (the onset strength at each beat, 0 to 1 of the strongest hit in the song). Treat the numbers as measurements to check, not truths:
   - `downbeats` is every fourth beat, starting from whichever of the four positions carries the most energy. It assumes four beats to a bar. Check it against `strengths`: the downbeats should be the stronger beats. If another of the four positions is clearly stronger across the song, use that one; in 3/4 or 6/8 music group the beats in threes yourself.
   - If `bpm` is half or double what the song feels like (for example 70 when the user calls it a fast song), the beats are still on the pulse; regroup them (every other beat, or halfway between) rather than trusting the count.
   - The drop and the big hits are the beats where `strengths` jumps to near 1 after a run of weaker beats. The last hit is the last strong beat before the song's tail; `media.analyze {kind: "silence", threshold_db: -40, min_seconds: 0.3}` on the song shows where it goes quiet at the end and at any breaks.
   - If the beats wander (a live recording, a song with tempo changes, heavy vocals), split out the drums with `create.stems {media_id: <song>, stems: ["drums"]}` and run `beats` on the drum stem. Its times line up with the song, so use them with the full song.

3. The assistant should measure the picture as well:
   - clips to cut: `media.analyze {kind: "scenes", threshold: 10}` on each clip finds the shot changes already inside it, so a beat cut never lands a frame or two from an existing cut; `render.frames {media_id, frames: [...]}` (up to 16 at a time) or `media.analyze {kind: "look"}` finds each move and the exact frame of its peak (a landing, a clap, a turn to camera, a product reveal);
   - a finished video to score: `media.analyze {kind: "scenes", threshold: 10}` gives its cuts and big moments, the places worth landing a downbeat or the drop on;
   - anything with talking: `media.analyze {kind: "speech", min_probability: 0.5}` on the voice (or on the timeline before the music goes in, with `timeline_id`) gives the spans where someone speaks.

4. The assistant should turn every time into a frame at the sequence rate before placing anything: `frame = round(seconds × fps.num ÷ fps.den)`, rounding each beat on its own. Never step forward by a bar length worked out from `bpm`; a bar is rarely a whole number of frames, so the error grows with every bar and the cuts drift off the music. Use the video's own size and frame rate for `timeline.create {sequence: {width, height, fps}, tracks: {video: 1, audio: 2}}` (1080 × 1920 for a vertical Short).

5. The assistant should, when music leads, choose the cutting grid before choosing shots:
   - one shot per bar (each downbeat) for most songs; every two bars above about 130 BPM or when a shot needs time to read; single beats only for a short burst, such as the build into the drop. A shot shorter than about two thirds of a second rarely reads;
   - start the song on a downbeat at the start of a phrase (phrases are usually 4 or 8 bars), so the edit opens on a strong beat rather than mid-phrase;
   - give each shot the moment that suits its place: the strongest move on the drop, a calm shot in a quieter bar, the final pose or the product on the last hit;
   - land a move's peak on a beat by choosing the clip's source in point: `source.in = peak_frame − (beat_frame − shot_start_frame)`, in the clip's own frames.

6. The assistant should build the music-led cut in one `edit.batch`: `clip.add {track_id: <music track>, media_id: <song>, av: "audio", at_frame: 0, source: {in, out}}` with `in` at the chosen starting downbeat, then each shot with `clip.add {av: "video", at_frame: <its downbeat frame>, source: {in, out}}` so every shot starts exactly on its beat (`av: "linked"` instead when the clip's own sound is wanted; turn it down with `audio.set_gain`). Cuts on the beat are hard cuts: a dissolve smears the hit. For a slow-motion move that must still land on the next downbeat, `clip.set_speed {rate}` with `rate = source frames used ÷ frames to fill`. To hold the final pose on the last hit, `clip.freeze {at_frame, duration_frames}`. The edit ends on the last hit: either let the hit ring with `audio.fade {out_frames}` of about half a bar to two bars, or end the song clip a few frames after the hit with a short fade so it does not click.

7. The assistant should, when picture leads, fit the song by cutting it on bar lines, never by changing its speed:
   - find the song's ending (its last hit, or the downbeat that closes a phrase) and back-time it: place the song so that ending lands on the video's last frame, or a few frames before so the hit rings out under the final picture;
   - if the song's start then falls mid-phrase, or before the video starts, leave whole bars out of the middle by building the song from two pieces: `clip.add {av: "audio", at_frame: 0, source: {in: <start downbeat>, out: <downbeat A>}}`, then `clip.add {av: "audio", after_clip_id: <first piece>, source: {in: <downbeat B>, out: <ending>}}`, where A and B are a whole number of bars apart (4 or 8, from repeating parts of the song such as two choruses) and the two pieces add up to the video's length. Smooth the join with `transition.add {kind: "crossfade", duration_frames: 4, mode: "handles"}` on the first piece;
   - if the song is shorter than the video, repeat a whole section the same way: a second `clip.add` of the song after the first, starting on a downbeat that matches where the first ends, joined with the same short crossfade;
   - starting part-way into the song, fade it in over a few frames (`audio.fade {in_frames: 6}`); ending where the song does not end, finish on a downbeat that closes a phrase and fade over about one bar (`audio.fade {out_frames}`);
   - where the video has a big moment (a reveal, a scene change from step 3), move the song by whole bars so a downbeat or the drop lands on it; whole bars keep the music intact.

8. The assistant should, when someone speaks over the music, turn the music down under each speech span with keyframes: `audio.set_gain {clip_id: <music clip>, gain_db: {keyframes: [...]}}`. Merge spans less than about half a second apart so the music does not pump between words. Key frames count from the music clip's start (not the timeline): the music's own level at frame 0, then for each span hold the level until about 0.3 s before the speech, be down by 10 to 18 dB when it starts, stay down to its end, and come back up over about 0.5 s. No two keys on one frame. If the song's own vocals fight the voice, use `create.stems {media_id: <song>, stems: ["no_vocals"]}` and put the instrumental in its place with `clip.replace {clip_id, media_id: <instrumental>, source_in: <the same in point>}`; the stem has the same timing as the song.

9. The assistant should check the result before calling it done:
   - `timeline.get` and compare every shot's start frame with the planned beat frame (shot start = music clip start + beat frame − music source in); every one should match exactly;
   - `media.analyze {timeline_id, kind: "scenes", threshold: 10}` measures the cuts as they render; each should fall on a planned beat frame;
   - `render.frames {timeline_id}` on both sides of the drop, the key moves and the last frame;
   - `qa.check {timeline_id, silence: {threshold_db: -50, min_seconds: 0.5}}` for gaps, black frames, silence and loudness; then `audio.set_master {gain_db, limit_db: -1}` to bring the mix up or down (about −14 LUFS suits social video) with the gain worked out from the `integrated_lufs` it measured;
   - a review export, `export.video {preset: "review_h264"}`, to watch it play with sound, and its `page_url` for the user to judge the feel, since whether a cut feels right is theirs to say.

10. The assistant should export and offer versions. `export.video` with `social_9x16_h264` for a vertical Short or `web_1080p_h264` otherwise; for the fitted song on its own, mute the other audio tracks with `track.set {muted: true}` and export `audio_wav_48k`. Then offer one or two alternatives in plain words (a shot every two bars instead of every bar, a different part of the song, a 15 or 30 second cut). Each is another edit from the same timeline; older timeline ids stay valid, so going back is free.

## Decision table
| Situation | Do |
|---|---|
| Fast song (above about 130 BPM) | Cut every two bars; save single-beat cuts for one short build |
| Slow song (below about 80 BPM) | Cut on each bar, or on every second beat if the shots are short |
| `bpm` feels half or double the song | Keep the beat times; regroup them into the bars the song really has |
| No steady beat (ambient, spoken word, free time) | Cut on the strongest onsets (`strengths`) and phrase ends; tell the user the beat grid is loose |
| A clip is too short to fill its bar | Slow it to fit with `clip.set_speed`, or cut to a new shot on the half bar |
| The song is longer than the video | Back-time the ending, then cut whole bars out of the middle |
| The song is shorter than the video | Repeat a whole section on matching downbeats, with a short crossfade |
| The user only wants the fitted music file | Mute the other audio tracks and export `audio_wav_48k` |
| The song's vocals clash with someone speaking | Use `create.stems` `no_vocals` under the speech, or duck deeper |
| The user is worried about copyright | Say cuttingfloor does not clear rights: use music they own or licence, or an original track |

## Required behavior
- Place every cut, hit and ending on a measured beat frame, rounded beat by beat; never on times estimated from the tempo.
- Never change the song's speed or pitch to make it fit unless the user asks; fit it by cutting whole bars.
- Never say a song is cleared for copyright, or that a platform will not mute or claim it.
- Say what was done in plain words: the tempo, how often the shots change, where in the song it starts and ends, how many bars were cut, and where the music was turned down.
