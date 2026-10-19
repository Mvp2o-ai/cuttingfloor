---
name: bloopers-to-final-cut
description: Make a "Bloopers to Final Cut" Short or Reel that sells cuttingfloor by showing the editing experience inside an AI the viewer already uses (Kazi, Claude, ChatGPT). A creator fumbles a few takes (blooper beeps), shrugs it off, teaches the trick (connect your AI to cuttingfloor), talks to her AI, says "let's try that again", and the perfectly edited version plays, ending on the cuttingfloor end card. Use when asked for a promo Short, Reel, TikTok, demo video or "one of those blooper videos" for cuttingfloor, or a variant of one (new host, new app, new use case).
---

> Same skill as `.claude/skills/bloopers-to-final-cut/SKILL.md` (Claude Code); its scripts and templates live there. Edit that copy and mirror the text here and in the other harness folder.

# Bloopers to Final Cut

The format that works for cuttingfloor promos (settled with Ken, 2026-10-19). The star is the
editing done inside the viewer's own AI; the host is the wrapper. Every edit is a real
cuttingfloor MCP call: dogfood it, and when a tool fights you, that is a finding (write it down).

Reference build: `footage/shorts/her-bloopers-v10.mp4` in the main checkout (untracked), 45 s.

## The beats (vertical 1080x1920, 30 fps, 35–45 s)

| # | Beat | Picture | Sound |
|---|------|---------|-------|
| 1 | Hook + blooper 1 | Host's knowing smile and pause, hook text top ("Edit video with the AI you already use."). The pause is the first fumble: BEEP + "BLOOPER · TAKE 1" stamp at ~2.4 s | bed up |
| 2 | Bloopers 2–4 | Real fumbles from the raw takes: a bad start, "it's like a… wait", "Hey everyone, so today I—" (awkward beat). Each ends on a beep + small stamp | her, beep |
| 3 | Shrug | "Whatever. I'll have my agent edit that out." End on a quick smile, not the laugh | her |
| 4 | Teach | To camera: "Here's the trick. Connect your favorite AI to cuttingfloor. Kazi, Claude, ChatGPT, whichever you use." Panel: "Connect your favorite AI", the MCP address pill, then each app icon pops as she names it | her, captions |
| 5 | Talk to the AI | The app's session fills the screen (recreated chat, real tool calls), host cut out in the bottom-right corner: "I prefer Kazi. I just tell it: cut this, cut that. Green background here, overlay there." The typed request matches her words | her, caption beside her |
| 6 | Reset | "Okay. Let's try that again." | her |
| 7 | Final cut | The perfectly edited piece (green slides, jump cuts, captions), "TAKE 3 · FINAL CUT" tag | her |
| 8 | Sign-off | "Save this one. You're gonna need it." + "Comment EDIT for the link" | her |
| 9 | End card | No host video, only her voice: "cuttingfloor AI. Editing, solved." Wordmark slices in, yellow AI stamp on "AI", "editing, solved." with a check, MCP URL | her voice |

Rules Ken set: bloopers are beeps and small stamps (no clapperboards, nothing bigger than her
head); the shrug replaces any "fumbled it"; the bridge to the final cut is her talking to her AI,
not a transition screen; the final cut must be flawless (see QA).

## 1. Cast and generate the takes

Footage comes from a video generator (cuttingfloor has no video generation): Gemini Omni through
apiFunnel `video_editor_api.generatevideo` (9:16, 8 s, 1080p, async; poll `getvideogeneration`).
- First clip with no reference; then a frame of it as the reference image for every other clip so
  the person, outfit and room stay the same. Look at a contact sheet of every clip before using it.
- The sandbox has no network: get the reference in through a bridged API (a private GitHub repo
  read with `github_rest.repos_get_content` works), not by pasting base64.
- Gemini refuses photorealistic children as references; pick an adult host.
- Casting: people of color first (preferably Black) unless the brief says otherwise.
- Dialogue goes in the prompt as quoted speech; end every prompt with "No extra dialogue. No
  music. No on-screen text or logos." Silent shots: say "She does not speak" — generators add
  "wow" otherwise.

