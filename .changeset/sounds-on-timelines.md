---
"cuttingfloor": minor
---

media.listen and media.analyze sounds also read an edit: give timeline_id and they listen to its mix as it plays, so a laugh, a clap or a door comes back where it sits on the timeline (timeline seconds, and timeline frames for render.frames). Both take from_seconds and until_seconds on media and timelines; a sounds run over the whole media is still kept with it.
