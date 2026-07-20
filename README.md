# FeatureBoard — the board Claude actually runs

**A local, markdown-backed project board that lives inside Claude** — packaged as a
Claude Desktop / Cowork extension (`.mcpb`). Point it at a folder, and Claude plans,
logs, prioritizes, and *works* tickets in plain language — then renders the whole thing
as a live, interactive board artifact with a full analytics dashboard. No SaaS, no login,
no lock-in. Your boards are plain `featurelist.md` / `buglist.md` files you own forever.

It started as a hosted web app (OpenClaw). We rebuilt it as an MCP server by taking the
original app's file list and porting it, tool by tool, **while learning MCP from scratch** —
and it came together fast. What you get is ~195 tools spanning the entire product surface:
board and churn loop, analytics, testing, a media studio, CRM, leads, contracts, mail and
marketing, a website builder with git deploys, and per-ticket commits. The board is the
front door; everything the original app did is one sentence away in chat.

## Why it's good

- **It's the board Claude drives, not a database you poke.** Ask "what's on my plate,"
  "break FBF-300 into subtasks," or "ship the next ticket" — Claude pulls work, sets status,
  writes the code, logs the diff, and commits. The board stays honest because the agent keeps
  it honest.
- **One command opens the real UI.** `get_board` returns the shipped board as a Cowork
  artifact — Todo / In Progress / Done columns, filters, dark mode, click-to-move, and a 📊
  analytics dashboard (velocity, timeline, bug health, work-log feed) — all wired live to the
  server. No hand-rolled mockups.
- **Your files, your rules.** Boards are byte-compatible markdown. Existing FeatureBoard
  folders work with zero migration. Writes are atomic. Delete the extension tomorrow and your
  boards are still just markdown.
- **Depth when you want it.** The same server that tracks tickets also generates media, runs a
  CRM, drafts contracts and campaigns, builds and deploys a marketing site, and commits your
  code per ticket. Turn it down to the essentials with one toggle, or open the whole toolbox.

## Measured: what the board actually buys you

A paired agent trial (n=10, sonnet model tier) showed the work packet cuts diff churn **1.76x**
(837 vs 1,471 additions) with equal correctness (10/10 both). Token spend is 6–11% lower
(77.5k vs 83.2k median), secondary to the focus gain: less to review, maintain, and scope
drift on open-ended asks. See [docs/EVAL-BOARD-VS-CHAT.md](docs/EVAL-BOARD-VS-CHAT.md).

## Quickstart

1. Install the extension: double-click `featureboard-0.6.0.mcpb`, or Claude Desktop →
   **Settings → Extensions → Advanced → Install Extension**.
2. On first run it asks for your **Boards folder**. Each subfolder with a `featurelist.md` or
   `buglist.md` is a board.
3. Say **"open the FeatureBoard board"** — the live board opens as an artifact. Then just talk:
   - "Log a bug: gallery modal won't dismiss on mouse-out."
   - "Brainstorm five onboarding features and add them."
   - "Move FBF-207 to done — fixed the parser regex."
   - "How's velocity looking this week?"

> **First-run tip:** the extension defaults to **Essential tools only** (~34 core board tools)
> for a clean start. Turn that off in the extension settings to expose the full ~195-tool
> surface (CRM, media, website, marketing, and more). After installing or updating, fully
> **restart Claude Desktop** so new tools load.


## Recipes

Automate your board's daily routines without a daemon. Copy-paste these prompts into **Claude Code → Scheduled tasks** to run nightly board health checks, weekly sprint close-outs, and daily standups. See [docs/RECIPES.md](docs/RECIPES.md) for three ready-to-use scheduled task recipes and tool reference.
## Everything it can do

