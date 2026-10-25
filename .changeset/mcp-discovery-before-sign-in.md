---
"cuttingfloor": minor
---

Clients can discover cuttingfloor before signing in: a public Server Card at `/mcp/server-card` (listed in `/.well-known/ai-catalog.json`), and `initialize`, `server/discover`, `tools/list` and the resource and prompt lists answer without a token, the same for every account. Tool calls and reads still need sign-in and get the usual OAuth challenge.
