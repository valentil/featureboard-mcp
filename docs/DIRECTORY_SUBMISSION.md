> **Current stats (0.6.1, 2026-07-19):** ~195 tools · 750 passing tests · self-serve commercial licensing live at featureboard.ai/buy.

# Connectors Directory — submission checklist

Preflight for submitting **FeatureBoard** (`featureboard-mcp`) to the Claude
Connectors Directory. Regenerate the tool surface with `npm run docs` before each
submission so `manifest.json` and `docs/TOOLS.md` match the code.

## 1. Packaging

- [ ] `package.json` and `manifest.json` versions match (checked by `npm run build`).
- [ ] `npm run check` passes (server files parse).
- [ ] `npm test` passes (`node --test`).
- [ ] `npm run docs` run — `manifest.json` `tools` array matches the registered tools.
- [ ] `.mcpbignore` excludes `owner/`, `test/`, `artifact/`, `*.test.js`, keys, and dev files.
- [ ] `icon.png`, `README.md`, and `LICENSE.md` present.
- [ ] Bundle builds: `npm run bundle` (mcpb CLI) produces `featureboard-<version>.mcpb`.

## 2. Tool annotations

Every tool declares MCP annotation hints so the directory can classify it. Verify
in `server/index.js` that each `registerTool` sets appropriate hints:

- **Read-only** tools (`readOnlyHint: true`): `list_projects`, `list_tasks`,
  `get_task`, `next_task`, `get_metrics`, `get_health`, `get_work_log`,
  `get_work_packet`, `get_project_config`, `get_scratchpad`, `get_test_runs`,
  `get_regressions`, `suggest_test_stub`, `bug_impact_scan`, `license_status`.
- **Write** tools (`destructiveHint: false`): `create_project`, `add_feature`,
  `log_bug`, `add_features_bulk`, `import_tasks`, `plan_work`, `update_task`,
  `set_status`, `link_tasks`, `add_attachment`, `log_work`, `log_test_run`,
  scratchpad/config setters, licensing setters.
- **Destructive** tools (`destructiveHint: true`): `delete_task`,
  `decompose_feature` (deletes the parent), `remove_attachment`,
  `remove_product`, `set_scratchpad` (overwrites).

See `docs/TOOLS.md` for the generated access badge per tool.

## 3. Privacy & data handling

- [ ] Include `docs/compliance/PRIVACY.md` (data stays local; see below).
- [ ] Confirm network egress is limited to the deliberate, disclosed exceptions —
      the full inventory (see `docs/compliance/PRIVACY.md` § Exceptions):
      Slack (`notify_slack`, only when a project sets `slackWebhook`), git push
      (`deploy_site` / `commit_feature`, only when git integration is enabled with
      `push:true`), the analytics read proxy (`get_site_traffic`, only when a
      provider is configured and `FEATUREBOARD_ANALYTICS_KEY` is set), git worktree
      management (`create_worktree` / `cleanup_worktree` — local git subcommands
      only, no network call despite the annotation), `request_commercial_license`
      (writes locally, returns a mailto/URL — no automatic transmission), and
      `register_email` (the tier-picker onboarding's optional email field — stores
      locally and POSTs once to the featureboard.ai registrations listener, and
      only on explicit "Save email" submit). No usage telemetry anywhere.
      Otherwise the server only reads/writes the local boards folder
      (`FEATUREBOARD_DATA_DIR`) or the project's own code repo on disk.
- [ ] `openWorldHint` is `false` on all tools except `notify_slack`, `deploy_site`,
      `commit_feature`, `get_site_traffic`, `create_worktree`, `cleanup_worktree`,
      `request_commercial_license`, and `register_email`.
- [ ] License-request data (`request_commercial_license`) is written locally for
      the licensor's records; document this in the listing.
- [ ] Onboarding email (`register_email`) is written locally
      (`.featureboard/registration.json`) and POSTed once to the featureboard.ai
      registrations listener only after explicit user submit; document this in the
      listing alongside the license-request exception.

## 4. Per-tool example calls

A few representative calls a reviewer can run against a scratch board:

```jsonc
// Create a board
{ "tool": "create_project", "args": { "name": "Demo", "description": "trial board" } }

// Plan work onto it
{ "tool": "plan_work", "args": { "project": "Demo", "createProject": false,
  "features": [{ "title": "Login screen", "priority": 1 }],
  "bugs": [{ "title": "Crash on empty form" }] } }

// Import an existing backlog (auto-detected format)
{ "tool": "import_tasks", "args": { "project": "Demo",
  "content": "- [ ] Dark mode\n- [ ] CSV export: download the board", "dryRun": true } }

// Pull and work the queue
{ "tool": "next_task", "args": { "project": "Demo" } }
{ "tool": "set_status", "args": { "project": "Demo", "ticket": "DF-1", "status": "In Progress" } }
{ "tool": "get_work_packet", "args": { "project": "Demo", "ticket": "DF-1" } }
{ "tool": "set_status", "args": { "project": "Demo", "ticket": "DF-1", "status": "Done",
  "completionSummary": "Built the login screen", "additions": 120, "deletions": 4 } }

// Read-only overviews
{ "tool": "get_metrics", "args": { "project": "Demo" } }
{ "tool": "get_regressions", "args": { "project": "Demo" } }
```

## 5. Listing copy

- [ ] Short description ≤ 1 sentence (see `manifest.json` `description`).
- [ ] Long description covers the markdown-compatible storage model and the
      "Claude is the agent" workflow (see `manifest.json` `long_description`).
- [ ] Screenshots of the board artifact (light + dark) and the analytics card.
