---
"cuttingfloor": minor
---

Safe for many accounts on several servers that share one data root.
- **Analyses:** each analysis is its own file beside the media. Two servers analysing the same media at once both keep their results. Records that held analyses inline move them out on first read.
- **Jobs:** each job carries its server's name (`CUTTINGFLOOR_NODE`; hosted defaults to the hostname) and a heartbeat every 30 s.
  - A server restarting ends only its own jobs as `interrupted`.
  - Any server ends a job whose heartbeat has stopped for 2 minutes.
  - A cancel made through one server stops a job running on another.
- **Hosted look cap:** hosted servers limit look frames per account per day (`CUTTINGFLOOR_LOOK_FRAMES_PER_DAY`, default 5000). A call that would pass the limit fails at once with `quota_exceeded`, naming what's used, what's left and when the limit resets.
- **Deploy:** `deploy/hetzner` runs one hosted server on Hetzner Cloud with TLS and the sandbox under gVisor.
