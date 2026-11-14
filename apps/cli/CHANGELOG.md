# cuttingfloor

## 0.45.10

### Patch Changes

- 7ef5474: A timeline id the account never had (a typo or a made-up id) is now refused as not found, with a hint to pass the id exactly as a result returned it. Only a timeline that really expired is called expired. Files too big to import say the limit in MB or GB, and say when it is the account's storage that is full.

## 0.45.9

### Patch Changes

- a6e8a34: On a phone, the Connect box on the welcome and account pages now says which apps are added on a computer and offers Kazi or "Send me the setup" under each, as /connect does, instead of only computer steps and terminal commands.

## 0.45.8

### Patch Changes

- 6ee9bde: Opening the server address (https://api.cuttingfloor.ai/mcp) in a browser shows a page that says it goes in your AI app, with a Copy button and a link to the setup steps, instead of a JSON sign-in error. Apps still get the same sign-in challenge. Requests sent while the server restarts for a release now wait for it instead of failing.

## 0.45.7

### Patch Changes

- 8889171: Phones keep the Connect and Account links on the signed-in pages. They were hidden below 900px, so the only way between the two pages was through the home page.

## 0.45.6

### Patch Changes

- fdfefbd: The note about the sign-in warning now shows on every desktop and terminal app's setup (Cursor, VS Code, Zed, Goose and Antigravity too), and "What does this mean?" opens its own page, /sign-in-warning, instead of a section every visitor to /connect saw.

## 0.45.5

### Patch Changes

- 55da0d3: The Codex and Claude Code setup now says up front that the sign-in page warns about an app on your computer, and that clicking Allow access is expected, with a "What does this mean?" link to an explainer on /connect. Codex's copy line now runs the sign-in too.

## 0.45.4

### Patch Changes

- e19475c: An account's first-use marks no longer erase each other: an app's first request recorded its name and the first call at once, and one could wipe the other, leaving the welcome page waiting on an account that had connected. The first tool call that runs is now recorded on its own (`first_tool_at`).

## 0.45.3

### Patch Changes

- 80db4f6: Being a Kazi member no longer gives lifetime on cuttingfloor: a Kazi account starts with the same free credits as any other. Accounts that carry the lifetime plan tag keep it.

## 0.45.2

### Patch Changes

- acdb403: The pricing, connect and Kazi pages no longer say an account connected from Kazi is free for good, and free accounts can export in 4K like any other (the 1080p cap is gone).

## 0.45.1

### Patch Changes

- 42d7aba: Every sign-up email now says the account's credits as they stand: the welcome, both follow-ups and the credits reminder (free credits left, or this month's for a plan given by the month).

## 0.45.0

### Minor Changes

- e70615d: The hosted server renders motion graphics and stills in a fresh sandbox for every render, up to 5 at once on its 8 cores, instead of one shared sandbox rendering one at a time for everyone. A render that crashes its sandbox fails only itself, and nothing one render leaves behind reaches the next. A new `cuttingfloor motion-launcher` starts each gVisor sandbox and removes it after, sized from the machine's cores and memory. Exports, imports and analysis run 5 at once (was 3).

## 0.44.1

### Patch Changes

- b5e3770: A media made by create.\* is said to be usable in edits once its job completes (an import once it is processing), so agents stop sending edits before a render is done. An edit naming several media that are not in yet is refused once, naming every one with the job making it, and the hint waits on all of them with one job.get {job_ids}.

## 0.44.0

### Minor Changes

- 7f5909b: Jobs at once is no longer a plan feature: every hosted account runs up to 4 jobs at once (free accounts ran one at a time), a cap that keeps one account's burst from filling the queues everyone shares. Credits are the only free-plan limit; pricing, the account page and account.get no longer list jobs at once.

## 0.43.1

### Patch Changes

- 9838d20: The tools say plainly that cuttingfloor is a place to work, not storage: when a user counts on something staying, the agent tells them it goes on its own and offers to save finished work where they keep their files.

## 0.43.0

### Minor Changes

- 518764d: Partners can delete a user's account (`DELETE /partner/users {email, sub}`, with the partner's secret): when someone deletes their account in the Kazi or Cutting Floor AI app, their cuttingfloor account goes too, found by email or by the partner's user id, with its timelines, media, jobs, outputs, uploads, script keys and WorkOS sign-in. It answers `{deleted: true}`, or 404 `account_not_found` when there is none.

## 0.42.0

### Minor Changes

- 08c9fbe: A week after signing up, an account with credits left gets "Your cuttingfloor credits are waiting": its balance, the AI app it connected to pick up in (or Kazi, for accounts with no AI app of their own), and the MCP and OpenAPI routes for engineers.
- 751865e: Lifetime for Kazi members comes from the shared ledger: an account Kazi calls unmetered (Kazi lifetime or staff) has cuttingfloor's lifetime, 900 credits a month, and never spends from the ledger. Using cuttingfloor through Kazi, or a key Kazi's app asks for, no longer gives lifetime by itself; accounts tagged before keep it. `CUTTINGFLOOR_LIFETIME_CLIENTS` is no longer read.
- 13cc62c: Credits are shared with Kazi: one balance in Kazi's credit ledger, bought and spent on either product. Each account carries over the balance it had, every job is spent there once, and automatic top-up runs in the ledger.

## 0.41.0

### Minor Changes

- 68eb90f: Partners can get a key for each of their users (`POST /partner/keys`): the Cutting Floor AI app reaches cuttingfloor through the user's own account, found by email or made for them, without a separate sign-in.

## 0.40.1

### Patch Changes

- 1c3556d: Importing a file that is already in the account (the same URL fetched again, the same upload sent twice) no longer conforms and proxies it again: the new media shares the first one's files, previews and analyses, takes no extra storage, and either can be deleted on its own.

## 0.40.0

### Minor Changes

- f9cb24a: clip.set_transform takes `corners`: pin a picture's four corners to four points in the frame (a screen, sign or page seen at an angle), keyframable like the other fields. Crop, masks, flip and opacity still apply, and the result's placements report the corners.

## 0.39.0

### Minor Changes

- 0a02b63: New accounts start with 25 free credits (was 10), and sign-up buttons say what that buys: about 30 minutes of footage.

## 0.38.2

### Patch Changes

- 206a23c: The new cuttingfloor mark (two triangles, a cut) on the site, the signed-in pages and the file library widget.

## 0.38.1

### Patch Changes

- 490ed8a: A new How to connect page (/how-to-connect): AI apps for creators (Kazi, ChatGPT, Claude Cowork, Codex, any MCP app) and, for engineers and builders, the REST API and MCP with an API key, with an animated picture of the three ways in. The account page's key section is now API keys, for REST and MCP.

## 0.38.0

### Minor Changes

- 729d365: Every tool is now plain HTTP too: `POST /v1/<tool>` with the tool's arguments as JSON and an account key (`cf_…`) answers its result, through the same server as `/mcp`, and `/openapi.json` describes every tool as OpenAPI 3.1.

## 0.37.4

### Patch Changes

- e049268: The sync-video-to-music skill is gone: syncing a video to music is a plain ask your AI handles with the tools, so it needs no step-by-step guide.

## 0.37.3

### Patch Changes

- 6691e8d: New skill, sync-video-to-music: how your AI cuts a video to a song (shots change on the beat or the bar, the end lands on the last hit), fits a song to a finished video (trimmed on whole bars, ending on a hit, faded out) and turns the music down while someone speaks. `skills.search` finds it for "sync video to music", "cut to the beat" and "fit music to video".

## 0.37.2

### Patch Changes

