---
"cuttingfloor": minor
---

Every tool is now plain HTTP too: `POST /v1/<tool>` with the tool's arguments as JSON and an account key (`cf_…`) answers its result, through the same server as `/mcp`, and `/openapi.json` describes every tool as OpenAPI 3.1.
