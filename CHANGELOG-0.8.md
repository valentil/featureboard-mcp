# FeatureBoard 0.8.x

## 0.8.3 (2026-08-01) — quiet swarms, readable analytics

The 0.8 line taught the orchestrator to saturate lanes. This one fixes what
that felt like from the outside, and gives the analytics overlay the two
questions it could never answer.

### Sub-agents stop dumping work packets into the chat

- **FBMCPB-83 — dispatch by reference, not by value.**
  `skills/featureboarding/references/dispatch-prompt.md` told the orchestrator
  to build each sub-agent prompt from "the work packet / researchBrief content",
  inlined verbatim. The Agent tool's `prompt` argument is rendered in the user's
  transcript, so every lane dispatch pasted a full packet — plus up to 6KB of
  `researchBrief` and ~4KB of `ragChunks` — into the conversation, multiplied by
  the lane count. A saturated wave was several hundred lines of JSON per turn.

  Sub-agents now receive the ticket ID and call `get_work_packet` themselves as
  their first action: identical context inside the agent, a readable transcript
  outside it. Sub-agents may now READ the board through `get_work_packet`;
  `log_heartbeat` remains the only write they are permitted.

  Quiet-chat rules are stated in the dispatch template, `SKILL.md`, `wave.js`'s
  wave instruction, the `buildDispatchDirective` sentence and the server
  `INSTRUCTIONS` — one line per dispatch, one line per wave, one consolidated
  report at the end, and never reprint a research brief that `add_kb_doc`
  already stored.

### Analytics

- **FBMCPF-369 — routing scorecard panel.** `routing_scorecard` had been
  computed since 0.8.0 and never displayed. The overlay now shows cost per clean
  ticket, rework rate, median cycle time and median tokens per tier, the overall
  verdict, and the by-effort cross-cut. Tiers below `minSamples` render greyed
  with their sample count rather than being ranked — the tool's honesty rule,
  carried into the UI. `routing_scorecard` joins `CORE_TOOLS` so the panel
  survives an Essential-tools install.
- **FBMCPF-370 — lead time and backlog aging.** Median, p90, same-day share and
  distribution for created→completed; open count, WIP, tickets older than 30
  days, age buckets and the eight oldest open tickets. Throughput charts said
  how much shipped; neither said how long anything took or how stale the queue
  had become.
- **FBMCPF-371 — CSV export.** Daily series (completions, tokens, additions,
  deletions) and a per-ticket export carrying lead time and age.

### Fixes

- **FBMCPB-84 — `routing_scorecard` response cap.** It returned one row per Done
  ticket: 416 rows / ~125KB on a mature board, past the MCP result cap, so the
  scorecard was unusable exactly where it had the most evidence. `rows[]` is now
  opt-in (`includeRows`, default false) and capped (`rowLimit`, default 200,
  ordered rework-first then costliest), with `rowsOmitted` / `rowsTruncated`
  reporting what was left out. Per-tier and per-effort stats are unchanged and
  still computed from every row.
- **FBMCPF-372 — `BOARD_VERSION` can't drift again.** The board artifact's
  version constant was declared "mirrors package.json — bump alongside a
  release" and enforced by nothing, so it sat at 0.6.2 across 0.7, 0.7.1, 0.8
  and 0.8.2 — mislabelling four releases' worth of bug reports POSTed from the
  artifact. `scripts/release.mjs` now rewrites it from `package.json` before
  packing.

## 0.8.2 (2026-07-31) — swarm hardening

Hardened the featureboarding skill against silent swarm failures: pre-flight
zombie/worktree sweep, dispatch verification (`record_dispatch` +
`get_agent_monitor` lastDispatch check, Agent calls counted against lanes),
`occupied` hygiene and a stall-triage watchdog, per-completion `commit_feature`
(never batched), and mandatory sub-agent prompt blocks in the new
`references/dispatch-prompt.md` (FBMCPF-368).

## 0.8.0 (2026-07-26) — parallel dispatch

`next_wave` returns the whole dispatchable set at once, partitioned into
mutually file-disjoint lanes, so lanes stay saturated instead of being pulled
one ticket at a time (FBMCPF-361/362/363/364). Opus 5 routing rebalance plus
`routing_scorecard` — the empirical arm of the model-tier policy, measuring cost
per clean ticket instead of guessing. Release, site and registration correctness
fixes.
