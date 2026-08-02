Quiet swarms, readable analytics. 3 commits since v0.8.2, 215 tools, 1189→1192 tests.

## Sub-agents no longer dump work packets into your chat

**FBMCPB-83.** The sub-agent dispatch template told the orchestrator to build
each prompt from "the work packet / researchBrief content", inlined verbatim.
The Agent tool's prompt is rendered in the user's transcript, so every lane
dispatch pasted a full packet — plus up to 6KB of research brief and ~4KB of RAG
chunks — into the conversation, multiplied by the lane count. A saturated wave
was several hundred lines of JSON per turn.

Sub-agents now get the ticket ID and call `get_work_packet` themselves as their
first action: identical context inside the agent, a readable transcript outside
it. Sub-agents may now READ the board through `get_work_packet`; `log_heartbeat`
remains the only write they're permitted. Quiet-chat budgets (one line per
dispatch, one per wave, one consolidated report) are stated in the dispatch
template, `SKILL.md`, `wave.js`, the dispatch directive and the server
instructions.

## Analytics

- **Routing scorecard panel** (FBMCPF-369) — `routing_scorecard` had been
  computed since 0.8.0 and never shown. Cost per clean ticket, rework rate,
  median cycle time and tokens per tier, plus the by-effort cross-cut. Tiers
  below `minSamples` render greyed with their sample count rather than ranked.
- **Lead time and backlog aging** (FBMCPF-370) — median, p90, same-day share and
  distribution for created→completed; open count, WIP, tickets past 30 days, age
  buckets and the eight oldest open tickets.
- **CSV export** (FBMCPF-371) — daily series and a per-ticket export carrying
  lead time and age.

## Fixes

- **`routing_scorecard` response cap** (FBMCPB-84) — it returned one row per Done
  ticket: 416 rows / ~125KB on a mature board, past the MCP result cap, so the
  scorecard broke exactly where it had the most evidence. `rows[]` is now opt-in
  (`includeRows`) and capped (`rowLimit`, default 200, rework-first then
  costliest). Stats are unchanged.
- **`BOARD_VERSION` can't drift again** (FBMCPF-372) — the board artifact's
  version constant sat at 0.6.2 across v0.7, v0.7.1, v0.8 and v0.8.2,
  mislabelling four releases of bug reports. `scripts/release.mjs` now rewrites
  it from `package.json` before packing.
- `routing_scorecard` added to `CORE_TOOLS` so the new panel survives an
  Essential-tools install.

Full detail: `CHANGELOG-0.8.md`.
