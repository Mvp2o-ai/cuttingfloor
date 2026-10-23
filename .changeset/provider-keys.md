---
"cuttingfloor": minor
---

Save your sync. labs key once on the account page, and create.lipsync uses it from any client: no header needed. The key is stored only as ciphertext in your account, never shown again (just its last four characters), and can be removed there. A key sent in `X-Cuttingfloor-Key-Sync` still comes first. Without either, create.lipsync's error links to the page (`detail.keys_url`).
