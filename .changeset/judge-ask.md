---
"cuttingfloor": minor
---

**judge.ask:** ask TypeSafe Jev your questions (yes/no, choice, score, box) about any state you name, and get typed answers back in about a second. An entry is text, JSON, an imported image `{media_id}` or a video frame `{media_id, at_seconds}`, mixed freely; questions refer to entries by name in backticks. Up to 32 questions, 8 pictures and 200k characters of text a call; a call too large for Jev fails with `limit_exceeded` and says to split it. Works in code.run as `cf.judge.ask(...)`, e.g. to mark filler words sentence by sentence.

**look takes state:** `media.analyze {kind: 'look', state}` shows your text or JSON entries beside `frame` on every sampled frame, so questions can refer to a script line or a definition.

**One daily budget (hosted):** look and judge.ask share `CUTTINGFLOOR_JUDGMENTS_PER_DAY` (default 5000; `CUTTINGFLOOR_LOOK_FRAMES_PER_DAY` still sets it). A look frame counts one; a judge.ask call counts one, plus one for each picture past the first.
