# Competitor concept research — agent-workflow ideas for FeatureBoard (2026-07)

_Compiled July 2026 for FBMCPF-186. Scope: agent-workflow concepts from modern trackers and
agentic PM tools that FeatureBoard's ~189-tool surface doesn't yet cover — not enterprise admin
(SSO, permissions, billing seats, etc.). Cross-checked against `README.md` and
`docs/COMPARISON.md` so nothing here duplicates a shipped tool. Each entry: what it is, who does
it, whether it fits a local, markdown-backed, no-daemon MCP server, and a one-line ticket
proposal with suggested `model:`/`cap:` labels. Proposals are ranked best-first by
value-to-FeatureBoard ÷ architectural fit._

## Ranked proposals

### 1. Declarative automation-rules engine (generalizes the existing intake guard)
**What/who:** Jira Automation's trigger → condition → action model — issue created/field
changed/scheduled trigger, an "only if" condition, then edit-field/transition/notify/create
actions — is the industry-standard shape for hands-off ticket hygiene ([Atlassian: Jira
automation overview](https://www.atlassian.com/software/jira/guides/automation/overview),
[Jira automation triggers docs](https://confluence.atlassian.com/spaces/AUTOMATION/pages/993924804/Jira+automation+triggers)).
**Fit:** Strong. FeatureBoard already has three ad hoc instances of this pattern — the intake
model/cap guard (`server/orchestration.js`), the stalled-ticket flag in `get_agent_monitor`, and
`scan_board_cleanup`'s lint checks. A small on-demand rules DSL (evaluated at write-time and at
`scan_board_cleanup`, config per project) would unify and make them user-extensible instead of
hardcoded, without requiring any daemon.
**Proposal:** Add a configurable rules engine (trigger/condition/action over ticket
create/status-change/time-in-status) that subsumes and extends the intake guard. `model:sonnet
cap:60000`

### 2. Priority-aware sprint auto-rollover
**What/who:** Linear's Cycle Autopilot (March 2026): unfinished P0/P1 issues roll to the next
cycle automatically, P2/P3 get flagged for triage, P4 drops to backlog, with zero manual
decision-making ([How to Use Linear Cycles in
2026](https://workmanagementhub.com/linear-cycles-sprint-planning-guide-2026/)).
**Fit:** Strong. `close_sprint` already refuses to close with open tickets unless `force:true`
and reports carryover — this is the natural next step, just adding a priority-based rollover
policy instead of dumping everything into one undifferentiated carryover bucket.
**Proposal:** Add an optional rollover policy to `close_sprint` (by priority: auto-roll, flag, or
backlog) instead of one flat carryover list. `model:sonnet cap:40000`

### 3. Priority-based SLA / stale-ticket escalation checks
**What/who:** Jira Service Management SLA automation — scheduled rules that scan for tickets
past a status-time threshold (e.g. 48h in "In Progress" untouched) and bump priority/reassign/
comment; pre-breach Slack warnings ahead of SLA deadlines ([5 SLA automation rules every Jira
admin should set up in
2026](https://community.atlassian.com/forums/App-Central-articles/5-SLA-automation-rules-every-Jira-admin-should-set-up-in-2026/ba-p/3218569)).
**Fit:** Strong, and cheap — this is pure board-state analysis, no live listener needed.
FeatureBoard already has one half of this (the `get_agent_monitor` stalled flag for tickets
*In Progress*); it has nothing for tickets sitting **open/unstarted** past a priority-scaled
threshold.
**Proposal:** Add priority-scaled SLA checks (open-but-unstarted age thresholds) to
`scan_board_cleanup`, runnable via the same cron/Task-Scheduler pattern as `npm run nightly`.
`model:sonnet cap:30000`

### 4. Lightweight project health updates between sprint close-outs
**What/who:** Linear's Initiative/Project updates — a health indicator (On track / At risk / Off
track) plus a short narrative, with admin-configurable staleness reminders ("no update posted in
2 weeks") ([Initiative and Project updates – Linear
Docs](https://linear.app/docs/initiative-and-project-updates)).
**Fit:** Strong. FeatureBoard's `close_sprint`/`get_sprint_report` are a heavyweight, end-of-sprint
artifact (four audience reports). There's no cheap mid-sprint "are we still on track" signal.
**Proposal:** Add `post_project_update` (health status + short narrative, staleness-checked by
`scan_board_cleanup`) as a lightweight companion to sprint reports. `model:sonnet cap:35000`

### 5. `open_pull_request` — close the worktree-to-review loop
**What/who:** Background coding agents (GitHub Copilot coding agent, Devin, Cursor background
agents) all end a ticket by opening an actual reviewable PR, not just a local commit — "assign a
task, it works alone, then returns a pull request for review" ([Background coding agents
compared](https://techsy.io/en/blog/background-coding-agents-compared), [Copilot Coding Agent vs
Codex vs Cursor Background Agents](https://ralphable.com/blog/copilot-coding-agent-vs-codex-vs-cursor-background-agents-2026)).
**Fit:** Strong. FeatureBoard already has the hard part — `create_worktree` +
`commit_feature` + push. It stops one step short: the branch exists on the remote, but nothing
opens the PR itself with a ticket-linked title/body.
**Proposal:** Add `open_pull_request` (gh CLI/API) to turn a ticket's pushed worktree branch into
a PR with the ticket id and closing keywords in the body. `model:sonnet cap:25000`

### 6. Opt-in auto-status-on-commit via closing keywords
**What/who:** GitHub Projects' built-in workflows plus `fixes`/`closes`/`resolves` keyword
parsing — merging a linked PR auto-closes the issue ([Linking a pull request to an issue - GitHub
Docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue), [Using the built-in automations - GitHub
Docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)).
**Fit:** Good, with a guardrail. FeatureBoard's `get_ticket_diff` already finds commits mentioning
a ticket id, so the parsing plumbing exists — status transitions are just never triggered by it.
This has to stay strictly opt-in per project: the orchestrator-owns-all-board-writes rule is
deliberate (sub-agents never write the board), so keyword-triggered auto-status must be a config
toggle, not a default.
**Proposal:** Add an opt-in `git.config.json` flag that auto-transitions a ticket to Done when a
`commit_feature`d/pushed commit message contains a closing keyword + ticket id. `model:haiku
cap:20000`

### 7. Triage intelligence — suggest more than model/cap at intake
**What/who:** Linear's Triage Intelligence proactively suggests assignee, team, project, and
labels for new issues based on historical patterns, on top of plain routing rules ([Linear
Intake](https://linear.app/intake), [Triage – Linear
Docs](https://linear.app/docs/triage)).
**Fit:** Good. FeatureBoard's intake guard already does this exact move for `model:`/`cap:`
(deterministic type/keyword heuristics, never overriding an explicit label). Extending the same
heuristic engine to suggest `product:`/priority/labels from similar past tickets is a natural,
in-character extension, not a new capability class.
**Proposal:** Extend `server/orchestration.js` heuristics to suggest product/priority/labels at
intake from similar historical tickets, same never-override contract. `model:sonnet cap:45000`

### 8. Smart sprint assignment for un-slotted tickets
**What/who:** Plane auto-matches new work items to the right active/upcoming cycle based on
project, priority, and timing — "no manual sorting" — and can pre-create future cycles with a
cooldown ([Cycles | Plane](https://plane.so/cycles)).
**Fit:** Good. `assign_sprint` exists but is always an explicit call; there's no default policy
for tickets created without one.
**Proposal:** Add an optional auto-assign policy so new tickets without an explicit sprint land in
the active/next sprint by priority + remaining capacity. `model:sonnet cap:30000`

### 9. Transition gates on status changes
**What/who:** Plane's custom workflows/approvals add gating logic on state transitions (can't
move to a state without meeting a precondition) ([Top 6 open source project management tools in
2026 | Plane Blog](https://plane.so/blog/top-6-open-source-project-management-software-in-2026)).
**Fit:** Good. FeatureBoard has one hardcoded instance of this idea already — a ticket in Review
with an unresolved comment is held out of `next_task`'s queue. Generalizing it (e.g. block → Done
without a resolved review or a logged test run) is consistent with that precedent.
**Proposal:** Add per-project transition-gate config (require resolved review comments / a
passing `test_run` / a `log_work` entry before allowing → Done). `model:sonnet cap:35000`

### 10. Guided/semantic diff summaries on top of `get_ticket_diff`
**What/who:** Linear Diffs' structural highlighting (strips formatting-only noise) and Guided
Reviews (beta — walks a large diff in semantic order, separating supporting changes from glue
code) ([Linear Diffs – Review code
faster](https://linear.app/diffs)).
**Fit:** Reasonable, but this is the riskiest proposal on the list — it needs an LLM summarization
pass to stay grounded and not hallucinate intent, so it should be opus-tier and clearly labeled
"assistive, verify against the raw diff."
**Proposal:** Add an optional semantic-summary view on `get_ticket_diff` (what changed and why,
noise-stripped) ahead of `add_review_comment`. `model:opus cap:50000`

### 11. Metrics/work-log export beyond tasks
**What/who:** Linear Insights supports exporting to Google Sheets, Fivetran, or Airbyte for
deeper analysis outside the tool itself ([Linear Monitor – Understand progress at
scale](https://linear.app/monitor)).
**Fit:** Fine but low-novelty. `export_tasks` already exists for tickets; `get_metrics`/
`get_health`/`get_work_log` have no equivalent flat-file export for external BI/spreadsheet use.
**Proposal:** Add CSV/JSON export for `get_metrics`/`get_health`/work-log time series, mirroring
`export_tasks`. `model:haiku cap:15000`

### 12. Scoped-down "ask" capture tool (not a live intake channel — see rejection below)
**What/who:** Linear Asks lets people submit requests from Slack, email, and web forms, which get
routed into structured tickets automatically ([Linear Asks – Manage workplace
requests](https://linear.app/asks)).
**Fit:** Partial — see the full rejection of the live-listener version below. The piece that *does*
fit a no-daemon local server: giving the orchestrator a single tool to turn a pasted chat message,
forwarded email body, or Slack export text into a structured ticket with source-channel metadata,
without pretending to be a live multi-channel router.
**Proposal:** Add `capture_ask` — structure a pasted external request (source label + free text)
into a ticket via the existing intake heuristics, no listener implied. `model:haiku cap:15000`

## Concepts deliberately rejected

- **Live multi-channel intake (Slack/email/web-form listeners auto-creating tickets), i.e. Linear
  Asks in full.** FeatureBoard's own docs are explicit about the constraint: *"MCP servers have no
  daemon, so scheduling lives outside the server"* (see `README.md`'s nightly-tests section,
  which routes around this with external cron). A real inbound listener needs an always-on hosted
  process — that's the opposite of local-first, no-service architecture this product is built on.
  Item 12 above is the honest, scoped-down substitute: a paste-to-structure tool, not a router.
- **Event-driven background-agent triggers (Cursor Automations firing from GitHub PR comments,
  Slack messages, PagerDuty alerts)** ([Cursor Automations Review
  2026](https://agent-finder.co/reviews/cursor-automations)). Same no-daemon problem as above —
  webhook receivers need a running server. The correct local-first analog is poll-based, not
  push-based: proposals 1 and 3 (rules engine, SLA checks) already cover the equivalent ground and
  compose with the existing cron/Task-Scheduler precedent instead of requiring a new listener
  process.
- **Height-style fully autonomous "chat PM" that grooms the backlog and updates specs without a
  human approving each write.** Height combined full-stack PM with an AI reasoning engine that
  automated bug triage, backlog pruning, and spec updates, then pivoted further into "autonomous
  AI project management" with Height 2.0 — and shut down on September 24, 2025, without ever
  publicly stating why beyond "one of the hardest decisions"; community post-mortems point to
  funding-constrained competition against Linear/Asana/ClickUp/Jira and the autonomy pivot not
  converting enthusiasm into commercial traction ([Height.app is shutting down after 3 1/2 years
  of being publicly available](https://www.creativerly.com/height-app-is-shutting-down/), [Height
  App: The Rise and Sunset of an AI Project Management
  Pioneer](https://skywork.ai/skypage/en/Height-App-The-Rise-and-Sunset-of-an-AI-Project-Management-Pioneer/1975012339164966912)).
  FeatureBoard's design already rejects this shape on purpose — "Sub-agents NEVER write the
  board — the orchestrator alone sets status" — specifically to keep a checkpoint on every write.
  Building a fully autonomous board-groomer would undo that guardrail for exactly the kind of
  trust/reliability risk that likely contributed to Height never landing its autonomy bet.

## Sources

- [Linear Intake – Self-driving product operations](https://linear.app/intake)
- [Linear Asks – Manage workplace requests](https://linear.app/asks)
- [Triage – Linear Docs](https://linear.app/docs/triage)
- [Initiative and Project updates – Linear Docs](https://linear.app/docs/initiative-and-project-updates)
- [How to Use Linear Cycles in 2026: Sprint Planning, Backlog Triage & Team Velocity](https://workmanagementhub.com/linear-cycles-sprint-planning-guide-2026/)
- [Linear Diffs – Review code faster](https://linear.app/diffs)
- [Linear Monitor – Understand progress at scale](https://linear.app/monitor)
- [Linear changelog — Code Intelligence (2026-05-14)](https://linear.app/changelog/2026-05-14-code-intelligence)
- [Linear changelog — Coding sessions in Linear (2026-06-11)](https://linear.app/changelog/2026-06-11-coding-sessions)
- [Jira Automation: Basics & Common Use Cases | Atlassian](https://www.atlassian.com/software/jira/guides/automation/overview)
- [Jira automation triggers | Automation for Jira Cloud and Data Center](https://confluence.atlassian.com/spaces/AUTOMATION/pages/993924804/Jira+automation+triggers)
- [5 SLA automation rules every Jira admin should set up in 2026 | Atlassian Community](https://community.atlassian.com/forums/App-Central-articles/5-SLA-automation-rules-every-Jira-admin-should-set-up-in-2026/ba-p/3218569)
- [Height.app is shutting down after 3 1/2 years of being publicly available](https://www.creativerly.com/height-app-is-shutting-down/)
- [Height App: The Rise and Sunset of an AI Project Management Pioneer](https://skywork.ai/skypage/en/Height-App-The-Rise-and-Sunset-of-an-AI-Project-Management-Pioneer/1975012339164966912)
- [Top 6 open source project management tools in 2026 | Plane Blog](https://plane.so/blog/top-6-open-source-project-management-software-in-2026)
- [Cycles | Plane](https://plane.so/cycles)
- [Linking a pull request to an issue - GitHub Docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)
- [Using the built-in automations - GitHub Docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations)
- [Background coding agents compared | TECHSY](https://techsy.io/en/blog/background-coding-agents-compared)
- [Copilot Coding Agent vs Codex vs Cursor Background Agents: 2026 Workflow Map](https://ralphable.com/blog/copilot-coding-agent-vs-codex-vs-cursor-background-agents-2026)
- [Cursor Automations Review 2026: AI Agents That Run Themselves](https://agent-finder.co/reviews/cursor-automations)