- c84fb9f: Clearer words for creators. At 0 credits the AI and the emails now say what really happens: new jobs (exports, imports, analysis) won't start until there are credits again, while editing and previews keep working. The welcome email gives the real number of free credits a new account starts with (10). Getting a file in leads with the upload link (open it on your phone or computer and pick the file), and the upload page shows sizes in MB or GB and says to go back to the chat once a file is sent. The share link says how long it works, and the AI is told to have you download what you want to keep. The in-chat views say "Your files", "Ask in the chat" and "Sent to the chat" instead of tool names. Messages the AI reads no longer point at the account page: an unverified email goes to the verification email, and the export size limit names the size and the pricing page.

## 0.37.1

### Patch Changes

- b5eb247: While the ChatGPT plugin is in review, `account.get` is off the tool list, and refusals about credits or a plan's room link the pricing page instead of the account page where credits are bought.

## 0.37.0

### Minor Changes

- 3ba815c: Credits only, pay as you go: subscriptions are gone. New accounts start with 10 free credits (accounts made before November 8, 2026 keep their 100), then buy packs ($5 for 25 credits up to $100 for 700) that never expire, in one click on a saved card or automatically when credits run low. Emails go out when credits run low and run out. New tool `account.get` returns the account's credits, warnings, top-up and the account page link. The account page shows credits left and puts uploading files right under them; uploads are counted on the site.

## 0.36.1

### Patch Changes

- fa07a4d: Account email (credits running low, a failed payment) comes from the same person as the sign-up emails when `CUTTINGFLOOR_EMAIL_FROM` and `CUTTINGFLOOR_EMAIL_REPLY_TO` are set, instead of support@.

## 0.36.0

### Minor Changes

- ce84b95: New accounts on the hosted server get a welcome email within a minute of signing up, then one follow-up a few days later: "Did it work?" if they haven't finished a first edit, "How was the first edit?" if they have. Every message has a one-click unsubscribe.

## 0.35.0

### Minor Changes

- a920a0e: The 3-day trial is now 100 free credits with no time limit. A credit is one render minute; editing and previews stay free, and every plan has every tool. Free accounts keep working after day 3, refusals and emails speak in credits, and pricing.json moves to schema `cuttingfloor.pricing/2` (`credits` replaces `render_minutes`; the `trial` plan is now `free`).

## 0.34.12

### Patch Changes

- 9e0bf32: media.analyze is marked as able to replace data: a run replaces the result of that kind stored with the media.

## 0.34.11

### Patch Changes

- 0538d28: Tool hints match what the tools do for the ChatGPT directory review: export.video and export.timeline are marked as able to replace a file, qa.check, media.seek, media.listen and media.correlate are no longer marked read-only (a long run queues a job), and judge.ask is titled "Ask questions about text or pictures".

## 0.34.10

### Patch Changes

- 63c2513: The player and editor views keep checking on an export through a dropped connection (a chat tab left in the background, a network blip) for about a minute before they show an error, and a chat opened again later says it is checking instead of showing old progress.

## 0.34.9

### Patch Changes

- 4781a0c: Demo pages link from the top down to the full editing journey: Before, your agent edits, After.

## 0.34.8

### Patch Changes

- 306e64b: Site: the /demos live demo shows the end of a real Kazi run, and says it takes a few minutes.

## 0.34.7

### Patch Changes

- 35997b8: Site: /demos opens on the live demo. One click starts Kazi in the browser, free and with no sign-up, giving Big Buck Bunny a happy ending on cuttingfloor; an example of the result loops beside it. The creators' before-and-after demos follow.

## 0.34.6

### Patch Changes

- 1df3ac2: Site: "Try it live in Kazi, free" opens Kazi's share link for each page, a guest chat that edits a sample clip on cuttingfloor while you watch. No more copying a message to paste.

## 0.34.5

### Patch Changes

- 2304787: Site: a "Try it live in Kazi, free" link on the homepage, Compare, every demo page (the demo's own edit), Welcome and Account. Each link carries `ref=cuttingfloor`, the page it came from and the first message, and copies that message on click.

## 0.34.4

### Patch Changes

- a61b6e6: Each demo page opens on the result: the finished video, playing and bigger, with the raw clip beside it labelled Before, on the first screen on phones and laptops. The step-by-step before, edit and after still follow.

## 0.34.3

### Patch Changes

- b5cf8a8: Views name their sandbox origin for ChatGPT, plan refusals point to the plans page, and the server can serve OpenAI's domain verification token.

## 0.34.2

### Patch Changes

- 44ba276: Refusals for an ended trial, used-up minutes or full storage now state the account's plan, its renewal date and where the account page is, without suggesting an upgrade.

## 0.34.1

### Patch Changes

- a4d23e0: Paying accounts are always let in: a yearly plan's render minutes renew every month instead of once a year, and a subscription counts even when the account's email shows unverified.

## 0.34.0

### Minor Changes

- a1cd633: Skills credit their author: `skills.get` returns `author` and `author_url`, and every skill page on the site shows them. make-motion-graphics is by Sanji Nai-Chien, linked to his video, and now asks the user before it is used.

## 0.33.0

### Minor Changes

- b15980d: New skill, make-motion-graphics: how to make a motion graphics video like a professional, from brief and storyboard through per-scene animation, assembly, music and cutdowns. The storyboard skill now writes on screen, motion, camera and length for every beat, gives each beat a story job, and works from a brief when there is no voice.

## 0.32.1

### Patch Changes

- e82804e: Editor: the picture always shows whole in a host panel (a tall video no longer shows only its top), and the bar under the picture drags it taller or shorter again, also in a fixed-height panel, where the editor below scrolls with the header pinned.

## 0.32.0

### Minor Changes

- 8d65f24: The editor view always shows the whole picture: in a frame the chat app sizes or caps, the timeline stays short and scrolls instead of pushing the picture out of view. "Hide editor" (or E) folds the timeline and inspector away and leaves the picture, its play controls and a seek bar; "Show editor" brings them back.

## 0.31.0

### Minor Changes

- 7f2f9e9: The editor view gets a divider under the picture: drag it to give the picture or the timeline more room (double-click puts it back). "Hide editor" (or E) folds the timeline and inspector away and leaves the picture, its play controls and a seek bar.
- 757da88: media.list results show the library: everything on the floor in a cuttingfloor-branded list (kind, length, size, where it came from, when it goes), with filters, a name search and storage used. Pick one to preview it (video and audio play, images and fonts show); Use in chat hands the pick to the agent, and files sent but not imported yet can be passed on for import.

## 0.30.0

### Minor Changes

- 5d97feb: export.video now opens an editor in chat apps that show MCP Apps views, in place of the plain player:

  - The export plays over the timeline it was rendered from: every track and clip, transitions, volume lines and fades, and the mix measured from the file's own sound.
  - Scrub on the ruler or the tracks (hold Shift to snap to cuts), step by frame or by second, jump between cuts, loop a stretch, zoom, and read every clip's details, everything playing under the playhead, and the caption words.
  - The timeline is there before the export finishes, and a strip names the edit that made this version and outlines what it changed.
  - Where the chat app allows it, your agent knows where you stopped and which clip you selected, though nothing is sent while you scrub. Send to agent writes a note into the chat with that moment attached.
  - Signed export links can now be read from other sites (CORS), so the view can measure the sound.

  media.get keeps the player.

## 0.29.3

### Patch Changes

- a20c0b8: Fixes for fills and in-between frames:

  - A cancelled or failed fill or in-between job no longer stays attached to its clip: the next render starts a new one.
  - An export waiting for a fill or in-between job now gives up its job slot until that work is done, so it no longer holds up other jobs.
  - job.get wait_seconds now answers when a job finishes, fails or is cancelled (or when the wait runs out), not at each step of progress.
  - render.frames no longer shows an earlier frame in place of the last frames of a clip whose in-between copy ends with the media.
  - A fill on a clip cut from the middle of a file whose frame rate is odd or varies now covers the clip's first frames.
  - media.analyze on a stretch of a timeline only waits for copies of the clips in that stretch, as render.frames does.
  - A fill's level follows the picture around it in each frame, which makes it blend in better during a flash.

## 0.29.2

### Patch Changes

- 95e428f: In-between frames (clip.set_speed interpolate) are now a job of their own, like fills. They show in job.list with progress per frame, an export waits for them without being stopped as stalled, and render.frames answers media_not_ready naming the job instead of timing out. A render only waits on copies for clips at the frames it shows. A fill or an in-between copy is now made once per clip, whatever size it is shown at. A not-ready answer gives the job's place in the queue or its measured time left, not a guess. A fill also reuses the real picture from earlier frames where the area showed, and the description says what follows: something that never moves against its background leaves a smudge. A slowed clip no longer shows its first frame twice. A stalled export now says that copies it had finished are kept for the next try.

## 0.29.1

### Patch Changes

- b5e4f3f: Fill fixes. A fill is now a job of its own, shown in job.list with its progress per frame; an export waits for it without being ended as stalled, and a render that needs it names the job. render.frames no longer waits on fills of clips that are not at its frames. A filled item no longer shows through as a ghost: a fill paints over the whole selection, its soft edge included, and grows a little past it. A mask takes several shapes (add), so two regions are shown, hidden or filled in one pass. Refusals of a fill on a nested clip say why.

## 0.29.0

### Minor Changes

- ded0ed9: Captions and titles: style `max_lines` shows long text a screenful at a time, each from its first word, with its lines broken by the font's own widths and balanced; `spans` style part of a text (a word in another colour, bold, italic, underlined or sized) on `title.add`, `caption.add` segments and `text.set`. `clip.set_animation` loops take `from_frame` and `to_frame`, so a shake can run for part of a clip. The `compressor` effect takes `attack_ms` and `release_ms` (FFmpeg's 20 ms and 250 ms by default, as before). `media.import {source: {still: {media_id | timeline_id, frame}}}` makes one frame of a video or an edit into a full-size PNG still. `job.get {job_ids}` sums each result up (`result_summary`) unless asked for `result: "full"`; one `job_id` still answers whole. Video `denoise` now visibly takes grain out, frame by frame (FFmpeg fftdnoiz, so a preview matches the export): `strength` is the noise level in 8-bit levels, 0 to 50, default 4 (it was hqdn3d, 0 to 10, default 3, which barely changed a frame). Transcript words say that a "-" word is whisper marking a new speaker.

