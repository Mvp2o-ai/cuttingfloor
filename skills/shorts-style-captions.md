---
name: shorts-style-captions
description: Shorts and TikTok style captions with cuttingfloor, including a gradient or rounded band behind the words, which a caption's own box (one solid colour, square corners) can't draw. One band picture from create.matte, shaped with a rounded mask on a track under the captions, then caption.add with word timings for word-by-word highlighting. Use when someone asks for captions or subtitles "like TikTok", "like Shorts", "with a gradient behind them", "in a rounded box", "in a bar" or "with the word lighting up", or for a branded caption look.
version: 2
type: playbook
source: system
author: Ken Wiltshire
related: spend-credits-wisely:prerequisite, turn-a-long-video-into-shorts:related
---

# Shorts-style captions

A caption's own `style.box` is one solid colour (it may be see-through, #RRGGBBAA) with square corners. A gradient band, rounded corners or a brand shape behind the words is one picture under the captions, not part of them, and never one picture per line.

## When to use
- Someone wants captions in a styled band or box: a gradient, rounded corners, a brand colour bar, a "TikTok" or "Shorts" look.
- Someone wants the spoken word to light up as it is said.

## Prerequisites
- The cuttingfloor MCP server is connected.
- The video is on a timeline at its final size (for Shorts, 1080×1920).
- Word timings for the speech: `media.analyze {kind: "transcript"}`, read with `media.get {include: ["transcript"]}`.

## Steps
1. The assistant should make the band once with `create.matte {gradient: {from, to, angle}, width, height}` at the sequence size: angle 90 runs left to right, and colours may carry opacity (#7B2FF7EE). A solid band uses `color` instead. It is one quick job, reused for the whole video.
2. The assistant should add a video track above the footage (`track.add`) and place the band on it with `clip.add`, for the stretch the captions show. Where there are long gaps with no speech, it places one band clip per stretch of speech, so no empty band sits on screen.
3. The assistant should shape the band with `clip.set_mask {shape: "rectangle", x: 0.5, y, width, height, corner_radius}`, in fractions of the frame. A two-line caption at size 0.045 fits a band about 0.1 of the frame high; `corner_radius` 0.3 to 0.5 rounds it into a pill. On 9:16, y between 0.65 and 0.75 keeps it clear of the buttons and text the apps draw at the bottom and the right.
4. The assistant should add the captions on a track above the band with `caption.add`, giving each segment its `words` with frames for highlighting (or `in_clip` with transcript seconds), and a style with no box of its own: `box: null`, `outline: null`, a soft `shadow`, `y` at the band's centre with `anchor: "middle"`, `max_width` a little inside the band, `max_lines: 2`, and `highlight: {mode: "word", color}` (or `karaoke`, `fill` or `pop`). Short segments of 3 to 6 words read best on a phone.
5. The assistant should look at a few frames with `render.frames` (free), one per caption, and check that every line sits inside the band and nothing is cut off. To change the look of every caption at once, it uses `text.set` on the caption track.

## Decision table
| Situation | Do |
|---|---|
| The band should only show while someone speaks | One band clip per stretch of speech, same band media each time |
| Captions at the top instead (a hook line) | Same band and mask with y around 0.15 to 0.2, and the caption y to match |
| A brand look (logo colours, a shape) | The band from the brand colours; a shape other than a rectangle is another mask shape, or a `create.still` from HTML, made once |
| Text that grows with each line | A band sized for the longest caption, or caption `max_width` tightened so lines stay inside |
| A plain see-through box is enough | Skip the band: caption `style.box {color: "#000000AA", padding}` |

## Required behavior
- One band picture for the whole video, never one picture per caption line.
- The words are captions (free edits that keep their timing and restyle with `text.set`), not text drawn into pictures.
- Check frames before exporting.
