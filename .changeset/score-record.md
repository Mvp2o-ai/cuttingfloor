---
'cuttingfloor': minor
---

score.record: the user plays a layer over a loop of a score, tapping pads or recording the microphone, in a view in the chat (ui://cuttingfloor/record) or on the page its url opens. It returns at once with a job_id; the take arrives through job.get as a new score and a region on the part, every tap at the exact beat it was played on and a recording placed on the beat that was heard, with the delay the device corrected. The phone app plays the same take natively through POST /v1/record.session and POST /v1/record.take (contract v1.1). The loop is rendered by the score engine, which is not on the server yet: until then score.record answers service_unavailable.
