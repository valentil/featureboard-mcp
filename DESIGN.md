# FeatureBoard MCP — design & feature mapping

This documents how the original FeatureBoard web app was ported to a local MCP
desktop extension (`.mcpb`), what came over, what was deliberately left behind,
and how the data model maps into the MCP environment.

## The core reframe

The original FeatureBoard is a web app: an HTML/JS front end, a `CommandServer.js`
backend, and `parseworkspace.js`, which triggered an external agent ("OpenClaw")
to do the actual work. The board's central gesture — *drag a card to "In Progress"
to trigger the agent* — assumed the agent lived somewhere else and had to be poked.

In an MCP plugin, **Claude is the agent.** The board no longer needs to trigger
anything; it needs to be a store Claude can read and write. So the port keeps the
board's data and its verbs (add feature, log bug, move status, link, decompose)
and drops the entire "trigger an external agent" machinery. The board becomes
Claude's shared, on-disk task memory for a project.

## Storage model

Source of truth stays markdown, byte-compatible with the original app so existing
boards ("projectpads") work with zero migration:

```
<boards folder>/
  FeatureBoard/
    featurelist.md      # features, one per line: - [ ] [FBF-12] **Title**: desc [Created: … | Due: …]
    buglist.md          # bugs, same format with FBB- ids
  My Other Project/
    featurelist.md
    buglist.md
  .featureboard/
    index.json          # per-prefix counter cache for fast, collision-free id allocation
```

Design choices that matter:

- **Markdown is authoritative; JSON is a cache.** Before allocating a ticket id we
  re-scan the markdown for the highest existing number, then reconcile with the
  cached counter. This means ids never collide even if the JSON index is deleted,
  and hand-edits to the markdown are always respected.
- **Prefix is inferred from existing tickets first.** A board whose tickets are
  `FBF-###` keeps using `FB` regardless of its folder name; only empty boards fall
  back to name-derived initials (`FeatureBoard` → `FB`, `My New App` → `MNA`),
  matching the original camelCase-splitting logic.
- **Writes are atomic** (temp file + rename) so a crash mid-write can't corrupt a
  board.
- **Line format is preserved exactly**, including `🔗 LINK`, `[Product: …]`,
  `[Labels: …]`, `[NewFile: …]`, `[Website: …]`, and `Summary: …` completion notes,
  so the original web UI could still open the same files. The `NewFile` (build in a
  new file) and `Website` flags the original parser understood are read into task
  fields and written back rather than silently dropped on edit.

## Feature triage

### Ported directly (the core board)
- Projects / multi-board support (`list_projects`, `create_project`)
- Features and bugs with full CRUD (`add_feature`, `log_bug`, `update_task`,
  `delete_task`, `get_task`, `list_tasks`)
- Status model Todo / In Progress / Done (`set_status`) with completion summaries
- Metadata: due dates, created dates, products, labels, linked issues
- Filtering and search (by type, status, product, label, free text)

### Adapted to the AI-native model
- **Brainstorm → `add_features_bulk`.** Originally this shelled out to the agent to
  invent features, then parsed the result back. Now Claude does the ideation
  natively and this tool just persists the batch.
- **Decompose → `decompose_feature`.** Same shape: Claude produces the subtasks,
  the tool creates them (each linked to the parent) and retires the parent.
- **Velocity / analytics → `get_metrics`.** The heavy SVG timeline and token-cost
  graphs were UI. The underlying counts (open/closed features and bugs, completions
  by date) survive as a read-only tool Claude can summarize however it likes.

### Deliberately dropped
- **All UI and animation** — Kanban rendering, drag-and-drop, the dancing-lobster
  progress animations, dark/light theme. An MCP server has no UI surface.
- **OpenClaw trigger plumbing** — `parseworkspace.js`, `CommandServer` HTTP
  endpoints, SSE task broadcasting, pre-task session flushing. Replaced wholesale
  by the MCP protocol.
- **Social publishing** — share-to-X / LinkedIn. Out of scope for a task board and
  better served by a dedicated connector.
- **Media generation & gallery** — image/report generation, tagging, annotations,
  version history. This is a separate product concern; it could become its own
  plugin later.
- **The CRM / leads / mail / marketing modules** — these grew on top of FeatureBoard
  but are a different application. Keeping the plugin to "a board Claude can manage"
  makes it publishable and reviewable.
- **Autonomous background routines** — predictive due-date adjustment, doc-sync
  monitors, scheduled cleanups. MCP servers are request/response with no daemon;
  where these are still wanted, they belong in a scheduled task that calls the tools.

## Why this scope is the right v1

The Connectors Directory review favors a tight, well-annotated tool surface with a
clear purpose. "A local markdown task board Claude can read and write" is a single
coherent capability with 13 focused tools, every one annotated with read-only /
destructive hints. The CRM/media/marketing surface would triple the tool count,
pull in concerns (outbound social posts, contact data) that complicate review, and
dilute the pitch. Those can ship as follow-on plugins that read the same folder.
