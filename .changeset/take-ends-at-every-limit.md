---
'cuttingfloor': patch
---

Play-along: `record.session` now says where a take ends (`limits`: passes, taps, seconds of microphone), and the view stops at each of them. A pads take over 2,000 taps was refused whole when sent; it now ends by itself at the limit. A delay measured by tapping along is dropped when the sound starts going out another way (headphones unplugged), where it was kept and moved every later tap.
