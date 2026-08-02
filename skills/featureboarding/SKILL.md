---
name: featureboarding
description: Board substantive dev requests on FeatureBoard automatically and churn them with parallel sub-agents — with verified dispatch, heartbeat liveness, and per-completion merging. Use when the user asks to build, fix, ship, implement, refactor, "work on", or "swarm" anything non-trivial in a project — they should NOT have to say "put it on the board".
---

# Featureboarding

Run the FeatureBoard churn loop end to end: board the work, then work the board —
and PROVE the work is moving. Four failure modes this skill exists to prevent
(all observed in real runs): lanes narrated as dispatched but never spawned;
finished work sitting uncommitted in worktrees; sub-agents ending early to "ask
for guidance" nobody can hear; and a blind agent monitor because nobody heartbeats.

## 0. Pre-flight sweep — before dispatching anything

- `get_agent_monitor` (stallMinutes: 15). Any ticket already In Progress and
  stalled with no live agent from THIS session behind it is a zombie from a dead
  run: reset it to Todo (`set_status`, note why via `log_work`) so `next_wave`
  can re-serve it. Zombie In Progress tickets silently shrink every wave.
- `list_worktrees`. A worktree branch with commits (or dirty files) not on the
  main branch is orphaned finished work: review, `commit_feature`, then
  `cleanup_worktree` before starting new lanes.
- Check the work packet's `gitTargets` — code commits and projectpad commits can
  target DIFFERENT repos. Never assume.

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
with title `research/<ticket>` BEFORE dispatching implementation, and reports it in one
line rather than reprinting it. From then on, the
implementing agent's `get_work_packet` auto-attaches that brief as `researchBrief`,
alongside relevant local `ragChunks` (BM25 over KB/docs/ticket-history — zero tokens,
zero network) — so the expensive model starts with context, not a cold read.

## 3. Churn the queue — keep every lane full

> **Invariant: no lane sits idle while a dispatchable ticket exists.**
> **Invariant: no ticket is In Progress unless a verified-live agent (or the orchestrator) is working it.**

- Call `next_wave` — not `next_task` in a loop. It returns the WHOLE dispatchable set
  in one call, already partitioned into lanes that are mutually file-disjoint.
- **Start every lane it returns, at once.** `lanes[]` are safe to run as concurrent
  sub-agents; tickets *within* a lane share files and run serially in the order given.
  A lane flagged `isolate` has unknown file scope — give it its own `create_worktree`.
- Each ticket carries its own `dispatch` block (`{subAgent, model, cap, parallelizable,
  instruction}`) — obey it. Spawn the sub-agent at `dispatch.model`. Never upgrade a
  haiku ticket "to be safe" or downgrade an opus one to save tokens; the board already
  made that call at intake.
- **Dispatch by ticket ID, never by pasting the packet (FBMCPB-83).** The Agent prompt
  is rendered in the user's chat. Tell the sub-agent to call `get_work_packet` as its
  first action instead of inlining scope, definition of done, `researchBrief` or
  `ragChunks` — same context for the agent, a readable transcript for the user.
- **Build every sub-agent prompt from `references/dispatch-prompt.md`.** Its three
  MANDATORY blocks (heartbeats, no-pausing, no-commits) are not optional garnish —
  omitting them recreates the failure modes above, and its quiet-chat rules are what
  keep a saturated wave from burying the user in JSON.
- `sequential[]` holds `fable` tickets — orchestrator-only, run inline, review between each.
- `maxLanes` exists if you need to throttle, but the default is saturation. Use it only
  when the user asks for it.

## 3a. Verify the dispatch — narrated ≠ spawned

Do this in the SAME turn as every wave dispatch:

1. Per ticket handed off: `set_status` "In Progress", then `record_dispatch`
   (`worker: "sub-agent"`, `model`, `parallel: true`, note: lane id). When a
   within-lane serial ticket starts later, `record_dispatch` it then too.
2. **Count Agent tool calls actually issued vs lanes returned.** If they differ,
   dispatch the missing lanes NOW. Never narrate six agents and launch three.
3. `get_agent_monitor`: every lane-lead ticket must show a `lastDispatch` younger
   than this wave. An In Progress ticket with `lastDispatch: null` that is not a
   within-lane successor was never spawned — spawn it.

