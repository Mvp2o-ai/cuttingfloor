---
'cuttingfloor': patch
---

create.motion and create.still say what went wrong in a page: the result's `warnings` (kept with the media, so media.get and a repeated recipe show them too) list uncaught errors and syntax errors with where they happened, console errors, files that were blocked or not found, fonts that failed to load, and tags never closed or CSS showing as text. Each problem is listed once with how often it happened, up to 20. The page still renders.