**Board & tickets** — `list_projects` · `create_project` · `list_tasks` · `get_task` ·
`add_feature` · `log_bug` · `add_features_bulk` · `import_tasks` · `validate_feedback` ·
`plan_work` · `update_task` · `set_status` · `decompose_feature` · `link_tasks` ·
`add_attachment` · `remove_attachment` · `delete_task` · `add_product` · `remove_product` ·
`get_project_config` · `set_project_config` · `get_ticket_history`

**The live board** — `get_board` (returns `artifact/board.html`, ready to render as a Cowork
artifact — this is what "open/show the board" calls)

**Churn loop & orchestration** — `next_task` · `get_work_packet` · `log_work` ·
`get_agent_monitor` · `get_scratchpad` · `set_scratchpad` · `append_scratchpad`
(pull one ticket, assemble a focused brief, dispatch to a sub-agent, record the diff, repeat.
`get_agent_monitor` is the live view of what's In Progress right now: elapsed time since each
ticket started, its last event with age, token spend vs its `cap:<tokens>` label, and a stalled
flag — an inactivity threshold, 30min by default. Stalled tickets also surface as a warning banner
on the board, useful for keeping an eye on an unattended churn run. It also reports `costSoFar`/
`capCost` in dollars — see cost tracking below.)

**Knowledge base** — `add_kb_doc` · `list_kb_docs` · `get_kb_doc` · `search_kb` (a per-project
kb/ folder of markdown docs, beyond the scratchpad — keyword-matched into `get_work_packet`'s
`kbMatches` automatically)

**Audit timeline** — `get_ticket_history` (per-ticket chronological log: `set_status`/
`update_task`/`assign_sprint` append status, priority, label, sprint, and due-date change events
to `ticket_events.jsonl`; `get_ticket_history` merges those with the ticket's work-log entries
into one view. Tickets from before this existed just show their work-log history. The board's 🕘
button on each card renders the same timeline.)

**Code review** — `get_ticket_diff` captures the code a ticket produced (finds commits mentioning
the ticket id in the project's code repo and returns per-commit summaries plus size-capped unified
diffs from `git show`). `add_review_comment` leaves PR-style feedback on a ticket (optionally
anchored to a file/line); `list_review_comments` and `resolve_review_comment` manage it. Unresolved
comments surface in the ticket's next work packet (`get_work_packet.reviewComments`) so the next
agent acts on the feedback, and a comment on a ticket in **Review** sends it back into `next_task`'s
queue — otherwise tickets awaiting review are held out of `next_task` (they belong to the reviewer).
The board's 🕘 ticket panel lists review comments with their resolved state.

