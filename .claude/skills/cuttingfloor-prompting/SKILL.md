---
name: cuttingfloor-prompting
description: Write or review cuttingfloor's model-readable text - MCP tool descriptions, parameter descriptions, server instructions, results, warnings and error hints. Covers the length limits clients impose, what goes first, and how costly calls hand the agent the facts to make them cheaper.
related: lessons-on-how-to-prompt:extends
---

# Prompting for cuttingfloor

This extends `lessons-on-how-to-prompt` (one-mcp's `.claude/skills/lessons-on-how-to-prompt`): state
what is true and what is required, let the agent decide how; describe what a tool is and its real
limits, never a "use it when" list; errors are facts, not recovery recipes. Everything here is how
that applies to this server.

## Who reads it

An agent (Claude, ChatGPT, Kazi, Cursor) reads every description, result and hint, then talks to a
creator who uses CapCut or Loom, not an editor. Text the agent may repeat stays in plain words: no
jargon, no invented terms.

## Length: clients cut what they don't show

Claude Code shows the agent only the start of long text (code.claude.com/docs/en/mcp.md, "Tool search
for MCP server authors"; checked 2026-11-15):

- Server instructions: 4,096 characters (2,048 before v2.1.296). Everything past the cut is gone.
- A tool description: 4,096 characters when the tool is loaded up front, 16,384 when it is loaded
  through tool search, which is how most clients meet our 70-odd tools.
- No documented cap on parameter descriptions; claude.ai connectors document none either. Other
  clients (ChatGPT, Cursor, Codex) have their own budgets.

Write to the strictest cut: server instructions and every tool description fit in 4,096
characters. Today's texts fit; keep them there.

- Lead with what the tool is and its hard limits; the first sentence must stand alone. Detail
  and nuance go last, where a cut costs least.
- A fact the agent needs to call the tool correctly belongs in the description or the parameter's
  own description, not only in the server instructions, which are the first text to be cut.
- Measure before shipping: count characters of the text the server actually sends (template
  expanded), not the source.

## Dense leading words

Facts and purpose in few words. Prefer one exact word (stage, ingest, conform, proxy) over an
explanatory sentence. Don't spell out another tool's arguments or call sequences ("until imported",
not "until media.import {source: {upload_id}}"): the agent finds and reads that tool, and the text
can't go stale. No shell commands or protocol mechanics. App stores (the ChatGPT plugin review)
flag text that steers the model to other tools.

Name what a thing does, not whose it is: the model behind judge.ask, look and media.seek is "the
judgment model", never TypeSafe or Jev (the TYPESAFE_API_KEY setting in self-hosting hints is the
exception). Never link the account page from model text: it sells credits, and app stores refuse
links to a page where something is bought. Uploads go to cuttingfloor.ai/upload; plans only to
/pricing. No prices, free allotments or upgrade wording, ours or a provider's.

## Results carry the facts for the next decision

- Every result matches the declared output schema, including a call that stops early (an estimate,
  a job), so clients can chain calls before any result exists.
- When a call is expensive, the result says what drives the cost and which free narrowing exists,
  with the numbers: which files or kinds make up most of it and what a filter would cut it to.
  That is the fact the agent lacks; choosing the narrowing stays the agent's. When nothing free can
  narrow it, say so plainly: the cost is what it is.
- Thresholds, targets and verdicts are the agent's arguments or don't exist. Limits that protect
  the server (sizes, durations, batch caps, timeouts) stay and are stated as facts.
- Previews and facts stay honest: full data the server already reads, true formats, no summary
  chosen to fit one incident.

## Errors

`CfError` with a typed code; the message says what failed and the unmet condition, with the
affected inputs. The hint states the condition or the fact that unblocks, not a remedy chain. Never
put a provider key in any text.

## Before shipping text

Read it as the agent would, cold, inside the cut: does the first sentence say what this is? Is any
required fact only in the part a client may drop? Does anything tell the agent how to do its job
rather than what is true?
