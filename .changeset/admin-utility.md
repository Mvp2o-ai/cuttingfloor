---
'cuttingfloor': minor
---

cuttingfloor has its own staff admin. `/admin` on the site lists every account with search (email or id) and sort (newest, last active, credits, exports); `/admin/<account id>` shows the balance and every ledger entry, purchases, exports and releases, recent tool calls and errors, clients, referral and what we know of Kazi, with a form that adds or takes away credits with a reason. Staff are the accounts the server's rights table makes admins; anyone else gets a 404. The admin API (1.12.0) gains `POST /admin/v1/accounts/{id}/adjustments` (an `adjust` entry with the admin's id and reason, idempotent by the caller's id, never below zero), `GET /admin/v1/accounts/{id}/ledger`, and `q` and `sort` on `list_accounts`. The site calls it server-side with its own key for the signed-in admin; no key reaches the browser.
