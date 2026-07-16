---
name: daily_plan
description: Plan today's FeatureBoard work across Claude models and dispatch it. Use when the user says "daily plan", "plan today", "run the daily plan", "dispatch the day", "start the day's work", or clicks 🚀 Queue dispatch in the FeatureBoard panel (which stages a [DISPATCH] block in the project scratchpad).
---

# Daily Plan — plan → apply → dispatch → close out

Turn today's slice of a FeatureBoard queue into an executed day of work, with each
ticket routed to the cheapest Claude model that will do it well.

## 0. Preconditions

- FeatureBoard MCP connected. Ask which board if ambiguous; check `get_scratchpad`
  for a staged `[DISPATCH ...]` block first — if present, that IS the plan: skip to step 3.
- Verify git targets for the project (config/customPrompt) before any work:
  where do CODE commits go vs PROJECTPAD commits? They can differ.

## 1. Plan

Call `daily_plan { project, budgetTokens?, sprint? }` (read-only preview).
Show the user: ticket · model · effort · estimate, totals by model, cutline.
Proceed unless something looks off (or the user asked to review first).

## 2. Apply

Call `daily_plan { project, apply: true }` — stamps `model:` and `effort:` labels
onto the planned tickets so the plan survives the session.

## 3. Dispatch

**Model roster** (what each tier is trusted with):
- **fable** — orchestration (that's you), cross-cutting design, spec/architecture review
- **opus** — architecture, multi-file server changes, storage invariants, migrations
- **sonnet** — standard implementation: UI, features, most bugs, integrations, tests
- **haiku** — mechanical: docs/copy edits, label churn, data reshaping, renames

For each ticket: `set_status` In Progress → `get_work_packet` → start a sub-agent
(Agent tool) with the packet as its brief and `model` set from the ticket's label.
- `dispatch.parallel` tickets (sonnet/haiku): launch together, isolated contexts.
- `dispatch.sequential` tickets (opus/fable): one at a time, review between.

**Effort mapping** — put this in every sub-agent brief:
- `effort:low` — minimal exploration; make the obvious change, verify, stop.
- `effort:medium` — normal loop: read the pointed-at files, implement, run tests.
- `effort:high` — read adjacent code first, consider invariants and back-compat,
  add/extend tests, self-review the diff before finishing.

## 4. Close out (orchestrator only — sub-agents never write the board)

For each finished ticket: verify the work (run tests), then
`set_status Done` with a one-line completionSummary, `log_work` with
tokens/additions/deletions + model used, and **commit per ticket**
(`commit_feature`, message referencing the ticket id) when git is configured.
Respect `cap:<tokens>` labels: about to exceed → wrap up, log spend, note the
overrun in the scratchpad, requeue the ticket, move on.

## 5. Wrap

When the plan is exhausted or the budget is spent: post a day summary to the
scratchpad (shipped tickets, spend vs plan, surprises), clear any consumed
[DISPATCH] block, and report the day to the user with what's queued for tomorrow.
