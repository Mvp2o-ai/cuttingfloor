---
"cuttingfloor": minor
---

Accounts used through a client named in `CUTTINGFLOOR_LIFETIME_CLIENTS` (Kazi's two OAuth clients) get lifetime on their first call. It is tagged in WorkOS with its reason and date (`plan_reason: "via Kazi"`, `plan_since`), so exactly those accounts can be found and undone later. Accounts that already have a plan given or bought are left as they are, and usage keeps being metered.
