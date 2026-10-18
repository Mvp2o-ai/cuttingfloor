---
"cuttingfloor": minor
---

**skills.search and skills.get:** step-by-step instructions for common jobs, found and read through cuttingfloor itself. `skills.search {query}` takes the user's words ("remove the ums from my video") and returns the skills that fit, best first, scored on each skill's name and description by keywords (BM25) and by meaning with a small model that runs on the CPU in the image, with no provider key. Without the model, search is keywords only. `skills.get {slug}` returns the whole skill as Markdown, ready to follow. The skills are `skills/*.md` in the repo, checked against one-mcp's playbook format.
