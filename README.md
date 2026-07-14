# FeatureBoard (MCP desktop extension)

A local, file-backed feature/bug board for your projects — packaged as a Claude
Desktop extension (`.mcpb`). Claude reads and writes your `featurelist.md` /
`buglist.md` boards directly, so planning, logging bugs, moving tickets, and
reviewing velocity all happen in chat.

It uses the same markdown format as the original FeatureBoard app, so existing
project folders work with no migration.

## What it does

Point the extension at a folder of project boards. Each subfolder containing a
`featurelist.md` or `buglist.md` is a board. Then ask Claude things like:

- "What's open on the FeatureBoard project?"
- "Log a bug: gallery preview modal won't dismiss on mouse-out."
- "Brainstorm five features for the onboarding flow and add them."
- "Move FBF-207 to done — summary: fixed the parser regex."
- "Break FBF-300 into subtasks."
- "How's velocity looking this week?"

## Tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | List all boards under the folder |
| `create_project` | Create a new board (empty featurelist/buglist) |
| `list_tasks` | List/filter features & bugs (type, status, product, label, search) |
| `get_task` | Full details for one ticket |
| `add_feature` | Add a feature (→ `FBF-###`) |
| `log_bug` | Log a bug (→ `FBB-###`) |
| `add_features_bulk` | Add many features at once (brainstorm) |
| `update_task` | Edit fields on a ticket |
| `set_status` | Move Todo / In Progress / Done (+ completion summary) |
| `decompose_feature` | Replace a feature with linked subtasks |
| `link_tasks` | Link one ticket to another |
| `delete_task` | Remove a ticket |
| `get_metrics` | Counts, completions-by-date, and work-log velocity |
| `get_project_config` / `set_project_config` | Board settings: products, code location, agent model, website |
| `add_product` / `remove_product` | Manage a board's product list |
| `log_work` / `get_work_log` | Append/read work events (tokens, additions/deletions, model) |
| `get_health` | Composite 0-100 health score with breakdown |
| `license_status` | Current tier, whether writes are allowed, trial time left |
| `set_usage_type` | Onboarding: personal / public / commercial-trial / commercial |
| `activate_license` | Activate a commercial license key (verified offline) |
| `request_commercial_license` | Start commercial licensing; records the request |

`list_tasks` is paginated and returns a compact view by default (`limit`, `offset`,
`compact:false`) so large boards don't blow the context budget. Write tools echo the
exact post-write line. Tickets can carry an external `ref` (e.g. a plan item `WI-1.2`).

See `DESIGN.md` for what was ported from the original app and what was left out.

## Licensing

FeatureBoard is source-available (see `LICENSE.md`): free for private non-commercial
and public/nonprofit use (PolyForm Noncommercial), with a free 24-hour commercial
trial after which **write** tools freeze (reads keep working) until a commercial key
is activated. On first use, onboarding asks which tier applies. Owners issue keys with
the offline generator in `owner/` (never ship that folder — `.mcpbignore` excludes it);
see `owner/README.md` for the request → contract → issue-key → customer flow.

## Board view (Cowork artifact)

`artifact/board.html` is a live Kanban that renders any board through these tools —
columns, cards with due dates / products / labels / refs, click-to-move status, a
metrics strip, and the licensing onboarding. It refreshes from the connector each time
it opens.

> After installing or updating the extension, fully **restart Claude Desktop** so the
> new tools (pagination, licensing) load.

## Build

Requires Node 18+.

```bash
npm install                    # install the MCP SDK + zod
npm install -g @anthropic-ai/mcpb
mcpb pack                       # produces featureboard.mcpb
```

Then install by double-clicking `featureboard.mcpb`, or via
Claude Desktop → Settings → Extensions → Advanced → Install Extension. On first
run it will ask for your **Boards folder**.

## Git integration (optional)

FeatureBoard can commit — and optionally push — your code repo per finished ticket,
the way the original app did (`git add`/`commit`/`push` on your machine). It's
**opt-in and off by default**, and stores **no secrets**: pushing uses your machine's
own git credentials (credential manager / SSH), just like running git yourself.

```
set_git_config   project=MyApp enabled=true branch=main push=true
# point the board at the repo:
set_project_config project=MyApp codeLocation="/path/to/repo"
# then, when a ticket is done:
commit_feature   project=MyApp ticket=FBF-42 title="Login flow"
#   → git add . && git commit -m "FBF-42: Login flow" && git push origin main
```

`get_git_config` shows the current settings; `commit_feature` no-ops with a reason
when integration is disabled. Config lives in the board's `git.config.json`.

## Data & storage

- Boards are plain markdown; a `.featureboard/index.json` sidecar caches the ticket
  counter. Markdown is always authoritative.
- Ticket ids are inferred from existing tickets in each file, so any board keeps its
  prefix regardless of folder name.
- Writes are atomic (temp-file + rename).

## Development

```bash
FEATUREBOARD_DATA_DIR=/path/to/boards npm start   # run the server over stdio
node --test                                        # run tests
```

### Nightly tests

`npm run nightly` runs the suite headlessly per `nightly_tests.json` and records a
timestamped result under `.featureboard/nightly/` (kept to `keepRuns`). The exit code
mirrors the run (0 pass / non-zero fail) so a scheduler can alert on regressions, and
if `testLogPath` points at a board's `test_runs.md` the result is appended there in the
testing-center format, so `get_test_runs` and the board's 🧪 Tests panel surface nightly
runs next to manual ones.

```jsonc
// nightly_tests.json
{
  "enabled": true,
  "schedule": "0 3 * * *",       // documents the intended cadence for whatever schedules it
  "command": "npm", "args": ["test"],
  "timeoutMinutes": 10,
  "resultsDir": ".featureboard/nightly",
  "keepRuns": 30,
  "notifyOnFailureOnly": true,
  "testLogPath": null            // e.g. "…/projectpads/FeatureBoardMCP/test_runs.md" to feed the board
}
```

MCP servers have no daemon, so scheduling lives outside the server — point a scheduler at
the script:

```bash
# cron (3am daily)
0 3 * * * cd /path/to/featureboard-mcp && npm run nightly
# Windows Task Scheduler
schtasks /create /tn FeatureBoardNightly /sc daily /st 03:00 ^
  /tr "cmd /c cd /d C:\path\to\featureboard-mcp && npm run nightly"
```

## License

MIT © Lewis Valentine
