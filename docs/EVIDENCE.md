# Eval readout: board+packets vs plain chat (FBMCPF-129)

Status: **board-arm data collected and run through the harness; chat-arm pending human-in-the-loop.**

This is the first run of the eval harness built in FBMCPF-128 (`server/eval.js`,
`evalReport()`), driven off the label conventions it defines:

- `experiment:board` / `experiment:chat` — which arm a ticket was worked in
- `pair:<id>` — ties a board trial and a chat trial to the same underlying task so they
  can be compared head-to-head
- Metrics come from `readWorkLog` (tokens/additions/deletions) and task
  `createdDate`/`completionDate`/linked bugs (wall time, rework), exactly as
  `evalReport` computes them — no numbers below were hand-typed into a summary; they are
  the harness's own output.

## What was actually run

**Board+packets arm: run for real, against real historical data.** The 10 tickets below
are genuine, already-completed `FeatureBoardMCP` tickets, all built through the
FeatureBoard board+packets workflow (get_work_packet → implement → log_work → set_status
Done — the only workflow this project has ever used). Their real `get_task` /
`get_work_log` records were reconstructed into a disposable temp board (not the live
FeatureBoardMCP board — no `set_status`/`log_work`/`update_task` calls were made against
it) and passed through the actual `evalReport()` function to produce the numbers in this
report. The script used is reproducible: build a `Board` from `server/storage.js` over a
temp dir, `logWork()` the same tokens/additions/deletions each ticket's real work log
already carries, then call `evalReport()`.

**Chat arm: not run.** This project has no history of the same tickets being reworked
from a plain, board-free chat, and the ticket calls for **human-in-the-loop** on that
arm — a person needs to actually redo each of the 10 tasks below in an unstructured chat
session (no board tools, no work packet) and report back real tokens spent, wall time,
and any regressions, before that data can be labeled and paired. Nothing on the chat
side below is invented; `evalReport` correctly reports 0 chat trials and 0 pairs from
real input.

## The 10 trial tickets (board arm)

Picked for comparability: all are small, single-scope bug fixes or features from the
FeatureBoardMCP board itself, each closed same-day (or next-day), each with its own
work-log entries (not shared across a bulk batch).

| Pair | Ticket | Type | Title | Tokens | Additions | Deletions | Wall days | Rework (7d) |
|---|---|---|---|---:|---:|---:|---:|---:|
| p1 | FBMCPB-9 | bug | "Open/show the board" doesn't reliably surface board.html | 0 | 168 | 8 | 0 | 0 |
| p2 | FBMCPB-10 | bug | Validation: non-date dueDate accepted | 0 | 75 | 8 | 0 | 0 |
| p3 | FBMCPB-6 | bug | update_task rejects numeric priority | 24,000 | 8 | 8 | n/a | 0 |
| p4 | FBMCPB-11 | bug | Duplicate ticket IDs not prevented | 0 | 135 | 2 | 0 | 0 |
| p5 | FBMCPB-12 | bug | Process: close-out doesn't enforce a git check-in per task | 0 | 12 | 4 | 0 | 0 |
| p6 | FBMCPB-13 | bug | daily_plan heuristics: budget unit + effort keyword misfires | 43,328 | 45 | 15 | 0 | 0 |
| p7 | FBMCPF-125 | feature | Model tiering: model:\<name\> labels + suggested model | 0 | 30 | 3 | 0 | 0 |
| p8 | FBMCPF-105 | feature | Auto-surface the board on NL "show the board" | 0 | 6 | 0 | 0 | 0 |
| p9 | FBMCPF-106 | feature | Sync Analytics dashboard styling + light/dark with the board | 0 | 70 | 6 | 0 | 0 |
| p10 | FBMCPF-67 | feature | Analytics nav link from the board | 0 | 78 | 0 | -1 | 0 |

Notes on the raw data (reported as found, not smoothed over):

- **Token telemetry is mostly missing.** Only 2 of 10 real work-log entries carry a
  numeric `tokens` value (FBMCPB-6: 24,000; FBMCPB-13: 43,328); the rest log `tokens:
  null` in the underlying work log, which `evalReport` treats as 0. That is a real gap in
  this project's `log_work` discipline for older tickets, not a harness bug — it means
  `medianTokens: 0` for the board arm below understates actual token spend and should
  not be read as "these tickets cost nothing."
- **FBMCPB-6 has no `completionDate`** despite being Done (a pre-FBMCPB-5-fix legacy
  record), so its wall-days is `null`/n/a.
- **FBMCPF-67's `completionDate` (2026-07-13) predates its `createdDate` (2026-07-14)**
  in the live board, giving a wall-days of -1. Left as-is rather than corrected, since
  the point of this report is to run the harness against real data, warts included.
- **Rework is genuinely 0 across all 10** — none of the project's 13 bug tickets carry a
  `linkedIssue` back to any of these 10, in or out of the 7-day window.

## Harness output (`evalReport`, board arm only)

