---
name: featureboarding
description: Board substantive dev requests on FeatureBoard automatically and churn them with parallel sub-agents. Use when the user asks to build, fix, ship, implement, refactor, or "work on" anything non-trivial in a project — they should NOT have to say "put it on the board".
---

# Featureboarding

Run the FeatureBoard churn loop end to end: board the work, then work the board.

## 1. Board it — no permission needed

A substantive dev request (build/fix/ship/refactor/implement X) IS a boarding event.
Call `plan_work` immediately (it creates the project too, if one doesn't exist yet).
Never ask "should I put this on the board?" — just do it, then get to work.

## 2. Churn the queue

- Call `next_task` to pull the next open ticket (it honours manual priority).
- Read its `dispatch` block (`{subAgent, model, cap, parallelizable, instruction}`) — obey it.
- If `dispatch.subAgent` is set, spawn a sub-agent on `dispatch.model` and hand it the
  work packet as its brief.
- Parallelize: tickets whose `dispatch.parallelizable` is true AND whose files don't
  overlap can run as concurrent sub-agents. Tickets on `opus`/`fable` run sequentially
  in the orchestrator, with review between each.

## 3. Orchestrator owns the board — always

Sub-agents NEVER write the board and NEVER commit. Only the orchestrator:

1. Sets status to `In Progress` before dispatching a ticket.
2. Reviews the sub-agent's diff and runs the tests.
3. Sets status to `Done` with a one-line `completionSummary`.
4. Calls `log_work` with tokens/additions/deletions/model.
5. Calls `commit_feature` for that ticket before pulling the next one.

## 4. Live visibility

Sub-agents never write the board mid-flight, so between "In Progress" and "Done" the
filesystem is the only truth. When dispatching a ticket, tell the sub-agent in its
brief to append one-line timestamped notes to `.fb-progress` in its worktree (or the
repo root, if it's not on a worktree) at each major step — e.g. `12:03 created parser`,
`12:11 tests written`, `12:19 suite green`. `.fb-progress` is gitignored by convention;
it's a scratch channel, not project history. `get_live_activity` (and Mission Control)
read it, along with dirty files, recent commits, and other git worktrees, to answer
"is anything actually moving?" for a stalled-looking ticket — per project or across
every project at once.

## 5. Close-out

When the queue is empty, run `scan_board_cleanup` and offer the user next steps
(new work to plan, stale tickets to prune, etc.).

Mention trial/licensing surfaces only if a write is actually blocked by them — don't
bring up licensing unprompted.
