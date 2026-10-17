---
"cuttingfloor": minor
---

`media.analyze {kind: "look"}` answers your own questions about what is on screen. TypeSafe's Jev, a fast judgment model (images are in preview), answers every question on frames sampled `every_seconds` or `at_seconds` (optionally between `from_seconds` and `until_seconds`), about 0.15 s a frame. Questions use Jev's own types: noul (yes/no probability), choice (one of named options), score (a degree on ordered levels) and box (where one thing is, as `{x, y, w, h}` fractions like faces and track). `with_previous` also shows the frame sampled before, as `previous`, for questions about what changed. The tool description teaches how to write questions Jev answers well. The result gives each question's spans; every frame's answers stay with the media (`media.get include ['look']`, the last 10 runs). Up to 600 frames and 32 questions a call.

It needs `TYPESAFE_API_KEY` in the `.env` next to `compose.yaml`; without one, a look fails at once with `credential_required`, before any job starts. The key never appears in a result, error or stored file. Hosted servers use their own TypeSafe key for every account, with requests from all jobs sharing one limit per server.
