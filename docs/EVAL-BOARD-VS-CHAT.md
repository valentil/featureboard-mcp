# Board vs Chat: paired agent trials (FBMCPF-129, revised design)

**Question:** does working a ticket through FeatureBoard (work packet: scope, definition
of done, project conventions, budget guidance) measurably beat handing the same agent the
raw ask? Agent-vs-agent only — the original human-in-the-loop arm was dropped as
uninformative (decided with Lewis, 2026-07-17).

**Design:** 10 real, already-shipped FeatureBoardMCP tickets. For each: two fresh sonnet
sub-agents, identical isolated git checkouts at the commit *before* the original fix
landed (bases verified to lack the fix), identical environment. One agent got a
**work-packet brief** (`experiment:board`, FBMCPF-175..184); the other got **only the
ticket title+description** (`experiment:chat`, FBMCPF-165..174). completionSummary text
was excluded from both briefs. Tokens are the Agent tool's measured `subagent_tokens` —
no estimates. Diffs are `git diff --numstat` of each trial tree. All 20 trials produced
working, self-test-verified implementations.

## Results (eval_report, live board, 10/10 pairs matched)

| Pair | Ticket re-run | Packet tokens | Chat tokens | chat/packet | Packet diff | Chat diff |
|---|---|---:|---:|---:|---:|---:|
| p1 | FBMCPB-9 get_board surfacing | 108,622* | 93,389 | 0.86 | 149+/3- | 656+/20- |
| p2 | FBMCPB-10 dueDate validation | 100,267 | 85,561 | 0.85 | 68+/3- | 88+/0- |
| p3 | FBMCPB-6 priority coercion | 71,929 | 80,873 | 1.12 | 76+/1- | 84+/1- |
| p4 | FBMCPB-11 duplicate ids | 110,022 | 120,525† | 1.10 | 206+/23- | 244+/20- |
| p5 | FBMCPB-12 close-out git contract | 69,142 | 84,003 | 1.21 | 52+/5- | 53+/5- |
| p6 | FBMCPB-13 daily_plan heuristics | 77,265† | 82,181 | 1.06 | 63+/12- | 118+/17- |
| p7 | FBMCPF-125 model tiering | 77,744 | 82,347 | 1.06 | 139+/31- | 138+/23- |
| p8 | FBMCPF-105 show-board instruction | 39,851 | 44,238 | 1.11 | 2+/0- | 2+/0- |
| p9 | FBMCPF-106 overlay theming | 56,993‡ | 60,342‡ | 1.06 | 10+/3- | 11+/0- |
| p10 | FBMCPF-67 analytics nav | 89,910 | 93,078 | 1.04 | 72+/1- | 77+/0- |

\* p1 packet run hit repeated sandbox RPC failures forcing retries — its tokens are
inflated by environment noise, not by the packet.
† contamination flag: agent briefly read the live repo (p4 chat: storage.js; p6 packet:
budget.js), self-reported, discarded, re-derived. Treat those pairs as weakened.
‡ p9 has no clean pre-state in git (overlay + fix landed in one commit); both arms ran
p9 on top of their own arm's p10 output, preserving symmetry. A first chat-arm attempt
against the bare base correctly found nothing to fix (52,785 tokens, counted as
protocol overhead).

**Aggregates:**
- Tokens: packet median **77.5k** vs chat **83.2k** — chat spent more in 8/10 pairs,
  median ratio ≈ **1.06–1.11x**, totals $4.81 vs $4.96 (pricing.js sonnet rates).
- Churn: packet **837+/82-** vs chat **1,471+/86-** — chat produced **1.76x the
  additions** for the same asks. Nearly all of the gap is scope inflation on the two
  open-ended tickets (p1: 656 vs 149; p6: 118 vs 63); on tightly-described tickets the
  two arms converge to near-identical diffs (p5, p7, p8, p9, p10).
- Correctness: 10/10 vs 10/10 — not a differentiator at this task size.
- Rework: 0 vs 0, but structurally unmeasurable (trial output never shipped).

## Reading

1. The packet's measurable win is **focus, not raw token count**: ~6–11% median token
   savings is modest, but 43% less diff churn means less to review, less to maintain,
   and less scope drift — the effect concentrates exactly where descriptions are
   open-ended and a definition-of-done constrains interpretation.
2. An earlier readout (docs/EVIDENCE.md, now superseded) reported 1.9–3.4x token
   ratios; those compared measured chat runs against *work-log-recorded* board tokens —
   a different measurement basis. This run measures both arms identically and is the
   number to cite.
3. Confounds, stated plainly: n=10, one model tier, same-day re-runs of tasks whose
   solutions exist in the repo's later history (checkouts predate the fixes, but the
   model family may have pattern-level familiarity), 2 contamination flags, 1 pair with
   environment noise, and packet briefs were reconstructed (faithfully, from ticket
   fields + project config) rather than emitted by get_work_packet at the historical
   moment.

## Go-forward protocol (new tickets)

For a sampled subset of genuinely new tickets: dispatch the packet arm (get_work_packet
output) and the raw arm (title+description) as parallel sub-agents in isolated
worktrees, same model; land the packet arm's result; log both trials with measured
`subagent_tokens` under `experiment:board` / `experiment:chat` + a fresh `pair:` id.
Rework then becomes measurable for the landed arm. Orchestrator-side overhead (packet
assembly MCP calls) remains unmetered — note it, don't guess it.

Raw run records: board tickets FBMCPF-165..174 (chat arm), FBMCPF-175..184 (packet
arm), each with tokens/additions/deletions/wall-seconds in its work-log entry.
Originals relabeled `experiment:board-legacy`. Aborted first packet wave (session
limit): 336,385 tokens overhead, not trial data.
