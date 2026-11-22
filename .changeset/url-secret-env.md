---
"cuttingfloor": minor
---

Self-hosting on more than one server: set `CUTTINGFLOOR_URL_SECRET` (32 bytes or more, base64) and every server signs and opens the same download, watch and upload links. Unset, nothing changes: the server keeps its own key in `secret.key` under the data root.
