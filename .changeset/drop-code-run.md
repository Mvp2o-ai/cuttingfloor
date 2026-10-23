---
'cuttingfloor': minor
---

**Breaking:** `code.run` and the script SDK (`import { cf } from 'cuttingfloor'`, the Python module and the `cf` command) are gone. cuttingfloor is a plain MCP server: every tool declares its full output schema, and how to call them, one at a time or from the assistant's own code, is the client's choice. Running MCP servers from code is a client's job. `create.motion` and `create.still` work as before in the same sandbox. The image no longer carries Python, numpy, Pillow or OpenCV for scripts.