### Patch Changes

- 5875c5f: clip.set_speed interpolate (blend or motion) now plays the right moment through the whole clip: the slowed copy used to stop a fraction of the way through its source, so later frames showed the wrong footage, white or black. Copies made before are made again.

## 0.28.0

### Minor Changes

- 1316e4e: Jobs no longer hold the server when they stall, and agents can wait for them and find them. A running job whose progress stops for its stall limit (`CUTTINGFLOOR_STALL_SECONDS`, default 300, longer for long media) ends with a `stalled` error and frees its slot; `job.cancel` stops a job within seconds, killing its engine's whole process group. Work queues by the resource it holds: `create.stabilized` no longer waits in the heavy-model slot, and lip sync, seek and look wait in a lane of their own. One extra slot (`CUTTINGFLOOR_SHORT_JOBS`) is kept for short jobs (up to `CUTTINGFLOOR_SHORT_JOB_SECONDS` of media), so an 8 s transcript doesn't wait behind long ones. `job.get` takes `wait_seconds` (up to 50) and answers as soon as a job moves, gives `seconds_left` and `starts_in_seconds` when progress allows, and `result: summary` cuts long lists. Every job names what it is `for` (media, timeline, kind, preset). `job.list` filters by `tool` and `media_id`, and now leaves results out by default (`result: summary` or `full` to include them). `media.get` names the job importing or making the media, and `media_not_ready` hints say to wait for it with `wait_seconds`. Transcripts report progress as whisper runs.
- 8a4a3f5: New measured facts, no verdicts. media.analyze speakers says who speaks when (sherpa-onnx: pyannote segmentation 3.0 and 3D-Speaker ERes2Net, on the CPU), and each transcript word then carries its speaker. voice gives pitch, level and pace over a stretch, with a summary to hand judge.ask. colour gives per-channel means and percentiles, luma, a white point estimate and clipping for whole frames and named regions; picture gives every frame's signalstats, ydif (change from the frame before) included. beats now carry each beat's onset strength, and transcript takes from_seconds and until_seconds. The picture kinds (faces, track, look, scenes, colour, picture) take a timeline_id and read the edit as it renders; judge.ask takes {timeline_id, at_seconds} pictures. Boxes you give can be in pixels (units: "pixels"). clip.set_transform, set_mask and set_animation (and edit.batch) return placements: where each clip now shows in sequence pixels and which source pixels show there. media.get gives the import fingerprint; export.video gives the render's SHA-256 and the same fingerprint.
- ae538ed: Picture over time and sound: clip.set_speed interpolate (blend or motion in-between frames) and a warning when a clip repeats frames; create.upscaled (Real-ESRGAN super-resolution); lens_correction, directional_blur, channels and dereverb effects; each channel's levels in the loudness facts.
- ca6987b: clip.replace now swaps the clip's linked clips too (its sound, or its picture) onto the new media, keeping their offset, so a replaced shot's sound no longer stays on the old file. Default change: pass `linked: false` to swap only the clip named. When the new media lacks that kind (no sound), the linked clip stays and a warning says so; `clip_ids` lists every clip swapped.
- 306cebd: Select, then act on the selection. create.cutout takes a region (a box and/or points at a moment) and follows that one item's exact outline through the video (EdgeTAM). clip.set_mask takes a matte (any media's alpha, such as that cut-out) as its selection, polygon points that take keyframes, and a mode: show, hide, or fill, which paints the selection over from its surroundings in every frame (LaMa).
- dc58b65: media.get gives `sound_seconds` (how long the sound runs), so a sound track that stops before the picture (under `duration_seconds`) shows as a fact. media.analyze silence counts the soundless end as silence and says where the sound stops (`sound_ends`); before, it reported no silence at all where the track simply ended.

### Patch Changes

