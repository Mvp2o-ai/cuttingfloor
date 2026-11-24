---
"cuttingfloor": minor
---

A watermarked export, created media or frames now come as two links: `url`, the review copy with the watermark (free), and `final_url`, the clean copy. Opening `final_url` spends the file's release credits once and downloads it without the watermark; with too few credits it shows the price, what the account has and where to get more, and spends nothing. Results, `job.get` and `media.get` carry it, and the agent is told to give both with the price and the user's credits. A Tasks result's text now carries the same watermark facts as its structured content.
