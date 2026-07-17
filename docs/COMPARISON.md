# FeatureBoard vs Cline Kanban vs 8090 vs Vibe Kanban

_Compiled July 2026. Competitor products move fast — verify current claims on their own sites
before citing this doc. FeatureBoard claims are sourced from this repo's own docs
(`docs/compliance/PRIVACY.md`, `docs/TOOLS.md`). The full styled version lives at
[featureboard.ai/compare.html](https://featureboard.ai/compare.html)._

## The opening: Vibe Kanban's sunset

On April 10, 2026, Bloop — the company behind Vibe Kanban — shut down. The vast majority of
Vibe Kanban's users were on the free tier, and the company couldn't find a business model it
could get excited about. Vibe Kanban itself continues as a community-maintained, Apache-2.0
open-source project; in the process it dropped its hosted cloud services (kanban issues,
comments, projects, orgs) in favor of a fully local architecture.

That's a useful data point for the category: a board that orchestrates coding agents is clearly
worth having, but the hosted-service business model wrapped around it is still unproven
industry-wide. FeatureBoard never depended on that model — it was local-first from the start.

## Feature by feature

| Dimension | FeatureBoard | Cline Kanban | 8090 Software Factory | Vibe Kanban |
| --- | --- | --- | --- | --- |
| **Board data format** | Plain markdown files you own (`featurelist.md`, `buglist.md`) — readable, diffable, git-friendly, portable to any editor. | Local git worktrees + app-managed local state per task card; not designed as a portable backlog format. | Cloud-native workspace (requirements, architecture decisions, work orders); offers markdown export/round-trip of docs and conversations. | Now local by default after the shutdown; original design was a local SQLite-backed kanban UI with optional cloud sync (since removed). |
| **Local-first / telemetry** | Runs entirely on your machine. No analytics, no telemetry, no outbound requests except two explicit opt-in exceptions (commercial license request, onboarding email). | Free app; runs local git worktrees and terminals on your machine. | Hosted SaaS control plane ($200/user/mo self-serve, custom enterprise); data lives in 8090's platform, with audit trails aimed at regulated industries. | Post-shutdown: fully local architecture, community-maintained, Apache-2.0 open source. |
| **Runs as a Claude/Cowork artifact** | Yes — `get_board` returns a self-contained HTML board rendered directly as a Cowork artifact; no separate app to open. | No — separate CLI-launched browser app (`cline --kanban`). | No — separate hosted web platform. | No — separate app (desktop/browser), independent of any AI assistant's UI. |
| **Token budgeting** | `cap:<tokens>` labels per ticket, `estimate_work` for per-ticket estimates from board history, and `plan_budget` to map a budget onto the priority queue before you spend it. | Per-session context-usage bars and token/cost breakdowns in the UI (observability), but no declarative per-task budget or backlog-level budget planning found. | Usage-based token billing on top of the seat price; not a self-service budgeting/capping feature for planning a backlog. | Not a documented feature; the product is an orchestration UI for agent runs, not a budgeting layer. |
| **Model tiering** | `model:<name>` labels plus `daily_plan`, which auto-assigns a model tier per ticket (e.g. architecture vs. mechanical work) from a defined roster. | Model-agnostic by design — you choose which backend (Cline, Claude Code, Codex) runs a given card, but assignment is manual, not policy-driven by ticket complexity. | Uses third-party AI agents under the hood; tiering/model-selection logic isn't publicly documented. | Agent-agnostic orchestration; model choice is per-run, not a backlog-wide tiering policy. |
| **Eval / drift harness** | `drift_start`/`drift_record`/`drift_report`/`drift_remediate` — samples or fully scores Done tickets against the actual code, with a confidence interval on drift rate. | Diff review and inline comments per card; no documented statistical drift-scoring harness against completed work. | Audit trails for compliance; not the same as a fidelity-scoring harness comparing spec vs. shipped code. | Not a documented feature. |
| **Full ticket audit timeline** | `get_ticket_history` merges recorded status/label/priority events with work-log entries into one chronological timeline per ticket. | Card detail view shows diffs and comments; not a unified status/event audit log. | Audit trails are a stated feature, positioned for regulated-industry compliance. | Not a documented feature. |
| **Per-board knowledge base** | `kb/` folder per board with keyword search (`search_kb`), auto-surfaced into ticket work packets. | Not a documented feature. | Requirements/architecture-decision docs live in the platform, closer in spirit but tied to the hosted workspace. | Not a documented feature. |
| **Primary focus** | Full backlog/PM board (features, bugs, sprints, ADRs) plus CRM, site, and eval tooling — an MCP server Claude drives directly. | Parallel multi-agent orchestration over git worktrees — an execution layer for running several coding agents at once. | Enterprise SDLC control plane — requirements → architecture → work orders → code, with compliance/audit framing (e.g. the EY.ai PDLC partnership). | Open-source kanban UI for orchestrating coding agents — same category as Cline Kanban, now community-run. |
| **Pricing / openness** | MCP server; local data, no hosted service to pay for to keep your board alive. | Free, currently labeled a research preview. | $200/user/mo self-serve + token usage; enterprise plans from $1M/yr fully managed. | Free, Apache-2.0, community-maintained (company behind it shut down April 2026). |
| **Measured: agent focus** | 1.76x less diff churn vs. raw-ask (837 vs 1,471 additions); n=10, sonnet tier, equal correctness (10/10 both); see [docs/EVAL-BOARD-VS-CHAT.md](../docs/EVAL-BOARD-VS-CHAT.md). | Not measured in public eval data. | Not measured in public eval data. | Not measured in public eval data. |

## Where each one is coming from

**FeatureBoard — the board is a file, not a service.** Your backlog is markdown on disk. Nothing
to host, nothing phoning home, nothing that disappears if a vendor's business model doesn't pan
out. It renders as a Cowork artifact and comes with budgeting and model-tiering built into the
same MCP surface you already use to plan and work tickets.

**Cline Kanban — parallel execution, not backlog management.** Cline Kanban is strong at what
it's built for: spinning up isolated git worktrees so several coding agents (Cline, Claude Code,
Codex) can run in parallel, with dependency chains between cards. It's a research preview and is
oriented around running agent sessions, not long-lived product-management concerns like sprints,
ADRs, or drift auditing.

