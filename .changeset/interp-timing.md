---
"cuttingfloor": patch
---

clip.set_speed interpolate (blend or motion) now plays the right moment through the whole clip: the slowed copy used to stop a fraction of the way through its source, so later frames showed the wrong footage, white or black. Copies made before are made again.
