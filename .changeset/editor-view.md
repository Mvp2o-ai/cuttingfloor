---
"cuttingfloor": minor
---

export.video now opens an editor in chat apps that show MCP Apps views, in place of the plain player:

- The export plays over the timeline it was rendered from: every track and clip, transitions, volume lines and fades, and the mix measured from the file's own sound.
- Scrub on the ruler or the tracks (hold Shift to snap to cuts), step by frame or by second, jump between cuts, loop a stretch, zoom, and read every clip's details, everything playing under the playhead, and the caption words.
- The timeline is there before the export finishes, and a strip names the edit that made this version and outlines what it changed.
- Where the chat app allows it, your agent knows where you stopped and which clip you selected, though nothing is sent while you scrub. Send to agent writes a note into the chat with that moment attached.
- Signed export links can now be read from other sites (CORS), so the view can measure the sound.

media.get keeps the player.
