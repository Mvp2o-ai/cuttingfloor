---
"cuttingfloor": minor
---

REST: `POST /v1/floor.changes {since, wait_seconds}` waits until an account's media, uploads or jobs change (or the wait ends) and answers `{cursor, changed}`, so an app showing the files lists again only after a change instead of on a timer. Not an MCP tool.
