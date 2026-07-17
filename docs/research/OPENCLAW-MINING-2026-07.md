# OpenClaw / original FeatureBoard mining — 2026-07-17

Ticket: FBMCPF-187. Read-only mining pass over the original FeatureBoard web app
to find ideas the MCP port missed or has since made possible. No board tickets
were created and no code was touched by this pass.

## Source located

Two copies of the original app exist under the sandbox mount. The **live/current**
one (larger, newer, most complete — used as the primary source below):

- `main_bot_dev/clawd-workspace/switcher/CommandServer.js` (301,726 bytes, 7,104
  lines, modified Jul 16 2026)
- `main_bot_dev/clawd-workspace/switcher/parseworkspace.js` (109,291 bytes, 2,378
  lines, modified Jun 1 2026)
- Front end: `main_bot_dev/clawd-workspace/switcher/public/FeatureBoard/` —
  `FeatureBoard.html`, `crm.html`, `leads_map.html`, `customer_portal.html`,
  `analytics.html`, `health_dashboard.html`, `generateMap.js`, `word_bank.json`,
  `data.json`, `MAP.md`, etc.

An older, smaller snapshot also exists at `main_bot_dev/pkg/` (CommandServer.js
195,086 bytes / 4,674 lines, parseworkspace.js 77,246 bytes / 1,728 lines,
modified Apr 2026) — this looks like a packaged/frozen build of an earlier
version of the same app. The `switcher/` copy is authoritative for this mining
pass since it is materially newer and a strict superset of routes.

`switcher/` also hosts several unrelated apps on the same Express server
(soccer roster tools, travel-dates server, a "switcher" for multiple projects,
and an "InfinitusPie" Google Business review-management module). Routes under
`/api/infinituspie/*` and the soccer/travel files were excluded from this
analysis as out-of-scope — they are a different product riding the same
`CommandServer.js`, not FeatureBoard.

## Method

- Enumerated all `app.get/post/put/delete` routes in `CommandServer.js` (166
  distinct routes).
- Enumerated all short-code commands in `parseworkspace.js` (`ss`, `pi`, `cf`,
  `ds`, `wt`, `wc`, `wp`, `bp`, `gentest`, `ft`/`fixtest`, `cwf`, `np`, `dl`,
  `up`, `bs`, `cm`/`cmab`, `em`, `dec`, `of`/`ob`, `co`, `gps`/`gis`, `gd`, `fs`,
  `mp`, `dc`/`dct`, `ip`, `dcto`, `cw`) — these are the verbs OpenClaw executed
  after CommandServer triggered it.
- Cross-referenced both against `featureboard-mcp/DESIGN.md` and
  `docs/TOOLS.md` (189 tools, read in full).

## Finding #1 (the big one): DESIGN.md's "Deliberately dropped" section is stale

DESIGN.md still reads as if CRM/leads/mail/marketing, media generation & gallery,
and most autonomous-analysis features were left out of scope. **They are not.**
The MCP has since grown to 189 tools and already covers nearly everything listed
as dropped:

