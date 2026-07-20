---
name: daily-plan
description: Plan today's FeatureBoard work and dispatch it across models. Use when the user says "daily plan", "plan my day", "what should we work on today", "dispatch today's tickets", or wants the board's open tickets budgeted, model-labeled, and started at the right tier.
---

# Daily Plan

Build the day plan for a FeatureBoard project (model + effort per ticket), apply it, then dispatch sub-agents on every planned ticket at the right model/effort tier.

## 1. Build and confirm the plan

- Call `daily_plan` with `apply: false` (pass `budgetTokens` if the user gave a budget) and show the plan: ticket, model, effort, estimate, and the dispatch groups.
- Pause for a go-ahead if anything looks off; otherwise continue.
- Call `daily_plan` again with `apply: true` to stamp `model:`/`effort:` labels onto the tickets.

## 2. Dispatch

- For every ticket in `dispatch.parallel` (sonnet/haiku): `set_status` In Progress, `get_work_packet`, and start a sub-agent at that model with the packet as its brief — these can run concurrently. Right after starting each one, call `record_dispatch` (`worker: "sub-agent"`, `model`, `parallel: true`) so `get_agent_monitor` and the board show it's running.
- When parallel tickets touch DISJOINT code areas, give each its own isolated git worktree (`create_worktree`) so agents don't edit the shared repo at once; merge branches back SERIALLY and `cleanup_worktree`.
- Work `dispatch.sequential` tickets (opus/fable) one at a time — sub-agent or inline — with a review between tickets; `record_dispatch` (`worker: "sub-agent"`, `model`, `parallel: false`) at start, and again with `worker: "orchestrator"` when you take a ticket back for review.

## 3. Effort mapping for each sub-agent brief

- **low** — minimal exploration, make the obvious change, verify, stop.
- **medium** — normal loop with tests.
- **high** — read adjacent code first, consider invariants and back-compat, add tests, self-review the diff before finishing.

## 4. Orchestrator owns the board

Only the orchestrator writes to the board. As each sub-agent finishes:

1. Verify its work (run the tests, read the diff).
2. `set_status` Done with a one-line `completionSummary`.
3. `log_work` with tokens/additions/deletions and the model used.
4. `commit_feature` for that ticket when git is configured.

## 5. Guardrails and close-out

- Respect `cap:<tokens>` labels — wrap up and requeue any ticket about to exceed its cap.
- `commit_feature` starts background static checks automatically (pure CPU, no tokens) — keep dispatching, then collect them with `get_check_results` between tickets and before ending the session; a failed run is a fix-now or file-a-bug before closing out.
- When the plan is exhausted or the budget is spent, post a day summary to the scratchpad (`append_scratchpad`) and report to the user.
