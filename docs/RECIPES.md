# FeatureBoard Cowork Scheduled Task Recipes

Copy-paste these prompts into **Claude Code → Scheduled tasks** to automate your board's autonomous routines. Each recipe uses only real FeatureBoard MCP tools — no daemon required.

---

## Nightly Board-Health Digest

**When:** Every night at 11 PM (or your preferred time)

**Prompt:**

```
Run the nightly board health check for FeatureBoard. 

1. Scan the board for cleanup opportunities (duplicates, stale tickets, missing model labels):
   - Use scan_board_cleanup to find likely duplicates, stale Todo items, and tickets missing model:/cap: labels
   - Use scan_test_cleanup to identify stale test files, byte-identical duplicates, or empty stubs

2. Get the board's current health score and metrics:
   - Use get_health to pull the composite health score (0-100) with its breakdown
   - Use get_metrics to view velocity, work-log trends, and cost by model

3. Run a quick drift check on Done tickets:
   - Use drift_start with mode:'sample' to evaluate a random subset of Done tickets for fidelity
   - Use drift_report to aggregate the results and surface flagged tickets

4. Post a Slack digest summarizing findings:
   - Use notify_slack to post a summary of cleanup opportunities, current health score, and drift warnings to the project's configured Slack webhook

Format the Slack message to highlight:
- Health score and grade
- Top 3 cleanup candidates (duplicates or stale tickets)
- Drift rate and any high-impact flagged tickets
- Velocity snapshot (recent tokens, active days, cost)
```

---

## Weekly Sprint Close-Out

**When:** Every Friday at 5 PM (or end-of-week)

**Prompt:**

```
Close the current sprint and generate close-out reports.

1. Generate the sprint close-out reports:
   - Use close_sprint to close the active sprint and generate audience-specific reports (marketing, sales, technical, executive) from Done tickets, work log, velocity, and cost metrics
   - This will refuse to close if there are still open (non-Done) tickets unless you force it

2. Review the generated reports:
   - Use get_sprint_report with the closed sprint name to read the reports and summaries

3. Notify the team:
   - Use notify_slack to post the sprint completion summary to the project's Slack webhook, highlighting velocity, cost, and any notable accomplishments from the executive report

Include in the Slack post:
- Total tickets closed and velocity (tokens, additions/deletions)
- Velocity trend vs. previous sprint
- Key metrics (cost by model, active contributors, work days)
- Link to the full reports for each audience
```

---

## Daily Standup & Next-Task Nudge

**When:** Every morning at 9 AM (or your preferred standup time)

**Prompt:**

```
Pull today's standup brief and notify the team of the next work item.

1. Get the next task in the queue:
   - Use next_task to pull the highest-priority open ticket (prefers In Progress, then earliest due date, then oldest)

2. Get today's metrics snapshot:
   - Use get_health to show the current board health score
   - Use get_metrics to surface today's velocity snapshot if any work has been logged

3. Post a standup nudge to Slack:
   - Use notify_slack to post the next-task summary and today's health to the project's Slack webhook

Format the message:
- "Good morning! Today's priority: [ticket ID + title + description]"
- Current board health score
- Recent momentum (tokens logged yesterday, if any)
- Link to open the board if needed
```

---

## Bootstrap a Backlog from an Unfamiliar Codebase

**When:** Once, when pointing FeatureBoard at an existing repo it has never managed.

**Prompt:**

```
Bootstrap a FeatureBoard backlog for the repo at <path>, project name <Name>.

1. Create the project and point it at the code:
   - create_project, then set_project_config with codeLocation:<path>.

2. Survey the codebase:
   - list_code_files for the layout and sizes.
   - code_file_map with symbols:true for per-file functions/exports and split candidates.
   - read_code_file on the entry point and any README/docs to learn intent.

3. Derive the backlog (aim for 10-20 tickets):
   - Obvious missing features or half-finished modules -> features.
   - Oversized files flagged by code_file_map -> refactor tickets (use suggest_file_split).
   - Absent tests for core modules -> testing tickets.
   - Stale/missing docs -> doc tickets.

4. File everything in one call with add_features_bulk (or plan_work), letting the
   intake guard stamp model:/cap: labels and triage fill product/priority.

5. Show me the board (get_board) and a daily_plan for the first day's churn.
```

