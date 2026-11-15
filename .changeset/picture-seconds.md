---
"cuttingfloor": patch
---

media.get now says how long the picture runs (picture_seconds), next to sound_seconds. When a file's sound outlasts its picture (or the other way round), clip.add warns which last frames of the new clip have no picture or no sound, so the agent can trim them.
