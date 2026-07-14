# FeatureBoard — the board Claude actually runs

**A local, markdown-backed project board that lives inside Claude** — packaged as a
Claude Desktop / Cowork extension (`.mcpb`). Point it at a folder, and Claude plans,
logs, prioritizes, and *works* tickets in plain language — then renders the whole thing
as a live, interactive board artifact with a full analytics dashboard. No SaaS, no login,
no lock-in. Your boards are plain `featurelist.md` / `buglist.md` files you own forever.

It started as a hosted web app (OpenClaw). We rebuilt it as an MCP server by taking the
original app's file list and porting it, tool by tool, **while learning MCP from scratch** —
and it came together fast. What you get is ~130 tools spanning the entire product surface:
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

## Quickstart

1. Install the extension: double-click `featureboard-0.3.2.mcpb`, or Claude Desktop →
   **Settings → Extensions → Advanced → Install Extension**.
2. On first run it asks for your **Boards folder**. Each subfolder with a `featurelist.md` or
   `buglist.md` is a board.
3. Say **"open the FeatureBoard board"** — the live board opens as an artifact. Then just talk:
   - "Log a bug: gallery modal won't dismiss on mouse-out."
   - "Brainstorm five onboarding features and add them."
   - "Move FBF-207 to done — fixed the parser regex."
   - "How's velocity looking this week?"

> **First-run tip:** the extension defaults to **Essential tools only** (~34 core board tools)
> for a clean start. Turn that off in the extension settings to expose the full ~130-tool
> surface (CRM, media, website, marketing, and more). After installing or updating, fully
> **restart Claude Desktop** so new tools load.

## Everything it can do

**Board & tickets** — `list_projects` · `create_project` · `list_tasks` · `get_task` ·
`add_feature` · `log_bug` · `add_features_bulk` · `import_tasks` · `plan_work` ·
`update_task` · `set_status` · `decompose_feature` · `link_tasks` · `add_attachment` ·
`remove_attachment` · `delete_task` · `add_product` · `remove_product` ·
`get_project_config` · `set_project_config`

**The live board** — `get_board` (returns `artifact/board.html`, ready to render as a Cowork
artifact — this is what "open/show the board" calls)

**Churn loop & orchestration** — `next_task` · `get_work_packet` · `log_work` ·
`get_agent_monitor` · `get_scratchpad` · `set_scratchpad` · `append_scratchpad`
(pull one ticket, assemble a focused brief, dispatch to a sub-agent, record the diff, repeat)

**Analytics & health** — `get_metrics` · `get_health` · `get_work_log` · `predict_due_dates`

**Board hygiene** — `scan_board_cleanup` · `prune_board`

**Code awareness** — `list_code_files` · `read_code_file` · `code_file_map`

**Testing & QA** — `suggest_test_stub` · `bug_impact_scan` · `log_test_run` · `get_test_runs` ·
`test_runs_by_suite` · `get_regressions` · `save_test_page` · `list_test_pages` ·
`get_test_page` · `remove_test_page`

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
`request_commercial_license`

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

## Licensing

FeatureBoard is source-available (see `LICENSE.md`): free for private non-commercial and
public/nonprofit use (PolyForm Noncommercial), with a free 24-hour commercial trial after which
**write** tools freeze (reads keep working) until a commercial key is activated. On first use,
onboarding asks which tier applies. Owners issue keys with the offline generator in `owner/`
(never shipped — `.mcpbignore` excludes it); see `owner/README.md` for the
request → contract → issue-key → customer flow.

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
node --test                       # unit tests (158)
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
