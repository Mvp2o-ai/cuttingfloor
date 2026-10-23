---
'cuttingfloor': minor
---

Keys for scripts: the account page makes keys (`cf_…`) that a script sends as `Authorization: Bearer` to `/mcp`, with no browser sign-in. A key acts as its account, with the same trial and plan checks, works for a year or until revoked on the same page, and is shown once; the server keeps only its SHA-256.