**Analytics & health** — `get_metrics` · `get_health` · `get_work_log` · `predict_due_dates`
(`get_metrics`'s velocity section rolls up `$` cost by model too, alongside tokens. Cost tracking
is model-aware: `server/pricing.js` ships defaults sourced from current Anthropic API pricing —
input/output $/MTok per model tier (fable/opus/sonnet/haiku) — and every rate is overridable per
project via `set_project_config`'s `pricing` key, so a stale default is harmless. Work-log entries
with an `inputTokens`/`outputTokens` split are priced exactly; older entries with only a `tokens`
total fall back to a blended rate. `get_agent_monitor` and `eval_report` roll up the same $ figures
per ticket/arm, and the board's metrics panel shows a cost line with a per-model breakdown.)

**Timeline (piano roll)** — `get_timeline_data` (FBMCPF-158). The board's 🎹 Timeline panel is an Ableton-style piano roll: every ticket is a clip on a horizontal lane, spanning its worked window (created → In Progress → completed, from `ticket_events.jsonl` with a completion-day fallback). Lanes group by product / model / type / sprint / status; a sticky time ruler adapts its granularity (hour / day / week / sprint); wheel zooms centred on the pointer, shift+wheel or grab-drag pans. A single datastream overlay (tokens / cost / additions+deletions) draws as a strip under the ruler. Hover a clip for a compact card (title, status, model, tokens); click to pin an expanded card that lazily pulls `get_ticket_history` for selectable cost / status-history / work-log fields.

**Sprint close-out reports** — `close_sprint` · `get_sprint_report` (FBMCPF-156)
(close a sprint and turn its tickets + work log + metrics into four audience-specific reports —
**marketing** (features shipped, positioning-ready copy), **sales** (customer-facing capabilities +
the CRM tickets they resolve), **technical** (per-ticket changes, commits, ADRs touched), and
**executive** (velocity, spend vs budget, health, risks). `close_sprint` refuses to close while a
sprint still has open tickets unless `force:true` (open ones are then reported as carryover), writes
deterministic `reports/<sprint>/<audience>.md` pads under the project (byte-stable, no model calls),
and also returns a per-audience LLM prompt — the report packet as JSON plus an audience brief — so an
agent can draft richer copy while staying grounded in real data. When the project has Slack
configured it posts a one-block summary on close (a Slack failure is reported, never fails the close).
`get_sprint_report` reads them back: no sprint → list sprints with reports; a sprint → its manifest
and which audiences exist; sprint + audience → that report's markdown. The board's 📄 Reports panel
lists every sprint with reports and renders each audience in its own tab.)

**Board hygiene** — `scan_board_cleanup` · `prune_board` (also lints open tickets missing a `model:`/`cap:` label — see intake orchestration guard below)

**Intake orchestration guard** (FBMCPF-159) — every ticket-creating tool (`add_feature`, `add_features_bulk`, `log_bug`, `plan_work`, `import_tasks`, `validate_feedback` in apply mode, and `report_company_bug`) fills in a `model:`/`cap:` label at intake whenever the creator didn't set one, via `server/orchestration.js`'s deterministic type/keyword/product heuristics (bug vs. feature, docs/copy/rename → haiku or sonnet, architecture/UI-heavy/multi-file/parity → opus, conservative default sonnet + `cap:80000`). It never overrides a `model:`/`cap:` label you set yourself — only fills in what's missing. `scan_board_cleanup` then lints for any open ticket that still slipped through without one.

**Code awareness** — `list_code_files` · `read_code_file` · `code_file_map`

**Testing & QA** — `suggest_test_stub` · `generate_test` · `generate_multi_model_tests` ·
`save_generated_test` · `list_test_variants` · `eval_model_matrix` · `bug_impact_scan` · `log_test_run` ·
`get_test_runs` · `test_runs_by_suite` · `get_regressions` · `save_test_page` · `list_test_pages` ·
`get_test_page` · `remove_test_page`
(multi-model generation fans one test prompt across model tiers — fable/opus/sonnet — then
dedupes overlapping assertions so each bug gets one variant per model in the suite; `eval_model_matrix`
is the empirical follow-up (FBMCPF-148) — it runs each tier's variant file against seeded, deterministic
mutations of the target source in a temp dir (never the repo) and reports per-model defect-catch rate,
unique catches, an overlap matrix, and cost per caught defect, to inform when downgrading test
generation to a cheaper tier is safe)

**Drift (ticket-vs-code fidelity)** — `drift_start` · `drift_record` · `drift_report` ·
`drift_remediate` (score how well the code matches the ticket, report, and auto-remediate)

**Media studio** — `save_media` · `list_media` · `get_media` · `edit_media` ·
`list_variations` · `revert_media` · `tag_media` · `annotate_media` · `remove_annotation` ·
`search_media` · `add_media_comment` · `list_media_comments` · `remove_media_comment` ·
`upload_reference` · `list_references` · `publish_media_to_site` · `draft_share` ·
`list_shares` · `remove_share`

**CRM & customers** — `add_company` · `list_companies` · `get_company` · `add_contact` ·
`add_crm_message` · `submit_crm_intake` · `list_crm_inbox` · `review_crm_message` ·
`customer_portal` · `link_customer_ticket` · `unlink_customer_ticket` · `ticket_customers` ·
`add_company_agreement` · `update_company_agreement` · `remove_company_agreement`

**Leads & field sales** — `add_lead` · `list_leads` · `set_lead_status` · `enrich_lead` ·
`convert_lead` · `leads_map` · `add_lead_area` · `list_lead_areas` · `add_lead_interaction` ·
`update_lead_location`

**Contracts** — `list_contract_templates` · `generate_contract`

**Mail & marketing** — `draft_email` · `list_mail` · `get_email` · `mark_email_sent` ·
`create_campaign` · `list_campaigns` · `get_campaign` · `record_campaign_open`

**Bookings** — `book_meeting` · `cancel_booking` · `list_bookings`

**Website builder + deploy** — `get_site` · `set_site` · `scaffold_site` · `edit_site_section` ·
`add_page` · `list_pages` · `remove_page` · `deploy_site` · `upload_site_asset` ·
`list_site_assets` · `set_site_analytics` · `set_analytics_config` · `auto_configure_analytics` ·
`get_site_traffic` · `enable_login_gate` · `disable_login_gate`

**Per-ticket git** — `get_git_config` · `set_git_config` · `commit_feature`

**Packaging** — `suggest_packaging` · `save_packaging_config` · `validate_packaging`

**Licensing** — `license_status` · `set_usage_type` · `activate_license` ·
`request_commercial_license` · `register_email`

`list_tasks` is paginated and compact by default (`limit`, `offset`, `compact:false`) so large
boards never blow the context budget. Write tools echo the exact post-write line. Tickets can
carry an external `ref` (e.g. a plan item `WI-1.2`). See `DESIGN.md` for what was ported from the
original app and what was intentionally left out.

## The live board (Cowork artifact)

`artifact/board.html` is a self-contained Kanban that renders any board through the tools above —
columns, cards with due dates / products / labels / refs, click-to-move status, a metrics strip,
dark/light theme, and the 📊 analytics dashboard. `get_board` hands it to Claude ready for
`create_artifact`, so any natural-language "open the board" surfaces the real UI (not a
reinvented one) and refreshes from the server every time it opens.

## Per-ticket git integration (optional)

FeatureBoard can commit — and optionally push — your code repo per finished ticket, exactly like
the original app did. It's **opt-in, off by default**, and stores **no secrets**: pushing uses your
machine's own git credentials (credential manager / SSH), just like running git yourself.

```
set_git_config     project=MyApp enabled=true branch=main push=true
set_project_config project=MyApp codeLocation="/path/to/repo"
commit_feature     project=MyApp ticket=FBF-42 title="Login flow"
#   → git add . && git commit -m "FBF-42: Login flow" && git push origin main
```

`get_git_config` shows current settings; `commit_feature` no-ops with a clear reason when disabled.
Config lives in the board's `git.config.json`.

**Pad mirror on close-out (graduated projects).** Once a project's `stage` is `graduated`
(see `graduate_project`), `commit_feature` and `set_status ... Done` also refresh a read-only
snapshot of the pad — `featurelist.md`, `buglist.md`, `scratchpad.md`, `agent_work_log.md`, and
config — into `<codeRepo>/.featureboard/`. `commit_feature` stages and includes the snapshot in the
same commit as the code change; `set_status Done` refreshes it on disk even if `commit_feature`
isn't called for that ticket. The central pad stays authoritative — this is a one-way snapshot, so
cloning the code repo gets you the code plus the board history that shipped with it. Missing pad
files are skipped; a mirror failure is reported as a warning and never blocks the commit or the
status change.

## Parallel dispatch in isolated git worktrees (optional)

For Cline-Kanban-style parallel agents, FeatureBoard can give each ticket its own **git
worktree** — a separate checked-out directory on its own branch (`ticket/<ticket>`) that shares
the repo's `.git` object store. N sub-agents can then work N tickets at once, each editing its own
directory instead of fighting over one working tree, and you merge the branches back serially.

```
create_worktree  project=MyApp ticket=FBF-42          # -> <codeLocation>-worktrees/FBF-42 on branch ticket/FBF-42
list_worktrees   project=MyApp
cleanup_worktree project=MyApp ticket=FBF-42          # after the branch is merged back (refuses if dirty; force to override)
```

When a worktree exists for a ticket, `get_work_packet` includes a `worktree` block (path, branch,
and step-by-step merge-back guidance) so the dispatched sub-agent edits *there*, never the shared
repo. Board writes stay orchestrator-only, and branches merge back **serially** (checkout the base
branch, merge/rebase `ticket/<id>`, run tests, `commit_feature`, then `cleanup_worktree`).

> ⚠️ **Sync caveat — worktrees live OUTSIDE the code repo.** Under Cowork, the host↔sandbox folder
> sync interacts badly with git's internal worktree administration files: a worktree created
> *inside* a synced repo mount can corrupt git internals or fail to sync. So worktrees default to a
> sibling directory `<codeLocation>-worktrees/` (outside the repo), configurable with the project
> config key `worktreeDir`. `create_worktree` **refuses** a `worktreeDir` inside the repo and never
> auto-creates worktrees in the repo itself. Point `worktreeDir` at a path outside every synced
> mount (e.g. an OS tmpdir) if in doubt.

## One-time setup: approve tools in bulk

FeatureBoard registers ~195 tools. In Claude Desktop, open **Settings → Extensions →
FeatureBoard → Tool permissions** and choose **Allow all** for read and write once,
instead of approving each tool the first time it fires — per-tool prompts stall
agent churn loops mid-run. The onboarding screen reminds you of this on first use.

## Licensing

FeatureBoard is source-available (see `LICENSE.md`): free for private non-commercial and
public/nonprofit use (PolyForm Noncommercial), with a free 24-hour commercial trial after which
**write** tools freeze (reads keep working) until a commercial key is activated. Commercial
keys are **US$119/seat/year**, self-serve at <https://featureboard.ai/buy>. On first use,
onboarding asks which tier applies. Owners issue keys with the offline generator in `owner/`
(never shipped — `.mcpbignore` excludes it); see `owner/README.md` for the
request → contract → issue-key → customer flow.

The same onboarding screen has an **optional email field**. Nothing is stored or sent unless you
explicitly click "Save email" — that click is the only consent signal used, and there's no usage
telemetry attached to it. On submit, the email is saved locally and POSTed once to the
featureboard.ai registrations listener; skip the field and nothing leaves your machine. See
`docs/compliance/PRIVACY.md` for the full disclosure.

## Data & storage

- Boards are plain markdown; a `.featureboard/index.json` sidecar caches the ticket counter.
  Markdown is always authoritative.
- Ticket ids are inferred from existing tickets in each file, so a board keeps its prefix
  regardless of folder name.
- Writes are atomic (temp-file + rename).

## Build & develop

Requires Node 18+.

```bash
npm install                       # MCP SDK + zod
npm run check                     # syntax-check every server module
node --test                       # unit tests (630)
npm run smoke                     # end-to-end stdio smoke test (no Claude Desktop needed)
npm run build && npm run bundle   # preflight, then pack featureboard-<version>.mcpb
```

Run the server directly over stdio:

```bash
FEATUREBOARD_DATA_DIR=/path/to/boards npm start
```

### Nightly tests

`npm run nightly` runs the suite headlessly per `nightly_tests.json` and records a timestamped
result under `.featureboard/nightly/` (kept to `keepRuns`). The exit code mirrors the run so a
scheduler can alert on regressions; if `testLogPath` points at a board's `test_runs.md`, the
result is appended there so `get_test_runs` and the board's 🧪 Tests panel surface nightly runs
next to manual ones. MCP servers have no daemon, so scheduling lives outside the server — point
cron or Windows Task Scheduler at the script.

## License

MIT © Lewis Valentine
