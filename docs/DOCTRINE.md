# FeatureBoard doctrine

Short, load-bearing principles for how work on this project is done. These are not
style preferences — they're the rules that keep the board honest and the tooling
trustworthy.

## Recursive dogfooding (FBMCPF-323)

**When you change a process or a tool, exercise the change in situ — on this board,
in the same session, while you make it. The edit must run through the thing it
edits before you call it done.**

FeatureBoard is the tool an agent uses to plan, work, verify, and ship. So a change
to *how that work happens* — a new tool, a steering pass, a work-packet field, a
cleanup heuristic — has a second, sharper test beyond its unit tests: **does it
behave correctly when the very work of shipping it flows through it?**

Concretely, when you touch FeatureBoard's own workflow:

- **File it on the board and work it through the board.** Put the change on the
  featurelist/buglist, pull it with `next_task`, assemble its `get_work_packet`,
  and close it with `set_status` + `log_work` + `commit_feature` — don't hand-wave
  the process you're editing.
- **Run the changed surface against real board state.** Changed `steer_project`?
  Run a real steering pass on this board and read the passes. Changed
  `churn_reconcile`? Call it on this 350-ticket board and confirm it fits inline.
  Changed a work-packet field? Pull a packet and look at the field. Changed the
  cleanup dup heuristic? Scan this board and confirm the false positives are gone.
- **Prefer the finding you hit yourself.** A bug you reproduced by using the tool
  during its own development (e.g. `churn_reconcile` blowing the token budget mid
  review pass) is worth more than one imagined in the abstract — it comes with a
  real repro and a real fix target.

Why: unit tests prove the code does what you told it to; dogfooding proves you told
it the right thing. The loop that reviews, tightens, researches, and ships is the
product, so running the change through that loop is both the highest-fidelity test
and a live demo of the value the product claims.

### Anti-patterns

- Shipping a steering/tooling change and *describing* how it would behave instead
  of running it once on this board.
- Marking a workflow change Done with green unit tests but never having invoked the
  changed tool against real board data.
- Editing the process guidance without following it in the same session.