**Why it works:** the intake guard (FBMCPF-159) labels every ticket with a
model/cap decision at birth, and triage intelligence (FBMCPF-214) backfills
product/priority from any tickets that already exist — so the bootstrapped
backlog is immediately runnable by the churn loop.

---

## Nightly Strengthen Auto-Research Loop

**When:** Every night at 2 AM (pairs with `scripts/strengthen.mjs` — FBMCPF-242)

**Prompt:**

```
Run the nightly strengthen auto-research loop for <Project> (findings -> property tests -> tickets).

0. (Optional) Refresh findings first: run `node scripts/strengthen.mjs --once` in the
   project's codeLocation if strengthen mode isn't already running in the background.

1. Read the findings:
   - Read strengthen_findings.json in the repo root (a JSON array of
     { stage, severity, detail, seed? } entries appended by scripts/strengthen.mjs).
   - Skip findings already filed: search the board with list_tasks search:<stage/detail>
     before filing anything.

2. File real findings as bugs:
   - For each NEW severity:"fail" finding, use log_bug titled
     "strengthen: <stage> - <short detail>" with the full detail (keep the seed in the
     description so the failure is reproducible).
   - severity:"warn" perf findings: file only if they recur across multiple passes.

3. Pick the least-tested module:
   - Use coverage_by_product to find the product area with the weakest test coverage.
   - Cross-check with list_code_files (server/ vs test/) for modules with no matching
     *.test.js at all; prefer those.

4. Generate property tests for it:
   - Use generate_test on the chosen module to derive cases, then save_generated_test to
     write the file. Favour property/round-trip style: hostile inputs must never crash,
     and parse -> serialize -> parse must be byte-stable.

5. Run and log:
   - Run the new file (node --test <file>) and then the full suite (npm test).
   - Use log_test_run with suite "strengthen-nightly", the pass/fail counts, and notes
     naming the module covered and the bugs filed.

Finish with a one-paragraph summary: findings triaged (filed vs skipped), module chosen
and why, tests added, suite result.
```

**Why it works:** `strengthen.mjs` does the cheap deterministic crunching offline and
never edits the board; this recipe is the intelligence layer on top — it converts the
findings file into bug tickets, steers new property tests at the least-covered module
each night, and leaves an auditable `log_test_run` trail, so coverage compounds while
the machine would otherwise sit idle.

---

## How to Use These Recipes

1. Open **Claude Code** and go to **Scheduled tasks** (or create a new scheduled task).
2. Choose your preferred schedule (cron-style for flexibility, or simple recurrence like "daily", "weekly").
3. Paste the entire **Prompt** block into the task.
4. Save. The task runs automatically at the specified time, calling FeatureBoard tools via the MCP to keep your board in sync.

## Tool Reference

All recipes use only these verified FeatureBoard MCP tools:

- `next_task` — Pull the next open ticket by priority
- `get_health` — Composite board health score (0-100) with breakdown
- `get_metrics` — Velocity, work log, and cost metrics
- `scan_board_cleanup` — Find duplicates, stale tickets, and missing labels
- `scan_test_cleanup` — Find stale or duplicate test files
- `drift_start` — Begin a fidelity evaluation run on Done tickets
- `drift_report` — Aggregate and report drift scores
- `close_sprint` — Close a sprint and generate close-out reports
- `get_sprint_report` — Read close-out reports by audience
- `notify_slack` — Post summaries to the project's Slack webhook
- `list_tasks` — Search/list tickets (used to dedupe strengthen findings)
- `log_bug` — File a bug ticket
- `coverage_by_product` — Per-product test-coverage rollup
- `generate_test` — Derive suggested test cases for a module
- `save_generated_test` — Write a generated test file into the repo
- `log_test_run` — Record a test run (suite, counts, notes)

See [docs/TOOLS.md](TOOLS.md) for full tool descriptions.
