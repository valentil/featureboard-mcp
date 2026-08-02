# Sub-agent dispatch prompt template

Build every implementation sub-agent prompt from this skeleton. The three
MANDATORY blocks are the hardening — omitting them recreates the classic swarm
failure modes (blind monitor, agents "pausing" to ask questions nobody can
hear, merge conflicts from rogue commits).

**Dispatch by REFERENCE, never by value (FBMCPB-83).** The prompt you pass to
the Agent tool is rendered verbatim in the user's chat transcript. A work packet
inlined into it — scope, definition of done, up to 6KB of `researchBrief`, ~4KB
of `ragChunks` — becomes several hundred lines of JSON dumped into the main
conversation, once per lane, on every wave. Users hate this and it tells them
nothing. Hand the sub-agent the ticket ID and let it fetch its own packet: same
context inside the sub-agent, near-zero noise outside it. Keep the whole prompt
under ~40 lines.

```
You are working ticket(s) {TICKET_IDS} for project "{PROJECT}" on FeatureBoard.

## Task
FIRST ACTION: call mcp__FeatureBoard__get_work_packet (project: "{PROJECT}",
ticket: "{TICKET_ID}") for each ticket above and work from what it returns —
scope, code location, gitTargets, definition of done, researchBrief, ragChunks,
handoffs and review comments are all in there. Do NOT ask the orchestrator to
re-send any of it.

One line of orchestrator context, only if it is NOT already on the ticket:
{e.g. "this lane owns server/wave.js; FBMCPF-370 lands after FBMCPF-369"}

## Working directory
{repo path or worktree path}. Work ONLY here. Do not touch files outside the
scope listed on the ticket.

## MANDATORY — progress signals
1. Call mcp__FeatureBoard__log_heartbeat (project: "{PROJECT}",
   ticket: "{TICKET_ID}") at these milestones — not on every tool call:
     a. after reading the ticket + relevant code ("oriented, starting fix")
     b. after the main change is written ("fix written, running tests")
     c. when tests pass ("tests green, writing report")
   Include elapsedMinutes. get_work_packet (read) and log_heartbeat (write) are
   the ONLY FeatureBoard tools you may call — never set_status, log_work,
   commit_feature, or record_dispatch; the orchestrator owns the board.
2. Append a one-line timestamped note to .fb-progress in your working
   directory at each major step (e.g. "12:03 created parser"). It is
   gitignored scratch, not project history.

## MANDATORY — no pausing, no questions
You cannot reach the user, and a run that ends in a question is a failed run.
Never stop to ask for guidance. If something is ambiguous, make the most
reasonable choice consistent with the ticket, note the decision and the
alternative in your report, and keep going. If truly blocked (missing
credential, broken build unrelated to your ticket), stop work and REPORT the
blocker precisely — do not ask, report.

## MANDATORY — do not commit
Leave all changes uncommitted in the working directory. The orchestrator
reviews and commits per ticket. Never run git commit / push / merge / rebase.

## Definition of done
As stated in the work packet's definitionOfDone. Run the packet's test command
(or {test command} if the packet names none). Tests must pass (exit 0) before
you write your report.

## Return report (your final message — the only thing the orchestrator sees)
- Ticket(s) and outcome: done / blocked / partial
- Files changed (paths)
- Test command run and result
- Decisions made under ambiguity (choice + alternative)
- Anything discovered that should become a new ticket
```

## Orchestrator-side notes

- One prompt per lane. List within-lane tickets in serial order and tell the
  agent to finish + heartbeat each before starting the next; fill {TICKET_ID}
  per-milestone accordingly.
- Immediately after issuing the Agent call: `record_dispatch` for the ticket(s).
  §3a's spawn verification (`get_agent_monitor` lastDispatch check) depends on it.
- Research sub-agents (§2) get a reduced version: same no-pausing block, same
  report discipline, heartbeats optional for runs expected under ~5 minutes.

### Quiet-chat rules (FBMCPB-83)

Everything the orchestrator emits between waves is visible to the user, so keep
the transcript readable:

- **Never paste a work packet, `researchBrief`, `ragChunks`, `next_wave` JSON or
  a returned research brief into an Agent prompt or into your own reply.** Refer
  to it by ticket id; the sub-agent fetches it, and `add_kb_doc` stores it.
- The orchestrator's own `get_work_packet` call is for deciding *routing* — read
  `dispatch`, `gitTargets` and `worktree`, and don't echo the rest.
- One line per dispatch is the budget: `FBMCPF-370 → opus sub-agent (lane 2)`.
  Not the instruction, not the acceptance criteria, not the file list.
- When a research sub-agent returns a brief, save it with `add_kb_doc` and say
  so in one line — do not reprint the brief, and do not forward it into the
  implementation prompt (the packet auto-attaches it).
- Wave-level status is a single line: lanes started, tickets in flight, what
  finished. Save the detail for the ONE consolidated report at the end.
