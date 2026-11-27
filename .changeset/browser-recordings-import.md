---
'cuttingfloor': patch
---

A browser's own recording imports: MediaRecorder's WebM (Chrome) states no length in its header, so its length is read from where its last packet ends, and edits and exports read a copy that states it (conform reason `duration`). MP4/AAC (Safari, iOS) and Ogg/Opus (Firefox) recordings already imported as they are.