## 3b. Refill and watchdog

- **Refill on every completion, in the same turn.** The moment a lane finishes:
  handle it per §4, then call `next_wave` with `occupied: [only tickets VERIFIED
  still running]` and start (and verify, §3a) what comes back. Do not batch
  completions. Do not pause mid-run to ask whether to keep going.
- **`occupied` hygiene:** a ticket you merely believe is running does not belong in
  `occupied` — lanes come back under `busyLanes` and are never re-served, so hiding
  a dead lane as "busy" is exactly how lanes vanish from a run.
- While long lanes run, poll `get_agent_monitor` (stallMinutes: 15) every ~10-15 min:

| Signal | Meaning | Action |
|---|---|---|
| In Progress, `lastDispatch: null`, not a lane successor | never spawned | dispatch it |
| stalled, no heartbeat, its Agent call still running | quiet but alive | wait one cycle |
| stalled, no heartbeat, no corresponding running agent | dead lane | reset to Todo, re-dispatch |
| stalled mid-heartbeat-trail | agent stuck | collect result if returned; else re-dispatch |

- A sub-agent whose final report is a QUESTION instead of finished work is a failed
  dispatch, not a conversation: answer it yourself if within ticket scope and
  re-dispatch, or park the ticket (Todo + `log_work` note) and keep the lanes full.

## 3c. Stop condition — `stopCondition.met`, nothing else

An empty wave is **not** the end. `next_wave` returns a `stopCondition` block; the loop
continues while it is false, and its `reasons[]` tell you what to do next:

- open tickets remain → keep filling lanes
- tickets still running → wait and refill
- uncollected check runs → `get_check_results`
- unreviewed Done tickets, or steering not yet idle → `steer_project` (see §7)

Only when `stopCondition.met` is true do you stop and report. A failed acceptance check
is a new ticket, not a stopping point — file it and keep the lanes full.
Before declaring done: one final `list_worktrees` (no orphaned branches) and
`get_agent_monitor` (nothing In Progress). Then ONE consolidated report — not one per ticket.

## 4. Orchestrator owns the board — always

Sub-agents may READ the board through `get_work_packet` (that is how they get their
brief), but they NEVER write it except `log_heartbeat`, and they NEVER commit. Only the
orchestrator:

1. Sets status to `In Progress` before dispatching a ticket, then calls
   `record_dispatch` (`worker: "sub-agent"`, `model`, `parallel`) right after
   handing it off, so `get_agent_monitor` and the board show who's running it.
2. Reviews the sub-agent's diff and runs the tests — call `record_dispatch`
   again with `worker: "orchestrator"` when taking the ticket back for this.
3. Sets status to `Done` with a one-line `completionSummary`.
4. Calls `log_work` with tokens/additions/deletions/model.
5. Calls `commit_feature` for that ticket **the moment its lane returns and review
   passes — never batched to the end of the wave**. Finished work waiting
   uncommitted in a worktree is invisible work; merge it, `cleanup_worktree`,
   THEN refill the lane.
6. After `commit_feature`, background static checks (syntax, lint, any configured
   commands) start AUTOMATICALLY and DETACHED — pure CPU, zero tokens. Don't wait:
   pull the next ticket immediately. Between tickets, and before ending the session,
   call `get_check_results` for any uncollected runs (by ticket or the newest run).
   A failed run means fix it now or file a bug before closing out — a syntax error
   caught here is one that would otherwise have shipped.

## 5. Live visibility

Two channels, both mandatory in every sub-agent brief (see `references/dispatch-prompt.md`):

- **`log_heartbeat`** at a few natural milestones (oriented / fix written / tests
  green) with the ticket and elapsed minutes. This is the only board tool a
  sub-agent may WRITE through; it feeds `get_agent_monitor`'s liveness and stall
  banners — without it every healthy long-running lane looks identical to a dead one.
- **`.fb-progress`** one-line timestamped notes in the worktree (or repo root) at
  each major step — e.g. `12:03 created parser`, `12:19 suite green`. Gitignored
  by convention; `get_live_activity` and Mission Control read it, along with dirty
  files, recent commits, and other git worktrees, to answer "is anything actually
  moving?" for a stalled-looking ticket.

## 6. Close-out

When `stopCondition.met` is true, run `scan_board_cleanup` and offer the user next steps
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
