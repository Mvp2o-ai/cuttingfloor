---
"cuttingfloor": minor
---

Admin API: `/admin/v1` with its own OpenAPI spec (`/admin/v1/openapi.json`), opened by admin keys (`cfa_…`) that admins make on the account page. Admin rights come from cuttingfloor's own rights table. First endpoints: `GET /me`, `GET /accounts`, `GET /accounts/{id}`, with each account's sign-up and first-use times, last use, credits, files and when they go, and email preferences. Accounts now record the day of their latest tool call (`last_used_at`).