Clips per host (11 used): 3 raw takes of the explainer (one messy), a silent knowing-look hook, a
blooper ("Hey everyone, so today I—" then a beat), the shrug line, the teach line, the "I prefer
Kazi…" line, "Okay. Let's try that again.", the sign-off, the end-card line.

## 2. Edit the final cut (the thing she asked her AI for)

All through cuttingfloor: `media.import` the takes, `media.analyze` transcript and silence,
`create.cutout` (people) to cut her out, `create.motion` slides timed to her words, `edit.batch`
to place speech pieces on the slides with alternating punch-ins (jump cuts), `caption.add in_clip`,
`audio.set_gain` to level-match takes, `filter.add noise_reduction` on the audio clips,
`export.video social_9x16_h264`.
- Build the speech pieces from `media.analyze silence` (-38 dB, 0.1 s), not from word times.
- Re-time the slides to the cut after every change.

## 3. Assemble the Short

`.claude/skills/bloopers-to-final-cut/scripts/assemble.mjs <spec.json>` builds the whole Short on cuttingfloor from a spec (see
`.claude/skills/bloopers-to-final-cut/scripts/spec.example.json`); `.claude/skills/bloopers-to-final-cut/scripts/verify.mjs <timeline_id> <out.mp4>` exports it, downloads it
and prints the export's own transcript. Pieces it expects, all made with cuttingfloor:
- session recreation: `create.motion` of `.claude/skills/bloopers-to-final-cut/scripts/mock.py` (theme kazi | claude | chatgpt), 12 s,
  the request = her words, the calls = the tools really used.
- `.claude/skills/bloopers-to-final-cut/templates/icons.html` (connect panel), `.claude/skills/bloopers-to-final-cut/templates/stamp.html` (blooper stamp, one per take),
  `.claude/skills/bloopers-to-final-cut/templates/hero.html` (end card): render with `create.motion`, transparent, 1080x1920.
- `.claude/skills/bloopers-to-final-cut/scripts/beep.py` and `.claude/skills/bloopers-to-final-cut/scripts/bed.py` (beep and an original lo-fi bed, no copyright) via `code.run`.

## 4. QA before anyone sees it (every item caught a real defect)

- Transcribe the export and read it top to bottom against the script. The transcriber merges
  repeats ("it lets your, it lets your" came back as one), so for any line that sounds long, read
  the waveform (40 ms RMS) and cut the repeat yourself.
- No gap of 0.15 s or more inside the final cut (silence analysis on its export).
- Takes from the generator differ in level and hiss: measure each (ebur128, astats noise floor),
  `audio.set_gain` to match, `noise_reduction` 8–18 dB.
- Loudness of the Short about -14 LUFS, peaks under -1 dB (`audio.set_master` gain + limit).
- Look at frames at every beat boundary (`render.frames`): text off faces, stamps head-sized,
  panels not on her head, captions not on chat text.
- Keep text out of the bottom 20 % and the right edge where the app's buttons sit.
- Caption spellings the transcriber gets wrong (it hears "Kazi" as "Cosy"/"Casi"): fix in the
  caption segments.

## Gotchas (tool behaviour as of 2026-10-19)

- Transitions in overlap mode pull everything after them earlier; anything placed by absolute time
  then drifts. Use hard cuts or `mode: handles`.
- Titles on the same track replace each other; overlapping text needs its own track.
- `filter.add` with an audio effect needs the audio clip, not the linked video clip (reported).
- Parallel `create.motion` renders can take the sandbox down (`server_busy`); render one at a time
  and retry after ~60 s (see plans/motion-sandbox-concurrency.md).
- Export to a new filename each version: QuickTime keeps showing a file it has open even after
  it is overwritten.
- Gemini dialogue is not word-exact: always transcribe before cutting.

## Publishing

Each platform gets its own export: Instagram keeps "Comment EDIT for the link" (DM automation);
YouTube Shorts can't DM, so its sign-off says to search cuttingfloor or check the channel. Turn on
the platform's AI-generated / synthetic content label: the host is generated.
