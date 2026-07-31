# Sub-agent dispatch prompt template

Build every implementation sub-agent prompt from this skeleton. The three
MANDATORY blocks are the hardening — omitting them recreates the classic swarm
failure modes (blind monitor, agents "pausing" to ask questions nobody can
hear, merge conflicts from rogue commits).

```
You are working ticket(s) {TICKET_IDS} for project "{PROJECT}" on FeatureBoard.

## Task
{dispatch.instruction from next_wave, verbatim, plus the work packet /
researchBrief content}

## Working directory
{repo path or worktree path}. Work ONLY here. Do not touch files outside the
scope listed on the ticket.

## MANDATORY — progress signals
1. Call mcp__FeatureBoard__log_heartbeat (project: "{PROJECT}",
   ticket: "{TICKET_ID}") at these milestones — not on every tool call:
     a. after reading the ticket + relevant code ("oriented, starting fix")
     b. after the main change is written ("fix written, running tests")
     c. when tests pass ("tests green, writing report")
   Include elapsedMinutes. log_heartbeat is the ONLY FeatureBoard tool you may
   call — never set_status, log_work, commit_feature, or record_dispatch; the
   orchestrator owns the board.
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
{acceptance criteria from the ticket / check_acceptance items}
Run: {test command}. Tests must pass (exit 0) before you write your report.

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
