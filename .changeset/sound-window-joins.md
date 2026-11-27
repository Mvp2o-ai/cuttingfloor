---
'cuttingfloor': patch
---

media.listen and media.analyze sounds no longer break a long sound's run at 10-second marks: the detectors' 10-second windows now overlap by half and each gives its middle, so no frame is scored at the edge of its window unless it is at the edge of the sound.