**8090 Software Factory — enterprise SDLC, cloud-hosted.** 8090 goes deep on requirements,
architecture decisions, and compliance audit trails for regulated industries — reflected in its
EY.ai PDLC partnership and enterprise pricing. It's a heavier, hosted platform aimed at large
organizations, not a local-first tool an individual developer runs for free.

**Vibe Kanban — open source, but the company is gone.** Vibe Kanban proved there's real demand
for a kanban layer over coding agents — and then its maker, Bloop, shut down because it couldn't
find a business model most of its (mostly free) users would pay for. The project lives on as
community-maintained open source, now fully local. Worth watching, but its future maintenance
pace depends on volunteers.

## Sources

- [Vibe Kanban — Shutdown announcement](https://www.vibekanban.com/blog/shutdown)
- [BloopAI/vibe-kanban on GitHub (Apache-2.0, community-maintained)](https://github.com/BloopAI/vibe-kanban)
- [Cline — Announcing Cline Kanban](https://cline.ghost.io/announcing-kanban/)
- [Cline Kanban docs](https://docs.cline.bot/kanban/overview)
- [8090 — Software Factory](https://www.8090.ai/software-factory)
- [EY + 8090 — EY.ai PDLC launch](https://www.ey.com/en_us/newsroom/2026/03/ernst-young-llp-and-8090-launch-ey-ai-pdlc)
- [8090 — $135M Series A](https://www.businesswire.com/news/home/20260626795833/en/8090-Raises-$135M-Series-A-to-Accelerate-Their-Rollout-of-Software-Factory)