| DESIGN.md says "dropped" | Actual state in server/ + TOOLS.md |
| --- | --- |
| "The CRM / leads / mail / marketing modules ... a different application" | Fully ported: `add_company`, `list_companies`, `add_contact`, `add_lead`, `set_lead_status`, `convert_lead`, `leads_map`, `add_lead_area`, `customer_portal`, `generate_contract`, `book_meeting`, `draft_email`, `list_mail`, `create_campaign`, `list_campaigns`, `add_crm_message`, `submit_crm_intake`, etc. — ~50 tools across `server/crm.js`, `server/leads.js`, `server/mail.js`, `server/campaigns.js`, `server/contracts.js`, `server/bookings.js`, `server/portal.js` |
| "Media generation & gallery ... a separate product concern" | Fully ported: `save_media`, `list_media`, `get_media`, `revert_media`, `tag_media`, `annotate_media`, `add_media_comment`, `search_media`, `upload_reference`, `edit_media`, `list_variations` — `server/media.js` |
| "Social publishing ... out of scope" | Partially ported: `draft_share`/`list_shares` (draft-only, no live post) exist in `server/social.js` — but see Finding #2 |
| "Autonomous background routines — predictive due-date adjustment, doc-sync monitors, scheduled cleanups" | The *analysis logic* is ported as on-demand tools (`predict_due_dates`, `drift_start/record/report/remediate`, `scan_board_cleanup`, `scan_test_cleanup`, `prune_board`) — only the *daemon/cron* wrapper is genuinely still missing, and Cowork scheduled tasks now make that trivial (see Finding #2) |

Recommendation: refresh DESIGN.md's "Deliberately dropped" section — it
undersells the product and will confuse anyone using it as an onboarding doc.
This is a documentation ticket, not a feature gap, but it's the single highest-
value finding of this pass because it's actively misleading right now.

## Finding #2: "deliberately dropped" items that are now viable but genuinely still absent

Two items really are still gaps, and both are newly viable given what's changed
since DESIGN.md was written (Cowork scheduled tasks, connectors):

1. **Live social publish + engagement tracking loop.** The original has a full
   closed loop that the MCP does not: `POST /api/capture-and-post` (Playwright
   screenshots a media/report HTML into N slides), a live post to X/LinkedIn,
   `POST /api/add-post-link` (records the resulting live URL back onto the
   media's `.meta.json` as `postLinks[]`), and `POST /api/scrape-social-metrics`
   (scrapes likes/views back for those links over time). The MCP only has
   `draft_share`/`list_shares` (copy only, "there is no live-publish connector"
   per its own docstring). Verified absent by grep — `server/social.js` and
   `server/media.js` have no `postLink`, `scrape`, or live-publish code.
   `claude-in-chrome` (already available to this session) or an X/LinkedIn MCP
   connector from the registry could now close this loop without FeatureBoard
   itself doing any scraping or auth.

2. **Autonomous/scheduled routines.** `predict_due_dates`, `drift_start/report`,
   `scan_board_cleanup`, `scan_test_cleanup` and the original's nightly test
   runner (`POST /api/nightly-tests/run`, which actually executes a project's
   `tests/` dir via `testrunner.js` and writes a timestamped HTML report —
   distinct from the MCP's `log_test_run`, which only *records* externally-run
   results) all exist as one-shot tools today. `mcp__scheduled-tasks__*` is
   available in this very session — a recurring task that calls
   `drift_start`→`drift_report`, or `scan_board_cleanup`, or runs a project's
   test suite and calls `log_test_run`, would restore the "nightly" cadence the
   original had, with zero new server code.

## Finding #3: genuine feature/verb gaps not explained by scope decisions

Mining `parseworkspace.js` commands and CommandServer routes turned up a
handful of verbs that map to nothing in the current 189-tool surface and
aren't covered by the "out of scope" categories above:

- **`mp` (MAP PROJECT) / `generateMap.js`** — walks a project's code tree and
  extracts function/method names per JS file via regex, producing a
  functionality→file map (`MAP.md`) at the *symbol* level. The MCP's
  `code_file_map` only reports file counts/bytes/extension breakdown and split
  candidates — no symbol extraction. This is a real, low-risk gap: a
  lightweight per-file function/export list would materially help
  `get_work_packet` point an agent at the right code without reading whole
  files.
- **`fs` (FILE SPLIT)** — turns a `code_file_map` "split candidate" into a
  structured refactor prompt (source file + a natural-language ask + whether
  to keep the original) for an agent to execute. `code_file_map` identifies
  the candidates but the MCP has nothing that turns a candidate into an
  actionable prompt, unlike `generate_test`/`suggest_test_stub`, which follow
  exactly this "return a ready-to-use prompt/stub" pattern for testing.
- **`cf` (CLOUDFLARE SETUP) / `bp` webProvider param** — the original's site
  deploy targets weren't git-only; it had a Cloudflare Pages/Workers path
  (`website/cloudflare/blog/...`) as an alternative to the git-push flow.
  `deploy_site` in the MCP is git-commit-and-push only. Lower priority — real
  Cloudflare/Netlify/Vercel deploy needs a connector or API keys, which cuts
  against the "no secrets stored" design principle the MCP has adopted (see
  below).
- **`ss` (SET SECRET, FBB-358)** — the original stored raw API keys/secrets
  inline in `project_config.json`. The MCP deliberately does **not** have an
  equivalent (`server/analytics.js`, `server/git.js` docstrings explicitly say
  "no secret is stored" and read keys from env vars instead, e.g.
  `FEATUREBOARD_ANALYTICS_KEY`). This is very likely the right call on security
  grounds, not an oversight — flagged here for completeness, not as a proposal.
- **`ip` (IMPORT PROJECT)** — generated an agent prompt to reverse-engineer an
  initial featurelist/buglist from an existing, unfamiliar codebase. Distinct
  from `import_tasks` (which requires already-structured text/CSV/JSON).
  Achievable today by combining `list_code_files`/`code_file_map`/
  `read_code_file` with Claude's own reasoning and `add_features_bulk`, so this
  is more a "worth a documented prompt" item than a new tool.
- **`dcto` (DEEP CLEAN TICK-OFF)** — let a human resolve a `scan_board_cleanup`
  flagged item with a reason *without* deleting it (e.g. "not actually a dupe,
  because..."). `prune_board` only deletes from the suggested-removal set; there
  is no way to dismiss a flagged item and have it stop resurfacing. Minor but
  cheap to add.

## Finding #4: confirmed correctly dropped, no action needed

- All UI/animation, drag-and-drop, theming — no MCP surface, correctly N/A.
- The entire OpenClaw trigger plumbing (`/api/trigger-work`, `/api/send-agent-message`,
  `/api/task-started-by-parseworkspace`, `/api/clear-sessions`, the `openclaw agent
  --agent featureboardcoding --message ...` exec pattern used by `fs`, `verify-bug-test`,
  etc., and the `cw` pre-task session-flush command) — correctly obsolete now
  that Claude is the agent, per DESIGN.md's core reframe.
- `/api/switch`, `/api/restart-server` — admin plumbing for the shared
  multi-app `switcher` server, not FeatureBoard-specific.
- `word_bank.json` / `save-word-bank` / `get-custom-words` and the
  `/api/infinituspie/*` review-management routes — belong to the neighboring
  InfinitusPie app, not FeatureBoard.

## Ranked ticket proposals

1. **[Docs] Refresh DESIGN.md "Deliberately dropped" section.** It currently
   claims CRM/leads/mail/marketing and media gallery are out of scope; both are
   fully shipped (189 tools). Actively misleading to anyone reading it as the
   architecture doc. `model: haiku` `cap: 40k` — pure doc edit, no research
   needed beyond this report.

2. **Ship a `create_scheduled_task`-based "nightly board health" recipe** (doc +
   maybe a thin helper prompt, not new server code): wires
   `mcp__scheduled-tasks__*` to call `drift_start`→score→`drift_report`,
   `scan_board_cleanup`, and `scan_test_cleanup` on a cadence, replacing the
   original's nightly cron. `model: sonnet` `cap: 150k` — needs a working
   example plus a short doc section, testable end-to-end.

3. **`code_file_map` symbol extraction (the `mp`/generateMap.js gap).** Add an
   optional per-file function/export list to `code_file_map` (or a new
   `map_symbols` tool) so work packets can point at the right function instead
   of the whole file. Regex-based like the original — no AST dependency
   required to match parity. `model: sonnet` `cap: 200k` — new server logic +
   tests in `server/explorer.js`.

4. **`suggest_file_split` tool** (the `fs` gap): given a `code_file_map` split
   candidate, return a structured refactor prompt (source path, target file
   list ask, keep-original flag) the same way `generate_test` returns a
   ready-to-use test file — read-only, Claude executes it. `model: sonnet`
   `cap: 120k`.

5. **Live social-publish loop via connector, not new FeatureBoard server code**
   (the `capture-and-post`/`add-post-link`/`scrape-social-metrics` gap):
   evaluate whether `claude-in-chrome` (screenshot a `list_media` HTML report +
   post to X/LinkedIn) plus a `postLinks` field on media metadata (small
   `save_media`/`tag_media`-adjacent addition) closes the loop without
   FeatureBoard doing any scraping or holding social credentials itself.
   `model: opus` `cap: 300k` — cross-cutting design decision (does this belong
   in FeatureBoard's server/social.js at all, or purely in a connector +
   prompt?) needs architecture judgment before implementation.

6. **`dcto`-equivalent: dismiss/annotate a `scan_board_cleanup` finding without
   deleting it.** Small addition alongside `prune_board` — e.g. a
   `dismissedIds` list persisted in project config that `scan_board_cleanup`
   excludes from future suggestions, with an optional reason. `model: sonnet`
   `cap: 80k`.

7. **Non-git `deploy_site` target (Cloudflare Pages or similar).** Lowest
   priority of the concrete gaps — real value is unclear without a specific
   user need, and it cuts against the "no secrets stored" design principle
   unless done via a connector that owns its own auth. Recommend holding until
   a user actually asks for it rather than speculatively building. `model:
   opus` `cap: 250k` if picked up — needs a design pass on where credentials
   live.

8. **Documented `ip`-equivalent prompt: "bootstrap a backlog from an existing,
   unfamiliar codebase."** No new tool needed — just a prompt/recipe combining
   `list_code_files` + `code_file_map` + `read_code_file` + `add_features_bulk`,
   written up similarly to the existing `daily_plan`/`evaluate_drift` prompts.
   `model: haiku` `cap: 60k`.
