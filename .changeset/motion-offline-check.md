---
'cuttingfloor': patch
---

create.motion and create.still no longer refuse a page because a URL or `fetch(` appears in its script text (a bundled library's warning strings, code that never runs). The early check now refuses only what the browser would load from the network: element attributes such as src, href, srcset and poster, CSS url() and @import, and a meta refresh, with the URL and where it is in the error. Scripts that reach for the network at run time are still blocked by the sandbox, WebSockets to loopback included.
