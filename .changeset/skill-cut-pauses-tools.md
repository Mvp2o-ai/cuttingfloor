---
'cuttingfloor': patch
---

The cut-pauses-ums-and-restarts skill uses tools only: speech bursts from `media.analyze {kind: "silence"}`, words read in pieces with `media.get`, filler marked with `judge.ask`, and every take followed with one `job.get {job_ids}`.