- 9357cb4: clip.add of sound alone (music, a voiceover, audio-only media) now previews as the waveform of the added span with its measured loudness, as audio edits do, instead of a black frame.
- b1baf1d: Tool descriptions say what the tools actually do: mask coordinates are fractions of the clip's fitted frame (a sequence-shaped box with the picture fitted inside), not of the picture itself; face boxes are top-left corner plus size; a keyframe's ease shapes the move from it to the next; chroma_key tolerance compares colour alone; fit cover crops equally on both sides around x, y; effects run in order; denoise is a picture effect; only some effect numbers take keyframes; clip.add {words} adds no padding; only inline previews carry loudness; captions wrap at max_width and each highlight mode is described; scenes threshold and transcript model cost have guidance; qa.check no longer promises an instant answer under load; nesting a timeline makes overlays follow a zoom. The server instructions now say edits take media while it is processing but media.analyze, media.seek, judge.ask and create.\* need it ready, and those refusals say the media's status instead of "still importing". media.get warns when it is asked to include an analysis that was never run.
- c94a7bc: render.frames of a media that is still importing says so and names its import job, instead of "has no picture".
- 75246e5: media.listen says what it can't hear: its model learned everyday sound events, so inside music it hears "music", not drums, instruments or single hits (on a drum bed "music" scores 1 and every drum query 0). The description and the result's new `note` say so and point to media.analyze beats and create.stems; the description also says a short sound can score higher listened to over a short range around it.
- 576683a: Frame renders no longer fail on a busy server with "melt rendered 0 of 1 frames" (or hang until the render times out). The cause was a race in MLT 7.30's avformat consumer, which started its encoder thread before marking itself running; the image now carries MLT's avformat module rebuilt from the same release with that fixed.
- b5970c5: A nested timeline now renders inside another exactly as it does alone. Its picture and its linked sound were played from one shared renderer, which dropped inner scale and crop and lost overlay tracks; each use now has its own.
- 340924a: media_not_ready errors name the job making the media (the media.import job, or the create.\* job that makes it) with its job_id, in the message, the hint and the detail, so the caller waits on the right job with job.get. Before, media made by create.motion was said to wait for "its media.import job".
- ecdd7e6: transition.add in overlap mode no longer names the clip's own linked sound as playing late: it stays in sync. The warning says instead that it keeps its length and runs past the shortened picture, so it can be trimmed to match.
- efb5a39: Inline previews and render.frames try melt once more when it ends without all its frames (it did on a loaded server, where render.frames of the same timeline then worked), and when frames still don't come the error says what melt logged.
- a0f454a: Refusals name what is valid instead of pointing at a catalogue many clients can't read: an unknown effect lists every video and audio effect, a wrong or out-of-range effect param lists that effect's params with ranges, units, defaults and which take keyframes, an unknown ease lists every ease, a preset override it doesn't take lists what each preset takes, and an unknown sound name lists every name. filter.add's name and keyframe eases are enums in the input schema. timeline.get shows every effect param as applied, defaults included.
- e5dbcdb: Results say when a default did something easy to miss. range.lift and range.extract name the track each removed clip was on and warn when the sound under a picture range went too; timeline.set_sequence warns how many clips no longer fill the frame; export.timeline with media reference warns that the file points at media this server keeps (unreachable from another machine, gone 7 days after last use) and suggests media: collect; create.motion over its pixel budget is refused with the largest size that fits at that length and rate, and the longest length at that size; media.seek says sampling can't prove a one-frame defect absent; media.correlate adds `placement`, the offset as where to put b's clip in plain words.
- 9e6d8da: media.analyze scenes says what its threshold measures: hard cuts between ordinary shots score about 10 to 30 (threshold 30 found none of the cuts in a 50 s piece whose cuts scored 14 to 25), and the result's new `scene_scores` give each cut's score.
- 3300eb1: Media whose frame rates drift apart by a fraction of a percent (screen and game recorders), whose frame count doesn't fit its length, or whose rate isn't a standard one is now conformed to a constant rate on import (conform `vfr`), so its fps and frame numbers are true. Before, a 20.36 fps recording was called 20 fps without being retimed.
- 4819a29: .woff and .woff2 fonts import: they are unpacked on import to the .ttf or .otf they hold and used as that (kind font, with its family), so font_media_id sets text in them. Before, they failed as "not a readable media file".

## 0.27.6

### Patch Changes

