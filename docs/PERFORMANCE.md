# Test suite performance (FBMCPF-161)

## Summary

The 486-test suite (52 files, `test/*.test.js`) ran serially — `node --test`'s
default `--test-concurrency` is `os.availableParallelism() - 1`, which on a
2-core box evaluates to `1`. In practice that meant one core doing all the
work while the other sat idle, ~14.8s wall time.

`npm test` now runs through `scripts/run-tests.mjs`, a thin wrapper that picks
an explicit `--test-concurrency` based on the detected core count and hands
off to `node --test`. On the 2-core sandbox this measured suite dropped to
~7.9-8.0s, about a **1.85x** speedup, with all 486 tests passing across
multiple repeated runs (see Verification below).

## Why concurrency > core count

This suite is I/O-bound, not CPU-bound: each test does `fs.mkdtemp` plus a
handful of small file reads/writes (board markdown, `ticket_events.jsonl`,
heartbeats), and a few files (`git.test.js`, `graduate.test.js`,
`worktrees.test.js`) shell out to real `git` via `spawnSync`. While one test
process is blocked waiting on a filesystem or child-process syscall, the CPU
is free for another process to make progress. That means throughput keeps
improving past the physical core count, up to the point where process-spawn
overhead (each test *file* is its own child process under `node --test`'s
process-isolation model) starts to dominate.

Measured on this repo's 2-core sandbox (486 tests / 52 files, `time npm
test`, best of repeated runs):

| `--test-concurrency` | wall time |
|---|---|
| 1 (old effective default on 2 cores) | ~14.7-14.8s |
| 2 (== core count) | ~10.8s |
| 4 | ~9.5-10.0s |
| **6 (3x core count) — chosen default** | **~7.9-8.3s** |
| 8 | ~10.3s (regresses — spawn overhead outweighs I/O overlap) |

`scripts/run-tests.mjs` computes `concurrency = min(32, max(4, cores * 3))`,
so it scales with the machine rather than hard-coding "6". `TEST_CONCURRENCY`
env var overrides the computed value for local tuning. The upper cap of 32
just avoids spawning more child processes than are useful once you're well
past the ~52 test files in this repo.

## Before / after (this sandbox, 2 cores)

- **Before** (`node --test`, default concurrency): best-of-2 real time
  **14.822s** (486 tests, 52 files).
- **After** (`npm test` → `scripts/run-tests.mjs`, `--test-concurrency=6`):
  best-of-3 real time **7.848-8.043s** (same 486 tests).
- **Speedup**: ~1.85-1.9x on 2 cores.

Machines with more cores should see a larger absolute concurrency value
(`cores * 3`) and correspondingly larger speedups, since more of the
suite's I/O-wait time gets overlapped.

## Verification

The parallel suite was run 3 times back-to-back (scoped to the 52 baseline
test files) to shake out order-dependence and fixture-collision flakes:
all 3 runs reported `486/486 pass, 0 fail`. No flakes were found — every
test file that touches the filesystem already isolates itself with
`fs.mkdtempSync(path.join(os.tmpdir(), "<prefix>-"))`, so parallel
processes never share a board directory. The handful of files with no
`mkdtemp` call (`agent_monitor.test.js`, `multimodel.test.js`,
`nightly.test.js`, `predictive.test.js`, `privacy_docs.test.js`,
`testcleanup.test.js`, `testing.test.js`) are pure in-memory unit tests (or,
for `privacy_docs.test.js`, read-only file reads) with no shared mutable
state, so they were already safe under process-per-file parallelism. The
one `process.env.*` mutation (`test/graduate.test.js`, setting
`GIT_AUTHOR_NAME`/`GIT_COMMITTER_*` for `git commit` invocations) is scoped
to that test file's own process under `node --test`'s process-isolation
model and never leaks across files. A prior `NODE_TEST_CONTEXT` leak (a
child `node:test` process inheriting that env var from the parent test
run) was already fixed in `server/modeleval.js`, which strips it before
spawning.

## Fallback for debugging

`npm run test:serial` still runs the suite with `--test-concurrency=1` for
cases where interleaved output or a suspected isolation bug needs to be
debugged one file at a time. `npm run test:parallel` is an explicit alias
for the new default (`npm test`).

## GPU acceleration: not applicable

This ticket asked for an honest assessment of GPU acceleration for the test
suite. The suite is overwhelmingly I/O and string-parsing work: markdown
board files, JSON/JSONL event logs, regex-based parsing (e.g.
`privacy_docs.test.js` scanning `server/index.js` for tool registrations),
and small in-memory data transforms (scheduling math, diffing, dedup). None
of it involves the kind of large, uniform, parallel numeric workload (matrix
math, batched tensor ops, image/audio processing) that would benefit from a
GPU — there's no batch of independent floating-point operations big enough
to amortize the cost of a host-to-device data transfer, and Node's test
runner doesn't have a code path to dispatch work to a GPU regardless. Adding
a GPU dependency here would add build complexity (native bindings, CUDA/ROCm
runtime requirements) for zero measurable benefit. The right lever for this
suite is process-level parallelism across CPU cores (done above), not
hardware acceleration. No GPU packages were added.
