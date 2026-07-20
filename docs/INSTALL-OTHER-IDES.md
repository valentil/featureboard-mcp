# Installing FeatureBoard in other agent IDEs (Cursor, Grok Build, any MCP client)

FeatureBoard is a plain **stdio MCP server** (`node server/index.js`, Node.js >= 18, deps:
`@modelcontextprotocol/sdk` + `zod`). Nothing about the protocol surface is Claude-specific —
verified against server v0.6.2 with a raw JSON-RPC client (`clientInfo: "cursor-test"`):
clean `initialize` (protocol `2025-06-18`), **196 tools** in the default toolset, **67 tools**
with `FEATUREBOARD_CORE_ONLY=1`.

## Get the server

```bash
git clone <repo-url> featureboard-mcp
cd featureboard-mcp
npm install        # installs the two runtime deps into node_modules
```

Or build an npm-style tarball from a checkout (nothing is published to the npm registry):

```bash
npm pack           # -> featureboard-mcp-0.6.2.tgz (~580 kB; .mcpb bundles and node_modules excluded)
# unpack anywhere, then `npm install` inside the unpacked package/ dir
```

Either way, the command every MCP client runs is the same:

```
node /absolute/path/to/featureboard-mcp/server/index.js
```

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `FEATUREBOARD_DATA_DIR` | `~/FeatureBoard` | Folder holding your boards (each subfolder with `featurelist.md`/`buglist.md` is a board). |
| `FEATUREBOARD_CORE_ONLY=1` | off (196 tools) | Trim to the 67 core board/task tools. Strongly recommended outside Claude — see the Cursor tool-limit note below. (`FEATUREBOARD_TOOLS=core` is the equivalent legacy spelling.) |
| `FEATUREBOARD_CLIENT_NEUTRAL=1` | off | Serve IDE-neutral server instructions. The default instructions are written for Claude Cowork (artifacts, sub-agent dispatch conventions); the neutral set drops those and describes `get_board` as an HTML file your IDE can save and open. Set this in any non-Claude host. |

## Cursor

