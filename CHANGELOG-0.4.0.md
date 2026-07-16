# FeatureBoard MCP v0.4.0 — "Plan the week before you spend it"

19 commits since v0.3.3 · 161 tools (was 148) · 270 tests (was ~180) · all green

## Planning & budgeting
- **Sprints** — first-class registry (`create_sprint` / `list_sprints` / `assign_sprint`), `sprint:` label back-compat, sprint filter on `list_tasks`, per-sprint progress in metrics, full sprint UI in the board (create, filter, per-card assign).
- **Estimator + budget planner** — `estimate_work` derives per-ticket token estimates from the board's own work-log history; `plan_budget` maps a weekly token budget onto the priority queue before spending it (day assignments, cutline, model split).
- **Daily plan** — `daily_plan` tool + prompt: today's slice with a model and effort level per ticket, applied as `model:` / `effort:` labels; 📅 Plan panel in the board with Apply + Queue-dispatch.
- **Model tiering & orchestration** — full roster (fable orchestrates; opus architecture; sonnet implementation; haiku mechanical), suggested model in `next_task` and work packets, dispatch rules (parallel sonnet/haiku, sequential opus/fable) codified in instructions, `process_next`, and churn directives.
- **Churn mode + token caps** — 🔄 run-until-condition autonomy directives injected into work packets, per-ticket `cap:<tokens>` budgets with live spend-vs-cap chips, 💰 Budget panel (burnup vs budget, over-cap warnings).

## Workflow depth
- **Dependencies** — `[BlockedBy:]` edges with cycle rejection, `next_task` skips blocked work, `link_tasks kind:"blocks"`, ⛓ board chips.
- **Review gate** — new `Review` status (`[r]`), `requireReview` server-enforced approval before Done, 4-column board with ✓ approve / ↩ reject.
- **Requirements pads** — per-ticket intent / assumptions / acceptance criteria / open questions (`set_requirements`, `check_acceptance`, `refine` prompt); a ticket's definition-of-done becomes its acceptance criteria.
- **One prompt → chained cards** — `plan_work` accepts `dependsOn` edges and returns an `executionPlan` of parallel waves; `plan_goal` prompt decomposes a goal end-to-end.
- **Git discipline** — per-project git targets (code repo vs projectpad repo can differ), preflight line in every packet, commit-per-ticket in the close-out contract, `graduate_project` for one-command incubator → dedicated-repo moves with a pad mirror.

## Evidence & interop
- **Eval harness** — `experiment:board` / `experiment:chat` + `pair:` labels, `eval_report` with per-arm medians, paired token ratios, 7-day rework tracking.
- **PM bridge** — Linear/Jira CSV import (`import_tasks format:"auto-pm"`), `export_tasks` (json/csv/markdown) with round-trip guarantees.

## Hardening
- dueDate validation (junk remapped to description on add/import, rejected on update).
- Duplicate ticket-id detection, ambiguous-update refusal, and `repair_duplicate_ids`.
- Board artifact tool-allowlist fixes; daily_plan heuristics follow-ups tracked (FBMCPB-13).