- f2db653: create.motion and create.still no longer refuse a page because a URL or `fetch(` appears in its script text (a bundled library's warning strings, code that never runs). The early check now refuses only what the browser would load from the network: element attributes such as src, href, srcset and poster, CSS url() and @import, and a meta refresh, with the URL and where it is in the error. Scripts that reach for the network at run time are still blocked by the sandbox, WebSockets to loopback included.
- 9c13a4b: create.motion and create.still say what went wrong in a page: the result's `warnings` (kept with the media, so media.get and a repeated recipe show them too) list uncaught errors and syntax errors with where they happened, console errors, files that were blocked or not found, fonts that failed to load, and tags never closed or CSS showing as text. Each problem is listed once with how often it happened, up to 20. The page still renders.
- 3bf9c93: create.motion and create.still seed `crypto.getRandomValues` (and `crypto.randomUUID` where the page has it) from the same seed as `Math.random`, so a page that draws its randomness from crypto renders the same every time.

## 0.27.5

### Patch Changes

- b789535: The site speaks to agents: every page has a Markdown version at its address plus `.md` (and for `Accept: text/markdown`), llms.txt is rewritten for agents with llms-full.txt beside it, `/.well-known/ai-catalog.json` points to the MCP server card, and robots.txt names the AI crawlers it welcomes.
- 253c15b: Tool hints are now pinned by a test, so agents in Claude Cowork and ChatGPT keep running the read-only tools (looking at a timeline, frames, media, jobs, skills) without asking for approval. Cancelling a job, and exporting where an export may replace a file in your exports folder, are now marked as destructive, so clients can ask before them.

## 0.27.4

### Patch Changes

- 753769a: Licensed under AGPL-3.0.

## 0.27.3

### Patch Changes

- 540ec43: New /alternatives page for people coming from CapCut, Descript, VEED and other editing software: you bring the taste, your agent does the editing.

## 0.27.2

### Patch Changes

- 456b7f9: The site records which links and buttons people click, and sign-ups and sign-ins, in Web Analytics; a daily check fails if the analytics script stops loading.

## 0.27.1

### Patch Changes

- b558eda: The Server Card lists 2026-07-28 among the protocol versions /mcp supports, matching `server/discover`.

## 0.27.0

### Minor Changes

- a86d897: Clients can discover cuttingfloor before signing in: a public Server Card at `/mcp/server-card` (listed in `/.well-known/ai-catalog.json`), and `initialize`, `server/discover`, `tools/list` and the resource and prompt lists answer without a token, the same for every account. Tool calls and reads still need sign-in and get the usual OAuth challenge.

## 0.26.0

### Minor Changes

- e62fca3: Accounts used through a client named in `CUTTINGFLOOR_LIFETIME_CLIENTS` (Kazi's two OAuth clients) get lifetime on their first call. It is tagged in WorkOS with its reason and date (`plan_reason: "via Kazi"`, `plan_since`), so exactly those accounts can be found and undone later. Accounts that already have a plan given or bought are left as they are, and usage keeps being metered.
- ac0a95a: Save your sync. labs key once on the account page, and create.lipsync uses it from any client: no header needed. The key is stored only as ciphertext in your account, never shown again (just its last four characters), and can be removed there. A key sent in `X-Cuttingfloor-Key-Sync` still comes first. Without either, create.lipsync's error links to the page (`detail.keys_url`).

## 0.25.0

### Minor Changes

- 18dbd25: Pictures that can be see-through (alpha or a palette) show over a light checkerboard wherever they are looked at: render.frames of a media, its frames resource, the stills judge.ask, media.analyze look and media.seek read, the watch page and the player. Transparency shows as checks; a background baked into the file shows as itself.
- 9164b79: **`create.stabilized`: steady shaky video.** A new long-running tool makes a steadied copy of video media with vid.stab (one pass measures the camera shake, a second moves each frame against a smoothed path), as new ProRes media with the sound, ready for `clip.replace`. Options: `shakiness`, `smoothing`, `tripod`, and `edges` (zoom, adaptive zoom, black or kept edges).
- ead6ce7: **Rippling edits keep other tracks in sync on request.** `clip.trim` and `clip.remove` with ripple, `clip.move`, `clip.add` with `mode: "insert"`, `clip.set_speed` and `clip.freeze` moved later clips on the clip's own tracks only, leaving titles, overlays and sound on other tracks early or late with no word. Their results now warn which clips on other tracks no longer line up, and `other_tracks: "sync"` gives the other unlocked tracks the same change: time taken out comes out of them too (like `range.extract`), time added opens the same gap. `range.extract` on named tracks warns about the rest.
- 46e26d7: **Breaking:** `code.run` and the script SDK (`import { cf } from 'cuttingfloor'`, the Python module and the `cf` command) are gone. cuttingfloor is a plain MCP server: every tool declares its full output schema, and how to call them, one at a time or from the assistant's own code, is the client's choice. Running MCP servers from code is a client's job. `create.motion` and `create.still` work as before in the same sandbox. The image no longer carries Python, numpy, Pillow or OpenCV for scripts.
- c709b0e: A render imported as media (`media.import {source: {job_id}}`) says where each stretch of it comes from: `origin.sources` lists, per track and span of the file, the media and source range (and speed change) it plays, read from the timeline when it was exported, so it outlives the 24 h timeline.
- c9e9c6f: `media.import {source: {upload: {name, bytes}}}` hands back the new media with a signed `upload.url`: PUT the file there (resumable, like `media.upload`) and it imports as soon as the last byte arrives, so a file made elsewhere reaches the server in one call and a PUT, with no base64 in a message. The PUT's answer carries the `media_id` and `job_id`. Size limits and storage caps apply as for any upload.
- 94ad9a3: `job.get` reads many jobs in one call: `{job_ids: [...]}` (up to 100) answers `{jobs, not_found}`, so an assistant following several imports or renders checks them all at once. `{job_id}` still answers that one job, as before.
- cdb2a05: `create.lipsync`: make someone on camera say new words. Give the video, the new speech and the span to change; sync. labs redraws the mouth on your own key (`SYNC_API_KEY` locally, the `X-Cuttingfloor-Key-Sync` header hosted). Only the span is sent, the result imports as new media, and the provider's limits come back as facts in errors. Hosted servers now read provider keys from `X-Cuttingfloor-Key-<Provider>` request headers, never storing them.
- d7a9912: `media.delete` removes a media for good (its file, proxy, mezzanine and analyses), giving its room back to the storage cap. Timelines that used it keep their ids but no longer render, failing with `media_offline` that names it, as for expired media; cached previews of them are refused too.
- c16b875: Media is kept under the extension its format takes, read from the file (a PNG sent as .svg, or downloaded with no extension, is kept and downloaded as .png). Every media result gives `extension` and `mime_type`, and `media.get` gives `probe`: everything FFprobe read, the format and every stream as it gives them.
- 64f01a1: `media.get` reads long analyses in pieces: with `include`, `from_seconds` and `to_seconds` keep what overlaps that stretch of the media (transcript words, beats, face and look frames), `offset` and `limit` page through it, and `pages` says where each piece sits in the whole list (for transcript words, the index `clip.add source {words}` takes) and where the next page starts. A `media.analyze` result too long to return now says how to page it.
- c063b1b: A media lookup that finds nothing says why: deleted with media.delete (and when), expired 7 days after last use (and when), held by another account, or not an id this server has had. `detail.reason` carries it.
- d7a9912: `media.get` and `media.list` say where each media came from (`origin`): the URL (without its query), path or upload (sent through media.upload, the account page or a data: URI) it was imported from, the export of which timeline and preset, or the create.\* tool, its job and the media it was made from. `media.get` also gives `created_at`.
- e6164f4: Keys for scripts: the account page makes keys (`cf_…`) that a script sends as `Authorization: Bearer` to `/mcp`, with no browser sign-in. A key acts as its account, with the same trial and plan checks, works for a year or until revoked on the same page, and is shown once; the server keeps only its SHA-256.
- 071b0e8: media.listen and media.analyze sounds also read an edit: give timeline_id and they listen to its mix as it plays, so a laugh, a clap or a door comes back where it sits on the timeline (timeline seconds, and timeline frames for render.frames). Both take from_seconds and until_seconds on media and timelines; a sounds run over the whole media is still kept with it.
- c1d762b: Sounds, heard on the CPU with no provider. `media.analyze {kind: "sounds"}` says when each of 447 named sounds (laughter, applause, cough, sneeze, music, speech, door…) can be heard, every 40 ms, at the cut-off the assistant gives; the names are in `video://catalog/sounds`. `media.listen` finds sounds described in plain words ("people laughing", "a door slams") and returns the stretches where each is heard, with every score. `create.stems` separates the sound of any media into vocals, drums, bass, other and no_vocals, each new audio media. Models: PretrainedSED frame_mn10, FlexSED with the CLAP text encoder, and Demucs v4, all MIT or Apache-2.0, exported to ONNX in the image.
- 9e38df7: Speech and sound facts. `media.analyze` gains `speech` (Silero VAD: speech probability every 32 ms, spans at your `min_probability`) and `loudness` (integrated LUFS, true peak, loudness range, RMS, noise floor), over a range. `speech`, `loudness` and `silence` also measure a timeline's mix (`timeline_id` plus a range, in timeline seconds). English transcript words are now aligned to the sound with wav2vec2 forced alignment (edges within about 0.05 s, with `timing_confidence` per word), so `clip.add {source: {words}}`, captions and voiceover words land on the speech. New `media.correlate` gives the sync offset of one recording against another, with its strength. `qa.check {speech}` lists every cut with the speech either side, the silence each side, and the transcript word each clip edge cuts through. A source or range with no sound fails with the new `no_audio` error naming it.
- b0df171: **`voice_denoise`: clean background noise out of speech.** A new audio effect runs RNNoise (FFmpeg `arnndn`) over an audio clip's source: fans, hum, traffic, keyboards and room noise go, the voice stays (`keep: "voice"` keeps laughs and breaths, `"speech"` words only; `mix` blends the original back). It goes on audio clips, not tracks or the timeline: the first render that plays the clip cleans its whole source once and reuses that after. The models ship in the image, pinned by SHA-256.

### Patch Changes

- e243ff4: Watch-page and download links from a finished job work again when the job is read later: `job.get`, `job.list`, `tasks/get` and the job resource sign them afresh instead of handing back the links the job was made with, which stopped working a day after it finished while its file lived on. An expired link now says so and where to get a fresh one.
- 4582985: The server instructions and the timeline, media and export descriptions say plainly what the server keeps (timelines 24 h, media and exports 7 days after last use) and that the client keeps the rest: save the timeline.get document and timeline.load it, save files from their download url and media.import them again.
- e6dfd71: The cut-pauses-ums-and-restarts skill uses tools only: speech bursts from `media.analyze {kind: "silence"}`, words read in pieces with `media.get`, filler marked with `judge.ask`, and every take followed with one `job.get {job_ids}`.
- 26cfeab: `media.analyze track` and `clip.set_transform` now say how track boxes become transform keyframes, so an overlay can follow a subject without tracking of your own.

## 0.24.0

### Minor Changes

- f63533a: `job.get` answers at once with where a job stands; its `wait_seconds` hold is gone, and the hints no longer tell the assistant to wait 50 seconds. When to check again is the assistant's call. Clients that still send `wait_seconds` are unaffected: it is ignored.

## 0.23.0

### Minor Changes

- 1576abe: Drop files on the account page: people whose agent can't reach a file on their computer drop it at cuttingfloor.ai/account, and it goes straight to the server, resuming after a dropped connection. The new `media.list` tool shows the agent what the user has (imported media, files sent but not imported yet, and the storage used), so it finds a dropped file by name and imports it. Each plan now caps storage held at once (Trial 5 GB, Creator 50 GB, Pro 200 GB, Enterprise 1 TB): uploads, URL imports and render imports past the cap are refused with what to do, and the account page shows storage beside render minutes.

## 0.22.1

### Patch Changes

- c326e4d: **A proper in-chat player.** The player that shows `export.video` and `media.get` results in MCP Apps clients is rebuilt. It has its own controls: a scrubber that previews the frame under the pointer, 5-second skips, frame-by-frame stepping, a switch to timecode, speed, loop, volume, picture in picture, full screen and the usual keyboard keys. While an export runs, the whole frame shows a progress ring with the percentage and elapsed time instead of a line of text. A soft glow from the video fills the bars beside portrait video. Under the picture are the file's size, length, frame rate and when its link expires, with Copy link, Open and Download. The card paints its own background, so its text reads in light and dark chats.

## 0.22.0

### Minor Changes

- 55e3b5c: **Overlap transitions keep other tracks in sync on request.** An overlap transition moves later clips on its own track earlier. `transition.add` now warns which clips on other tracks are left playing late, and `other_tracks: "extract"` takes the same span out of the other tracks (like `range.extract`) so titles, overlays and sound stay in sync with the picture.
- 8b30d24: **Share and show exports.** `export.video` and `media.get` now return a `page_url`: a page that plays the file in any browser with no sign-in, to give a person to watch or share. It lasts as long as the signed download (24 hours by default). In clients that support MCP Apps, `export.video` and `media.get` results also play in the chat: the player follows a running export and plays it when it's done.

### Patch Changes

- 9b46980: Clearer tool descriptions: `media.import` says a URL only has to work until the import starts (a short-lived signed link is enough) and that edits needn't wait for imports to finish; `code.run` says plainly why `create.motion` and `create.still` are called as `motion()` and `still()` inside a script.
- adb7dc1: **Text styles are never decided out of sight.** `video://catalog/text` publishes the exact default style for titles and captions, `title.add` and `caption.add` say what it is, and `timeline.get` shows each title's and caption's full style as it renders.

## 0.21.0

### Minor Changes

- 9bf7c5f: **media.seek: seek by natural language.** Say what you're looking for in plain words and get back where it shows, without watching the whole video. Each criterion is a statement about the picture, such as "the faces are too dark to make out their eyes", "the product dashboard fills the screen" or "the picture is black". Seek judges sampled frames with TypeSafe Jev and returns, for each criterion, the stretches where it holds, with the time, frame number and picture of the best frame in each. It also returns every frame's probability. It works on imported media and on an edit as it renders (`timeline_id`), so gaps, titles and effects are checked too. Uses: checking quality, finding where something starts, picking shots and thumbnails, spotting changes (`with_previous`) and finding room for overlays. Criteria take Jev's yes/no form, `{instructions, criteria: {true, false}}`, to say what counts. `media.analyze {kind: "look"}` remains for typed measurements on every frame.

## 0.20.2

### Patch Changes

- 985914c: A job cancelled from another server always stops: the running server's own heartbeat could write over the cancel and keep it running.

## 0.20.1

### Patch Changes

- 3a9d1cc: A job no longer misses a cancel, or ends "interrupted" while still running, after two writes to its record landed in the same millisecond.

## 0.20.0

### Minor Changes

- 63bf48b: Hosted plans are enforced as sold. Each plan's render minutes are counted per job, and at the limit new jobs wait for the renewal (editing and previews keep working; nothing is billed past the price). Jobs at once, the largest export and judgments a day follow the plan. Account checks fail closed, a failed payment keeps working for 7 days, and account email (welcome, trial ending, minutes at 80% and 100%, payment failed) comes from support@cuttingfloor.ai. Self-hosted servers are unchanged: no plan, no limits.

## 0.19.2

### Patch Changes

- 5e54fe8: `create.cutout` runs in its own slot, one at a time by default (`CUTTINGFLOOR_HEAVY_JOBS`), at a lower CPU priority. A voiceover, import or export no longer waits minutes behind cut-outs, and a queued cut-out says what it waits for.

## 0.19.1

### Patch Changes

- cf35307: Parallel `create.motion` renders on the hosted server no longer fail with `server_busy`. The sandbox's process limit counted gVisor's own host threads, so three browsers at 1080x1920 crossed it and the whole sandbox crashed, failing every job in it. The cap now sits inside the sandbox, where a runaway script fails only its own job. A job waiting its turn hears its place in line every 20 seconds, so a long wait behind other renders no longer drops it after five minutes.

## 0.19.0

### Minor Changes

- 77e50b9: The hosted server moves to `https://api.cuttingfloor.ai/mcp`. The old address redirects there, and the site shows the new one.

## 0.18.0

### Minor Changes

- 9f7ad00: More ways to get a file in. `media.import` takes a small file as a `data:` URI (up to 8 MB, refused if it doesn't match the `sha256` given), and a file the user attached in the chat as `file` (`{download_url, file_id, mime_type, file_name}`, declared in `openai/fileParams` so ChatGPT passes attachments). Dropbox and Google Drive share links import as they are. A `media.upload` link opened in a browser is a page to drop the file on; it sends in parts and resumes on its own.

## 0.17.1

### Patch Changes

- 40802fd: New demo: let AI pick your best take, then make the thumbnail. Jev watches four takes of a channel intro, keeps the best and picks the thumbnail frame.
- 9a67ff8: New demo: add a talking head to a slide explainer, then make it a Short (Tip 1 of the infinite agentic memory explainer). Watch pages read right for a demo that adds rather than cuts.

## 0.17.0

### Minor Changes

- c90739c: Fixes for what tripped up the agents that made the site demos.

  - **Download links everywhere.** `code.run` hands back text and data files from `out/` (VTT, SRT, JSON, TXT, CSV and more) as files instead of failing on them, and every output, media and timelines too, has a signed download `url`. If one file can't be kept, that file is marked failed with the reason; the script's output and the other files still come back. `media.get` gives a download link for the file, and `render.frames` one per image.
  - **JPEG frames.** `render.frames` takes `format: "jpeg"`, and a `quality` for WebP and JPEG.
  - **A busy server queues work instead of failing.** Renders wait their turn for one of `CUTTINGFLOOR_MAX_RENDERS` slots (half the CPUs by default), and a time limit counts from when the render starts, not while it waits. `create.motion`, `create.still` and `code.run` no longer take a job slot from exports while the sandbox works. Inside a script, `motion()` and `still()` started together render one at a time. Two scripts running at once no longer lose each other's `out/` files.
  - **Errors you can retry.** Out of memory, a sandbox that is restarting or stopped mid-render now come back as `server_busy` with "call again in about a minute"; the docker hint shows only on a local server.
  - **Queued jobs say why.** `job.get` says where a waiting job stands and what it waits for ("queued: 2 ahead, waiting for a free job slot (running now: export.video, qa.check)", a render slot, or the sandbox). `code.run` says which call it is waiting on, and time spent in queues no longer counts against its `timeout_seconds`.
  - **Edits.** `transition.add {kind: "crossfade"}` on a video clip crossfades its sound and leaves the picture as a hard cut, and `changed` lists each transition (with track and kind), timeline effects and `audio.set_master`. `clip.set_transform {fit: "none"}` shows a graphic at its own pixel size. Fonts that aren't installed are refused with real ones to pick from. A title or caption that covers text already on its track says so. Freezing a clip's last frame holds it after the clip. Captions made per clip meet at the cut with no gap. Speed ramps say what `at` measures, and `timeline.get` gives each point its source frame.
  - **Clearer descriptions.** How exact transcript word times are and how to cut on speech instead, what `skills.search` scores mean, and that `code.run` keeps the last 16 KB of output. The cut-pauses skill's crossfade step is fixed.

## 0.16.0

### Minor Changes

- cf7ab12: **skills.search and skills.get:** step-by-step instructions for common jobs, found and read through cuttingfloor itself. `skills.search {query}` takes the user's words ("remove the ums from my video") and returns the skills that fit, best first, scored on each skill's name and description by keywords (BM25) and by meaning with a small model that runs on the CPU in the image, with no provider key. Without the model, search is keywords only. `skills.get {slug}` returns the whole skill as Markdown, ready to follow. The skills are `skills/*.md` in the repo, checked against one-mcp's playbook format.
- 9b5bb71: **Granular tools with full contracts.** Every tool declares its output schema, and the code.run SDK types every result. Tools no longer make choices for the agent:

  - `audio.set_loudness` and `audio.duck` are gone: set the mix with `audio.set_master` and `audio.set_gain` keyframes, and read loudness from audio previews or `qa.check`.
  - `qa.check` returns measurements (gaps, frame counts, loudness, true peak, and black or silent stretches with the settings you give), not pass or fail.
  - `caption.add {in_clip}` places captions timed in a clip's source seconds, through speed changes; `from_transcript` is gone, so you group the words.
  - `media.analyze` gains `silence` and `scenes`, with required settings; import no longer detects them.
  - `faces` returns face boxes only.
  - Tasks clients get tasks from long-running tools again.

## 0.15.0

### Minor Changes

- 47a372d: **judge.ask:** ask TypeSafe Jev your questions (yes/no, choice, score, box) about any state you name, and get typed answers back in about a second. An entry is text, JSON, an imported image `{media_id}` or a video frame `{media_id, at_seconds}`, mixed freely; questions refer to entries by name in backticks. Up to 32 questions, 8 pictures and 200k characters of text a call; a call too large for Jev fails with `limit_exceeded` and says to split it. Works in code.run as `cf.judge.ask(...)`, e.g. to mark filler words sentence by sentence.

  **look takes state:** `media.analyze {kind: 'look', state}` shows your text or JSON entries beside `frame` on every sampled frame, so questions can refer to a script line or a definition.

  **One daily budget (hosted):** look and judge.ask share `CUTTINGFLOOR_JUDGMENTS_PER_DAY` (default 5000; `CUTTINGFLOOR_LOOK_FRAMES_PER_DAY` still sets it). A look frame counts one; a judge.ask call counts one, plus one for each picture past the first.

## 0.14.0

### Minor Changes

- d25eb67: Uploads: `media.upload {name, bytes?}` gives a signed URL to PUT one of the user's files to, so a hosted server can take files it can't read from a path. Uploads resume (HEAD for `Upload-Offset`, then `Content-Range` from there), take browsers (CORS), are capped at `CUTTINGFLOOR_MAX_DOWNLOAD_BYTES` and kept a day; `media.import {source: {upload_id}}` moves the file into the media.
- 0bd36b3: Site: the home page session is drawn in the page from data instead of a video, and walkthroughs arrive: a template at /walkthroughs/[slug] fed by one data module, a hub at /walkthroughs, and the first walkthrough, fix-jagged-cuts.

## 0.13.0

### Minor Changes

- 011b544: `create.motion` renders frames in several browsers at once, about one per two CPUs (`CUTTINGFLOOR_MOTION_WORKERS` to set it). Every browser steps through every frame, so output is frame-identical to a single browser; a 5-second graphic renders 1.6–2× faster on six CPUs. The sandbox now gets 4 CPUs locally and 6 CPUs and 6 GB on the hosted server.

## 0.12.0

### Minor Changes

- 96921a6: Agents no longer have to guess. The server instructions now offer two ways to work: make new media with `create.*`, where a reference the user shows you is rebuilt in HTML rather than imported, or `media.import` the user's own files. `timeline.create` returns its tracks, so the first `clip.add` knows its `track_id`. `job.get {wait_seconds}` holds the call until a job finishes, instead of repeated polling. Output schemas no longer forbid extra fields, so a field added in a later release doesn't fail results in clients still holding the old schema. Media at exactly 24, 30 or 60 fps is no longer read as 23.976, 29.97 or 59.94.

  Titles and captions placed after the first frame of a timeline now render (libass was timed from the clip, but reads timeline time). Edit results say where each added or moved clip now sits (`track_id`, `start`, `end`). A transition left short of source by a speed change, trim or slip is shortened to fit instead of removed. A title with a reveal previews once it's fully shown. Cached preview frames are cleared on start, so a new build never serves an old render.

  `media.import {source: {job_id}}` imports a completed `export.video` render as media, so a finished edit can be re-cut, baked, or placed in a sequence of another shape. Nesting a timeline of a different shape is refused with that route as the hint (it rendered wrongly); same-shape nesting is unchanged. Each nesting level decodes media with its own producers, which fixes multi-frame previews when the same media is fitted differently inside and outside a nested timeline. `job.get` shows a job whose tool failed as `failed`, not `completed`.

  Job status keeps up: a progress update that arrives within a second of the last is held and shown, not dropped, so a job no longer sits on "fetching inputs" or "downloading the model" after it has moved on, and jobs waiting on the same model download see its progress. Exports report progress while they render. A `media.analyze` result too long to return (a long talk's transcript) comes back as its summary and a note on reading it in `code.run`; short results are unchanged. `code.run` marks output it cut ("[N earlier characters of stdout cut…]"), its description lists the `out` option of `motion()` and `still()`, and its result warns when a rendered page kept the placeholder name.

  A model that takes video in can now watch a cut. The new `review_h264` preset renders a small MP4 with sound at the sequence rate. Every `export.video` result links its file twice, as `video://jobs/{job_id}/output` and as the signed https URL, with MCP `annotations.audience` set to `assistant` for a review and `user` for any other render, so a host knows which to show its model. Results also give `fps` and `duration_seconds`. `job.get` now carries a finished job's links and media, as `tasks/result` does. Models without video keep using `render.frames`.

  Hosted mode refuses to start without `CUTTINGFLOOR_PUBLIC_URL`, instead of handing out download links to the server's own loopback address.

- cf078f4: Hosted servers take OAuth: set `CUTTINGFLOOR_OAUTH_ISSUER` and MCP clients sign in through that authorization server (Protected Resource Metadata, audience-bound JWT access tokens). API keys keep working alongside.
- 6603aa0: Hosted plans: a signed-in account works for a 3-day trial, then with a subscription (or a comped admin or lifetime account). Past that, tools return `subscription_required` with where to subscribe. API keys, for maintenance, are never gated.
- 754899c: Safe for many accounts on several servers that share one data root.
  - **Analyses:** each analysis is its own file beside the media. Two servers analysing the same media at once both keep their results. Records that held analyses inline move them out on first read.
  - **Jobs:** each job carries its server's name (`CUTTINGFLOOR_NODE`; hosted defaults to the hostname) and a heartbeat every 30 s.
    - A server restarting ends only its own jobs as `interrupted`.
    - Any server ends a job whose heartbeat has stopped for 2 minutes.
    - A cancel made through one server stops a job running on another.
  - **Hosted look cap:** hosted servers limit look frames per account per day (`CUTTINGFLOOR_LOOK_FRAMES_PER_DAY`, default 5000). A call that would pass the limit fails at once with `quota_exceeded`, naming what's used, what's left and when the limit resets.
  - **Deploy:** `deploy/hetzner` runs one hosted server on Hetzner Cloud with TLS and the sandbox under gVisor.
- 3fae5e9: `media.analyze {kind: "look"}` answers your own questions about what is on screen. TypeSafe's Jev, a fast judgment model (images are in preview), answers every question on frames sampled `every_seconds` or `at_seconds` (optionally between `from_seconds` and `until_seconds`), about 0.15 s a frame. Questions use Jev's own types: noul (yes/no probability), choice (one of named options), score (a degree on ordered levels) and box (where one thing is, as `{x, y, w, h}` fractions like faces and track). `with_previous` also shows the frame sampled before, as `previous`, for questions about what changed. The tool description teaches how to write questions Jev answers well. The result gives each question's spans; every frame's answers stay with the media (`media.get include ['look']`, the last 10 runs). Up to 600 frames and 32 questions a call.

  It needs `TYPESAFE_API_KEY` in the `.env` next to `compose.yaml`; without one, a look fails at once with `credential_required`, before any job starts. The key never appears in a result, error or stored file. Hosted servers use their own TypeSafe key for every account, with requests from all jobs sharing one limit per server.

## 0.11.0

### Minor Changes

- edf2072: `code.run` runs a Node, Python or bash script in the sandbox, sharing the workspace with the tools: inside it every tool is `cf.domain.verb(args)` (the new SDK, generated from the tool registry; Python `from cuttingfloor import cf`; bash `cf domain.verb '{json}'`), inputs arrive in `in/`, `importFile(path)` brings a made file in as media at once, and files left in `out/` come back as media or (`*.timeline.json`) timelines. Scripts run in their own user, PID and network namespaces with no network; their tool calls travel back over the job's own stream and run as the caller, so the sandbox still can't reach the server. `create.motion` now renders any animated page frame-exactly on a virtual clock (CSS animations and transitions, Web Animations, SVG, `requestAnimationFrame`, timers, `window.__seek`), with anime.js, three.js, Lottie and D3 bundled under `lib/`; HyperFrames and GSAP are gone. The image adds Python (numpy, Pillow, OpenCV) for scripts, and the sandbox's memory limit rises to 4 GB.
- 94ee94b: `create.cutout` cuts out any subject, not just people: `subject: "any"` uses BiRefNet lite (MIT, on ONNX Runtime) for products, animals and objects, and is the default for pictures; `subject: "people"` keeps MODNet, fast enough for video and the default there.
- a62d003: Export: `export.video` adds the `social_9x16_h264`, `web_1080p_av1`, `gif`, `audio_wav_48k` and `audio_mp3` presets and `overrides` for size, frame rate, bitrate and quality (`video://catalog/presets`). `export.timeline` writes the edit as FCPXML, OTIO or a CMX 3600 EDL, or the captions as SRT or VTT, listing what each format can't carry; `media: "collect"` zips the media alongside. `render.frames {size: "full"}` renders up to four frames at full size from the original media.

### Patch Changes

- b7cbff8: Previews of real footage, and exports of media bigger than the sequence (4K in a 1080p timeline), no longer come out garbled: full-frame clips are kept off a shortcut in MLT's qtblend that returned the picture at its source size. Those renders also use far less memory.

## 0.10.0

### Minor Changes

- 16c8988: `create.voiceover` speaks English text in one of 28 natural voices (Kokoro via sherpa-onnx, on the CPU; the model downloads once) and times every word, so `caption.add {from_transcript}` captions it exactly. `create.cutout` removes the background behind people in a video or picture (MODNet), giving ProRes 4444 with alpha and the original sound, or a PNG.

## 0.9.0

### Minor Changes

- 82e1b1e: Create new media: `create.motion` renders animated HTML (HyperFrames with GSAP) to a video with alpha, `create.still` renders an HTML page to a PNG, and `create.matte` makes a solid or gradient picture. Each is a job that returns a `media_id`, and the same recipe returns the same media. HTML runs only in the new `motion` compose service: a sandbox with no route out, no data volume, no capabilities, a read-only filesystem and fixed limits, with Chromium's own sandbox on (seccomp profile in `tools/motion/seccomp.json`). The image now includes Chromium.

## 0.8.0

### Minor Changes

- 89716cb: Analysis: `media.analyze` finds what is in imported media, as data for edits. `transcript` gives every word with its time (whisper.cpp on the CPU, models tiny/base/small downloaded once and checksummed), `beats` gives tempo, beat and downbeat times, `faces` gives face boxes over time and a smoothed focus point for reframing, and `track` follows a region you give. Results stay with the media (`media.get` with `include`). Transcripts drive edits: `clip.add {source: {words: [i, j]}}` cuts a clip to a range of words, and `caption.add {from_transcript: {clip_id}}` captions a clip from its transcript, timed where its words play (speed changes included).

## 0.7.0

### Minor Changes

- 7ca8a2c: Effects: `filter.add`, `filter.set` and `filter.remove` put registry effects on a clip, every clip on a track, or the whole timeline, and `adjustment.add` adds a clip whose effects change everything below it while it runs. 21 video effects (brightness and contrast, saturation, exposure, temperature, hue, vibrance, curves, LUTs, grayscale, sepia, invert, blur, sharpen, vignette, grain, chromatic aberration, pixelate, glitch, denoise, chroma key) and 12 audio effects (EQ, compressor, noise reduction, de-esser, dialogue enhance, reverb, echo, pitch, high-pass, low-pass, telephone), with their params at `video://catalog/effects`; number params take keyframes. `.cube` LUTs import with `media.import`. `timeline.load` now keeps numbering ids after transitions and effects in the loaded timeline.

## 0.6.0

### Minor Changes

- 45b0065: Audio tools: `audio.set_gain` (dB, with keyframes for rides), `audio.set_pan`, `audio.fade`, `audio.duck` (lowers a music track wherever the other audio tracks have sound, as gain keyframes on its clips), `audio.set_master` (master gain and limiter) and `audio.set_loudness` (measures the mix and sets the master to a loudness target, -14 LUFS by default, with peaks under the true-peak ceiling). Audio edits preview as a waveform image with the measured loudness, also readable at `video://timeline/{id}/waveform/{start}_{end}.webp`.

## 0.5.0

### Minor Changes

- 6cd2dbe: Titles and captions: `title.add`, `caption.add` (from segments with word timings, or from SRT/VTT, including WebVTT word timestamps) and `text.set` to retext or restyle many at once. Text renders with libass over the picture: fonts, size, colour, outline, soft shadow, box, karaoke/fill/word/pop highlights driven by word timings, and typewriter and word reveals. Titles and captions are clips, so transforms, masks, animations and transitions apply. A curated set of free fonts ships in the image (`video://catalog/fonts`), and `.ttf`/`.otf` files import with `media.import` for use through `font_media_id`.

## 0.4.0

### Minor Changes

- f60a602: Transitions: `transition.add`, `transition.set` and `transition.remove` at the cut between two touching clips. 19 kinds (dissolve, dip to black or white, wipes, slides, pushes, zoom in and out, iris, spin), listed at `video://catalog/transitions`; linked audio gets an equal-power crossfade at the same cut. By default the clips overlap by the transition's length and later clips move earlier; `mode: "handles"` uses source past the cut and moves nothing. An edit that breaks a transition removes it and says so in `warnings`.

## 0.3.0

### Minor Changes

- 34a6579: Timing tools: `clip.set_speed` (constant rate, speed-ramp curves and reverse, with pitch kept unless `preserve_pitch: false`), `clip.freeze`, `clip.roll`, `clip.slip`, `clip.slide`, `clip.replace`, and `range.lift` / `range.extract` to cut a span out of every track at once. Nested timelines: `clip.add {nested_timeline_id}` puts a whole timeline in as one clip (a compound clip) that can be trimmed, moved, transformed and masked like any other, and is transparent where it is empty. Keyframes stay on their content through speed changes.

## 0.2.0

### Minor Changes

- 33dd088: Clip compositing for overlays and picture-in-picture: `clip.set_transform` (position, scale, rotation, opacity, crop, flip and fit, each number animatable with keyframes and 34 eases), `clip.set_mask` (rectangle with rounded corners, ellipse, linear, mirror, heart, star and polygon, with feather and invert), `clip.set_blend` (13 blend modes) and `clip.set_animation` (entrance, exit and loop presets). Accepted names are resources at `video://catalog/{name}`. Pictures with an alpha channel keep it through conform and previews. Timeline documents are now version 2; `timeline.load` still accepts version 1 JSON.

## 0.1.0

### Minor Changes

- 5a66d33: Phase 1 editor: media import with conform and proxies, immutable timelines with clip editing and `edit.batch`, image previews on every edit, `render.frames`, exact `qa.check`, H.264 and ProRes export with signed downloads, and long-running work as MCP Tasks or `job.*`.