Cursor reads MCP servers from `.cursor/mcp.json` in the project root (project-scoped) or
`~/.cursor/mcp.json` (global); project entries win on name clashes. stdio fields are
`type`/`command`/`args`/`env`, with `${env:NAME}`, `${userHome}` and `${workspaceFolder}`
interpolation supported. Source: [Cursor MCP docs](https://cursor.com/docs/mcp).

```json
{
  "mcpServers": {
    "featureboard": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/featureboard-mcp/server/index.js"],
      "env": {
        "FEATUREBOARD_DATA_DIR": "${userHome}/FeatureBoard",
        "FEATUREBOARD_CORE_ONLY": "1",
        "FEATUREBOARD_CLIENT_NEUTRAL": "1"
      }
    }
  }
}
```

> **Tool limit — this matters.** Cursor caps the tools it sends to the agent at **about 40
> across all enabled MCP servers**, warning e.g. *"You have 50 tools from enabled servers.
> The limit is 40 tools — some tools may not be available to the agent"* and silently
> dropping the rest. This is community-documented (Cursor
> [forum](https://forum.cursor.com/t/tools-limited-to-40-total/67976)
> [threads](https://forum.cursor.com/t/mcp-server-40-tool-limit-in-cursor-is-this-frustrating-your-workflow/81627)
> and [cursor/cursor#3369](https://github.com/cursor/cursor/issues/3369)), not stated on the
> official MCP docs page — treat the exact number as subject to change. Practical upshot:
> never run the full 196-tool surface in Cursor; set `FEATUREBOARD_CORE_ONLY=1` (67 tools)
> **and** switch off the tools you don't use from **Settings → MCP → featureboard** to get
> under the ceiling. The board flow needs roughly: `list_projects`, `create_project`,
> `plan_work`, `list_tasks`, `get_task`, `add_feature`, `log_bug`, `next_task`, `set_status`,
> `get_work_packet`, `log_work`, `update_task`, `decompose_feature`, `get_metrics`,
> `get_board`, `get_scratchpad`, `set_scratchpad`.

### Cursor distribution channels

Two channels exist; **both need a human with accounts — nothing here can be automated from
this repo**:

1. **Official Cursor Marketplace** — [cursor.com/marketplace](https://cursor.com/marketplace),
   submissions at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).
   Requires: a public open-source repo, a `.cursor-plugin/plugin.json` manifest (see the
   [plugin template](https://github.com/cursor/plugin-template)), and manual review by the
   Cursor team. **Caution:** Cursor states all marketplace plugins "must be open source";
   FeatureBoard ships under PolyForm Noncommercial + a commercial license — whether that
   qualifies needs a human judgement call (or an ask to Cursor support) before submitting.
2. **cursor.directory (community)** — submit at
   [cursor.directory/plugins/new](https://cursor.directory/plugins/new): sign in with GitHub
   or Google, paste a **public GitHub repo URL**; components are auto-detected per the
   [Open Plugins standard](https://open-plugins.com) — MCP servers are picked up from a
   **`.mcp.json` at the repo root**, which this repo does not currently ship. Submissions get
   an automated security scan and admin review.

**Prepared submission metadata (paste as-is):**

- **Name:** FeatureBoard
- **Short description:** A markdown-backed feature/bug board your agent manages over MCP —
  plan work into tickets, pull one focused work packet at a time, and track status, metrics,
  and work logs on disk you own.
- **Long description:** FeatureBoard turns a folder of markdown files into a full task board
  for AI agents. `plan_work` decomposes a request into features (FBF-###) and bugs (FBB-###);
  `next_task` + `get_work_packet` feed the agent one focused brief at a time (scope, code
  location, definition of done); `set_status`/`log_work` keep an honest, human-readable
  record. Includes sprints, velocity metrics, requirements/acceptance checks, a knowledge
  base, and an optional 196-tool extended surface (CRM, media, marketing-site, git
  integration). Local-first: your data is plain markdown in `FEATUREBOARD_DATA_DIR`. For
  Cursor, run with `FEATUREBOARD_CORE_ONLY=1` and `FEATUREBOARD_CLIENT_NEUTRAL=1`.
- **Category/tags:** productivity, project-management, task-board, agile, MCP server
- **Requirements:** Node.js >= 18. No API keys; no network access needed.

**Human to-do (Cursor):** create/confirm the public GitHub repo → resolve the open-source
licensing question → add root `.mcp.json` (directory) or `.cursor-plugin/plugin.json`
(marketplace) → sign in and submit at the URLs above → respond to review feedback.

## Grok Build

Grok Build (xAI's agentic CLI) has first-class MCP support. Source:
[docs.x.ai/build/features/mcp-servers](https://docs.x.ai/build/features/mcp-servers)
(last updated 2026-07-02). Quickest path:

```bash
grok mcp add featureboard -- node /absolute/path/to/featureboard-mcp/server/index.js
```

Or declare it in `~/.grok/config.toml` (use `--scope project` / `.grok/config.toml` to ship
it with a repo). `${VAR}` in `command`/`args`/`env` expands from the environment at load time:

```toml
[mcp_servers.featureboard]
command = "node"
args = ["/absolute/path/to/featureboard-mcp/server/index.js"]
env = { FEATUREBOARD_DATA_DIR = "${HOME}/FeatureBoard", FEATUREBOARD_CORE_ONLY = "1", FEATUREBOARD_CLIENT_NEUTRAL = "1" }
```

Useful to know:

- `grok mcp list` / `grok mcp doctor featureboard` diagnose config and connectivity; stdio
  stderr is captured to `~/.grok/logs/mcp/featureboard.stderr.log`. `/mcps` in the TUI
  toggles servers.
- **Claude/Cursor compat:** Grok Build also loads MCP config from `~/.claude.json`,
  `.cursor/mcp.json`, and project `.mcp.json` automatically — if you already set FeatureBoard
  up for Claude Code or Cursor, Grok Build picks it up with zero reconfiguration.
- No documented hard tool cap like Cursor's 40, but 196 tool schemas still tax the context —
  `FEATUREBOARD_CORE_ONLY=1` is the sensible default here too, and
  `FEATUREBOARD_CLIENT_NEUTRAL=1` keeps the server's instructions from referencing Cowork
  artifacts that Grok can't render.

### Grok Build distribution channels

There is **no central xAI-run submission channel** for third-party MCP servers as of July
2026 (nothing verifiable in the [Skills, Plugins & Marketplaces
docs](https://docs.x.ai/build/features/skills-plugins-marketplaces)). Distribution is
decentralized:

- Users add marketplace *sources* (`[[marketplace.sources]]` in `~/.grok/config.toml`) and
  install plugins from them — a plugin bundles skills/agents/hooks/**MCP servers**.
- Grok Build reads **Claude Code marketplaces and plugins with zero configuration**, so a
  Claude Code-format plugin marketplace repo covers Grok Build users too.

**Human to-do (Grok Build):** none mandatory. Optional: publish a public git repo in Claude
Code plugin/marketplace format wrapping this server and document
`grok mcp add featureboard -- node .../server/index.js` as the one-liner; no account or
review process involved.

## Any MCP client

Generic stdio recipe — every value verified live against v0.6.2:

- **Command:** `node /absolute/path/to/featureboard-mcp/server/index.js`
  (Node.js >= 18 per `package.json` engines; run `npm install` in the checkout first)
- **Transport:** stdio only (no HTTP/SSE endpoint)
- **Env:** `FEATUREBOARD_DATA_DIR` (defaults to `~/FeatureBoard` when unset),
  `FEATUREBOARD_CORE_ONLY=1` for 67 tools instead of 196,
  `FEATUREBOARD_CLIENT_NEUTRAL=1` for host-agnostic instructions
- **Sanity check:** `initialize` → `tools/list` should return 196 tools (67 in core mode);
  `npm run smoke` in the checkout runs a fuller end-to-end pass.

`get_board` outside Claude: it still returns the full board UI as one self-contained HTML
document, but its live panels call back into the MCP server via a Cowork-only bridge. In
other IDEs, save the `html` field to a file and open it in a browser/preview as a static
snapshot — or just ask the agent for status (`list_tasks`, `get_metrics`) in text.

## Which package is for which host?

| Artifact | Host | Anything else? |
| --- | --- | --- |
| `featureboard-*.mcpb` | Claude Desktop only (MCPB bundle + `manifest.json` user-config UI) | No |
| `releases/featureboard.plugin` | Claude Cowork only | No |
| Repo checkout / `npm pack` tarball | **Any MCP client** (Cursor, Grok Build, generic) | Yes — this is the portable path |

`npm pack` works today without repo changes: `package.json` has no `files` field, so npm
falls back to `.gitignore`, which already excludes `node_modules/` and `*.mcpb` — the result
is a ~580 kB / 204-file tarball containing the server, board UI, docs, and tests. Run
`npm install` inside the unpacked directory before first start. The tarball is **not**
published to the npm registry.
