---
"cuttingfloor": minor
---

Partners can delete a user's account (`DELETE /partner/users {email, sub}`, with the partner's secret): when someone deletes their account in the Kazi or Cutting Floor AI app, their cuttingfloor account goes too, found by email or by the partner's user id, with its timelines, media, jobs, outputs, uploads, script keys and WorkOS sign-in. It answers `{deleted: true}`, or 404 `account_not_found` when there is none.
