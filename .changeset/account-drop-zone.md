---
"cuttingfloor": minor
---

Drop files on the account page: people whose agent can't reach a file on their computer drop it at cuttingfloor.ai/account, and it goes straight to the server, resuming after a dropped connection. The new `media.list` tool shows the agent what the user has (imported media, files sent but not imported yet, and the storage used), so it finds a dropped file by name and imports it. Each plan now caps storage held at once (Trial 5 GB, Creator 50 GB, Pro 200 GB, Enterprise 1 TB): uploads, URL imports and render imports past the cap are refused with what to do, and the account page shows storage beside render minutes.
