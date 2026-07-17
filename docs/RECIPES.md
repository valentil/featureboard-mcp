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

See [docs/TOOLS.md](TOOLS.md) for full tool descriptions.
