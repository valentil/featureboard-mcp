---
name: featureboarding
description: Board substantive dev requests on FeatureBoard automatically and churn them with parallel sub-agents. Use when the user asks to build, fix, ship, implement, refactor, or "work on" anything non-trivial in a project — they should NOT have to say "put it on the board".
---

# Featureboarding

Run the FeatureBoard churn loop end to end: board the work, then work the board.

## 1. Board it — no permission needed

A substantive dev request (build/fix/ship/refactor/implement X) IS a boarding event.
Call `plan_work` immediately (it creates the project too, if one doesn't exist yet).
Never ask "should I put this on the board?" — just do it, then get to work.

## 2. Research first (default ON)

Before implementing, cheap models scout for the expensive one. For each freshly
boarded ticket that is `effort:high`, a `research-pick`, or labelled `research:on`
— and where `researchOnIntake` isn't off (a `research:off` label opts a ticket out)
— call `prepare_research` and dispatch the returned packet to a **haiku/sonnet**
sub-agent (its `suggestedModel`) as that agent's brief. Research sub-agents run in
PARALLEL; each returns a collated markdown brief (≤ ~150 lines): recommended
approach + runners-up, prior-art pointers, one competitor idea, risks/invariants.

The ORCHESTRATOR — never the sub-agent — saves each returned brief via `add_kb_doc`
with title `research/<ticket>` BEFORE dispatching implementation. From then on, the
implementing agent's `get_work_packet` auto-attaches that brief as `researchBrief`,
alongside relevant local `ragChunks` (BM25 over KB/docs/ticket-history — zero tokens,
zero network) — so the expensive model starts with context, not a cold read.

## 3. Churn the queue

- Call `next_task` to pull the next open ticket (it honours manual priority).
- Read its `dispatch` block (`{subAgent, model, cap, parallelizable, instruction}`) — obey it.
- If `dispatch.subAgent` is set, spawn a sub-agent on `dispatch.model` and hand it the
  work packet as its brief.
- Parallelize: tickets whose `dispatch.parallelizable` is true AND whose files don't
  overlap can run as concurrent sub-agents. Tickets on `opus`/`fable` run sequentially
  in the orchestrator, with review between each.

## 4. Orchestrator owns the board — always

Sub-agents NEVER write the board and NEVER commit. Only the orchestrator:

1. Sets status to `In Progress` before dispatching a ticket, then calls
   `record_dispatch` (`worker: "sub-agent"`, `model`, `parallel`) right after
   handing it off, so `get_agent_monitor` and the board show who's running it.
2. Reviews the sub-agent's diff and runs the tests — call `record_dispatch`
   again with `worker: "orchestrator"` when taking the ticket back for this.
3. Sets status to `Done` with a one-line `completionSummary`.
4. Calls `log_work` with tokens/additions/deletions/model.
5. Calls `commit_feature` for that ticket before pulling the next one.
6. After `commit_feature`, background static checks (syntax, lint, any configured
   commands) start AUTOMATICALLY and DETACHED — pure CPU, zero tokens. Don't wait:
   pull the next ticket immediately. Between tickets, and before ending the session,
   call `get_check_results` for any uncollected runs (by ticket or the newest run).
   A failed run means fix it now or file a bug before closing out — a syntax error
   caught here is one that would otherwise have shipped.

## 5. Live visibility

Sub-agents never write the board mid-flight, so between "In Progress" and "Done" the
filesystem is the only truth. When dispatching a ticket, tell the sub-agent in its
brief to append one-line timestamped notes to `.fb-progress` in its worktree (or the
repo root, if it's not on a worktree) at each major step — e.g. `12:03 created parser`,
`12:11 tests written`, `12:19 suite green`. `.fb-progress` is gitignored by convention;
it's a scratch channel, not project history. `get_live_activity` (and Mission Control)
read it, along with dirty files, recent commits, and other git worktrees, to answer
"is anything actually moving?" for a stalled-looking ticket — per project or across
every project at once.

## 6. Close-out

When the queue is empty, run `scan_board_cleanup` and offer the user next steps
(new work to plan, stale tickets to prune, etc.). Occasionally also offer to run
`check_updates` (explicit call only, never automatic) so the user hears about a
new FeatureBoard release when one exists.

Mention trial/licensing surfaces only if a write is actually blocked by them — don't
bring up licensing unprompted.

## Site pages — never hand-roll page chrome (FBMCPF-310)

Any page you create for the shipped featureboard.ai site MUST start from the
canonical shell — copy `cloudflare/PAGE-TEMPLATE.html` in the website repo.
Header comes from `/nav.js`, footer from `/footer.js`, design tokens (cyan
`#00d5ff` accent, dark `#1a1a1a`, DM Sans/Space Mono) stay exactly as-is, and
the shared `fb_vid` analytics block is copied byte-identical from buy.html.
Never write a `.header-bar`, `.site-footer`, or new color tokens by hand —
that is how pages drift off-brand.

For pad/project sites generated through the MCP site tools, apply the brand
template instead of inventing a look: `apply_site_template` with id
`featureboard` (or pass `colors: { accent: "#00d5ff" }` + dark theme to
`set_site`). Agent-generated pages must inherit the canonical look by default.
