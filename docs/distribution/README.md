# Directory submissions

The hosted MCP endpoint is `https://api.cuttingfloor.ai/mcp`. Its OAuth discovery
supports dynamic client registration and client ID metadata documents. Hosted
users need a Cuttingfloor account with an active trial or plan. The local Docker
setup is documented in the repository README.

## Status on 2026-10-19

| Destination | Status | Next action |
| --- | --- | --- |
| Official MCP Registry | Published, active, version 0.19.2 | Keep `server.json` in sync with future registry publications. |
| MCP.so | [Submitted](https://github.com/chatmcp/mcpso/issues/5759) | Wait for directory review. |
| Claude | Listing copy prepared in `claude-listing.json` | Complete the public privacy policy, review testing, and signed-in portal submission. |
| ChatGPT / Codex | Plugin source prepared in `../../plugins/cuttingfloor` | Complete the missing listing fields, client testing, review recording, identity/domain verification, and portal submission. |
| Glama | Maintainer metadata prepared in `/glama.json`; public listing not yet found | Submit the repository and hosted connector using a signed-in Glama account. The official registry is also an ingestion source. |
| Awesome MCP Servers | Entry prepared in `directory-entries.json` | Obtain a working Glama listing and score badge before opening the PR. |
| Awesome Remote MCP Servers | Entry prepared in `directory-entries.json` | Obtain the Glama connector URL and score badge before opening the PR. |
| Cursor Directory | Root `.mcp.json` and listing copy prepared | Submit through the signed-in plugin form. |
| PulseMCP | New submissions paused | Recheck when submissions reopen. |
| Smithery | Registry continues; proxy, CLI, and connection services retire October 31, 2026 | Submit the direct hosted endpoint when its directory submission route is available. |

The registry identifier is `io.github.Mvp2o-ai/cuttingfloor`. The initial entry
lists the hosted endpoint. It does not claim the Docker image is an independently
launchable OCI registry package: the documented local setup uses Compose with a
separate sandbox role and seccomp configuration.

## App submission materials

`plugins/cuttingfloor` is a portable Agent Plugins package. ZIP its **contents**
so `plugin.json`, `mcp.json`, and `assets/` are at the ZIP root. It has no bundled
credentials, lifecycle hooks, or app registration IDs. OAuth configuration can be
discovered from the hosted server; complete the dashboard's authentication setup.

The OpenAI manifest contains exactly five positive and three negative review
cases. The positive cases cover an animated card, a five-second footage trim,
timed captions, an HTML still, and a sandbox-created timeline. Negative cases
cover an unrelated question, unavailable source footage, and unsupported
YouTube publication. These are review scenarios, not a claim that a particular
agent has already passed them.

The package is suitable for creating a draft, **not yet for final review**:

- Publish and verify the privacy policy and terms URLs. They are deliberately
  omitted from the manifest rather than pointing reviewers to a 404.
- Set the verified publishing identity and public support contact. The current
  package uses the GitHub organization name and GitHub Issues support URL.
- Enter the dedicated reviewer account credentials privately in each portal.
  A reviewer account was created with password sign-in, an access exemption,
  and no payment method. Do not put its credentials in this repo or the ZIP.
- Run the prompts using that account in the target clients, including negative
  cases. For Claude, also finish the required testing of every exposed tool.
- Record the OpenAI review walkthrough and provide an accessible recording URL.
- Complete domain verification using the exact challenge supplied by the portal;
  do not invent a challenge or overwrite another app's challenge file.

On 2026-10-19 the public `/privacy`, `/privacy-policy`, `/terms`, and `/support`
routes returned 404. The HTTPS GitHub Issues URL can serve as support, but it is
not a privacy policy or terms page.

## Verification performed

- `mcp-publisher validate server.json` passed against the official registry, and
  the published record was fetched back with active status.
- The hosted smoke test passed import, sandboxed still/motion generation, code
  execution, visual analysis, export/download, multipart upload, browser upload
  page response, and attached-file import checks.
- The OAuth smoke test passed dynamic registration, browser sign-in, token
  audience validation, authenticated tool calls, and rejection of a token for a
  different audience. Its temporary user and client were removed.
- The hosted server exposed 64 tools. Every tool had a title, boolean read-only
  and destructive annotations, and an output schema.
- A separate reviewer account's password sign-in succeeded. This does not
  replace testing that account in Claude and ChatGPT.

## Submission portals and requirements

- [Claude developer portal](https://claude.ai/directory/manage) and
  [submission requirements](https://claude.com/docs/connectors/building/submission).
- [OpenAI Plugins dashboard](https://platform.openai.com/plugins),
  [package format](https://developers.openai.com/plugins/build/plugins), and
  [submission requirements](https://developers.openai.com/plugins/deploy/submission).
- [Glama submission help](https://glama.ai/mcp/faq#how-do-i-submit-an-mcp-server).
- [Cursor Directory submission](https://cursor.directory/plugins/new).
- [Awesome MCP Servers contributing guide](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md).
- [Awesome Remote MCP Servers contributing guide](https://github.com/punkpeye/awesome-remote-mcp-servers/blob/main/CONTRIBUTING.md).

Do not call a prepared package or pending directory request an approved listing.