```json
{
  "byArm": {
    "board": {
      "trials": 10,
      "done": 10,
      "medianTokens": 0,
      "medianWallDays": 0,
      "totalAdditions": 627,
      "totalDeletions": 54,
      "reworkTotal": 0
    },
    "chat": {
      "trials": 0,
      "done": 0,
      "medianTokens": null,
      "medianWallDays": null,
      "totalAdditions": 0,
      "totalDeletions": 0,
      "reworkTotal": 0
    }
  },
  "pairs": [],
  "summary": "10 trials recorded (board 10, chat 0) — no paired trials yet (add pair:<id> labels to compare head-to-head)."
}
```

Produced by building a temp `Board` (`server/storage.js`) over the 10 real ticket
records above, `logWork()`-ing each ticket's real summed tokens/additions/deletions, and
calling `evalReport(board, "Proj")` from `server/eval.js` directly — the same function
the `eval_report` MCP tool calls. `node --test test/eval.test.js` — 10/10 passing —
confirms the harness itself is correct independent of this run's input data.

## Chat-arm protocol (pending human-in-the-loop)

To complete the paired comparison, a human should, for each of the 10 tickets above:

1. Start a **fresh chat with no FeatureBoard board/work-packet context** — description
   of the task only (use the `description`/`completionSummary` text as the brief, since
   that's what a plain-chat requester would hand over).
2. Implement the same change from scratch (or as close as practical) without
   `get_work_packet`, `next_task`, or any board tool.
3. Record: total tokens spent, wall-clock time to completion, lines added/deleted, and
   whether any regression/rework was needed in the following days.
4. On the **live** FeatureBoardMCP board, log the result as a new ticket (or amend
   process) labeled `experiment:chat, pair:p<N>` matching the table above, with the
   measured tokens/additions/deletions via `log_work`.
5. Re-run `evalReport` (via the `eval_report` MCP tool) — once both sides of a `pair:`
   exist, `pairs[]` will populate automatically with the token ratio, wall-day
   comparison, and rework comparison this ticket originally asked for.

No chat-arm numbers are fabricated here; `byArm.chat` and `pairs` above are the
harness's honest empty-state output given zero chat trials logged so far.

## Bottom line

- The harness (FBMCPF-128) works correctly against real data: verified by 10/10 unit
  tests plus this live run producing a sane, honest report (including correctly
  reporting "no paired trials yet" rather than erroring).
- Board-arm baseline is now on record for 10 comparable small tickets, sourced from real
  `get_task`/`get_work_log` data, with the token-telemetry gap flagged as a
  process/data-quality issue worth fixing going forward (log tokens on every `log_work`
  call).
- The chat arm requires a human to actually do the 10 tasks over again outside the
  board, by design (this ticket specifies human-in-the-loop) — that work has not been
  run and is not simulated here. Once logged, re-running `evalReport` produces the
  head-to-head comparison this ticket was opened to answer.

## Model eval matrix: DEMO-1 (harness validation — no real defect data)

Generated 2026-07-16T23:36:04.705Z by `eval_model_matrix` (FBMCPF-148, `server/modeleval.js` `runVariantMatrix`), against variant test files `DEMO-1.fable.test.js`, `DEMO-1.opus.test.js`, `DEMO-1.sonnet.test.js` — seeded mutations applied to a temp COPY of `server/discount.js` (repo untouched).

**Harness-validation run — not real defect data.** This proves the matrix runner, seeded-mutation harness, unique-catch/overlap math, and cost-per-caught-defect calculation work end-to-end on a small fixture. No production bug-catch numbers are represented here; nothing below should be read as evidence about real model tiers on real code.

Baseline (unmutated): fable 6/6 passing, opus 4/4 passing, sonnet 1/1 passing.

| Model | Defects caught | Unique catches | Catch rate | Unique catch rate | Tokens | Cost | Cost / caught defect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fable | 4/5 | 0 | 0.8 | 0 | n/a | n/a | n/a |
| opus | 4/5 | 0 | 0.8 | 0 | n/a | n/a | n/a |
| sonnet | 2/5 | 0 | 0.4 | 0 | n/a | n/a | n/a |

Overlap matrix (seeded mutations caught by both row and column model; diagonal = that model's total catches):

| | fable | opus | sonnet |
| --- | ---: | ---: | ---: |
| fable | 4 | 4 | 2 |
| opus | 4 | 4 | 2 |
| sonnet | 2 | 2 | 2 |

Summary: 5/6 seeded mutations applied (1 skipped, pattern not found); fable caught the most (4/5).

_Fixture note: DEMO-1 and `server/discount.js` are a synthetic demo module created only to exercise this harness end-to-end — no such ticket or file exists in FeatureBoardMCP itself. No real per-model test variants (test/<ticket>.<model>.test.js) exist in this repo yet as of this run (FBMCPF-147 shipped without any ticket having gone through generate_multi_model_tests + save_generated_test), so there is no real-defect data to report. Once a real ticket has variants, re-run `eval_model_matrix` with mode:"real" and writeEvidence:true to replace/extend this section with genuine numbers._
