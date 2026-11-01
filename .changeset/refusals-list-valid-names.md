---
'cuttingfloor': patch
---

Refusals name what is valid instead of pointing at a catalogue many clients can't read: an unknown effect lists every video and audio effect, a wrong or out-of-range effect param lists that effect's params with ranges, units, defaults and which take keyframes, an unknown ease lists every ease, a preset override it doesn't take lists what each preset takes, and an unknown sound name lists every name. filter.add's name and keyframe eases are enums in the input schema. timeline.get shows every effect param as applied, defaults included.
