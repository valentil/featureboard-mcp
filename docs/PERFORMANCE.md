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


---

# Tuning pass (FBMCPF-162)

FBMCPF-161 parallelized the test *runner*; this ticket asked whether the
tests and the server *itself* had real perf problems worth fixing, measured
first rather than guessed at. Two things turned out to matter: one
badly-behaved test file, and three server-side hot paths that re-read and
re-parsed board files on every call inside a single process.

## 1. Server hot paths — measured on a synthetic board

A throwaway synthetic board was built (not committed) to get realistic
numbers instead of guessing: 1,500 features + 500 bugs in
featurelist.md/buglist.md, 5,000-line ticket_events.jsonl, 5,000-line
heartbeats.jsonl, 3,000-line agent_work_log.md. `process.hrtime.bigint()`
wrapped repeated calls (n=20-50) to the storage/metadata/events entry
points against that board, in the same Node process (mirroring the real MCP
server, which is long-running and single-process).

| Operation | Before | After | Speedup |
|---|---:|---:|---:|
| `Board.listTasks` (all) | 13.47ms/call | 1.82ms/call | 7.4x |
| `Board.getTask` | 13.46ms/call | 1.10ms/call | 12.3x |
| `readEvents` | 5.44ms/call | 0.14ms/call | 39x |
| `readHeartbeats` | 4.82ms/call | 0.14ms/call | 34x |
| `readWorkLog` | 4.01ms/call | 0.19ms/call | 21x |
| `getWorkPacket` (get_work_packet) | 28.62ms/call | 2.52ms/call | 11.4x |
| `computeHealth` | 16.90ms/call | 1.67ms/call | 10.1x |
| `agentMonitorV2` | 181.06ms/call | 6.05ms/call | 30x |
| `getTimelineData` | 31.69ms/call | 11.10ms/call | 2.9x |

Where the time actually went:

- **`Board.listTasks`/`getTask`** re-read and regex-parsed the *entire*
  featurelist.md + buglist.md on every call, with no memory of the previous
  parse. `getWorkPacket` alone calls `board.getTask()` twice per invocation
  (once for the ticket, once for its linked issue) — each a full 4-file-read
  round trip (2 files x 2 getTask calls).
- **`readEvents`/`readHeartbeats`** (events.js) re-read and re-`JSON.parse`'d
  every line of `ticket_events.jsonl`/`heartbeats.jsonl` on every call, even
  though these are append-only logs that only grow.
- **`readWorkLog`** (metadata.js) did the same for `agent_work_log.md`.
- **`agentMonitorV2`** was the standout: for every In Progress ticket it
  called six helper functions that each did `events.filter(e => e.ticket ===
  ticket)` / `.filter(w => w.ticket === ticket)` over the *entire*
  events/work/heartbeats arrays — O(tickets x logSize) instead of
  O(logSize). `getTimelineData` next door already grouped events/work by
  ticket into a `Map` once up front (its own earlier design); `agentMonitorV2`
  never got the same treatment. On the synthetic board (375 In Progress
  tickets x ~13,000 combined log lines) that inline filtering, not file I/O,
  was the dominant cost.

### Changes kept

- **`server/storage.js`**: a per-process, mtime+size-keyed cache
  (`taskParseCache`) of parsed featurelist.md/buglist.md content, checked in
  `_readTasks()`. `atomicWrite()` — the sole writer of these files — deletes
  the cache entry for its path the instant it renames the new content into
  place (write-through, airtight for same-process writes regardless of
  filesystem mtime resolution). The mtime+size check is defense-in-depth for
  a file touched by something other than this process. `_readTasks()`
  already `.map()`s every returned task into a fresh object (to attach
  `type`), so callers never hold a reference into the cached array — mutating
  a task returned from `listTasks()`/`getTask()` can't corrupt the cache.
- **`server/events.js`**: the same pattern (`jsonlCache`) for
  `ticket_events.jsonl`/`heartbeats.jsonl`, with `appendEvent()`/
  `appendHeartbeat()` deleting the relevant cache entry right after their
  `fs.appendFileSync()`. Also: `agentMonitorV2` now groups events/work/
  heartbeats by ticket ONCE (`groupByTicket()`, mirroring `getTimelineData`'s
  existing approach) and the six per-ticket helper functions
  (`spendForTicket`, `costForTicket`, `inferModelForTicket`,
  `resolveStartedInProgress`, `resolveLastEvent`, `resolveLastHeartbeat`)
  now take an already-filtered slice instead of re-filtering the full array
  — none of these are exported, so this was a safe internal refactor with
  zero change to `agentMonitorV2`'s output shape.
- **`server/metadata.js`**: the same mtime+size cache pattern
  (`workLogCache`) for `agent_work_log.md`'s `readWorkLog()`, invalidated by
  the local `atomicWrite()` (shared by `logWork`, `setProjectConfig`,
  `setScratchpad`, `appendScratchpad`, `logTestRun`).

All three caches are per-process `Map`s, which is safe because each of these
modules is the sole writer of its file, and the test suite spawns one
process per test file under `node --test`'s process-isolation model — no
cache is ever shared across a process boundary that could observe a stale
write from another process.

### Correctness: `test/perf_cache.test.js` (new, 14 tests)

Covers, for every mutating path through the three cached readers:
read-after-write freshness (`addTask`/`updateTask`/`setStatus`/`deleteTask`/
`linkTasks`/`repairDuplicateTickets` for storage.js;
`appendEvent`/`appendHeartbeat` for events.js; `logWork` for metadata.js —
each asserted immediately visible on the very next read, including
interleaved writes between reads) and the mtime/size defense layer
specifically: a file rewritten *outside* the cached module's own write path
(direct `fs.writeFileSync`/`fs.appendFileSync`, bypassing `Board`/
`appendEvent`/`logWork` entirely) plus an explicit `fs.utimesSync()` push
into the future must never be served from the stale cache — and, separately,
a same-instant external append that changes file *size* but might not tick
the mtime is still caught by the size half of the cache key.

### Considered, not done

- **Precompiling `parseMarkdown`'s inline per-field regexes** (`[Product:
  ...]`, `[Labels: ...]`, etc. — currently regex literals inside the parse
  loop). With the parse-result cache in place, `parseMarkdown()` itself now
  runs at most once per unique file *content* (not once per call), so the
  per-line regex-literal cost — never large to begin with, and something
  V8 already optimizes for non-mutated literals — is amortized away by the
  cache. Hoisting them to module scope would save a sub-millisecond amount
  on the (now rare) actual parse and wasn't worth the code churn.
- **Cloning cached task objects defensively before returning them**: not
  needed — `_readTasks()`'s existing `.map(t => ({ ...t, type }))` already
  allocates a fresh object per call, so the cache's own array/objects are
  never exposed to a caller that could mutate them in place.
- **A size cap / LRU eviction for the caches**: boards in practice are
  single-digit-MB markdown/jsonl files per project; a per-process `Map`
  keyed by absolute path never grows unbounded within the lifetime of one
  MCP server process, so eviction wasn't worth the complexity.

Nothing tried here failed to pay off — each cache/refactor was validated
against the synthetic-board benchmark above before being kept, so there was
nothing to revert.

## 2. Slowest test: `test/modeleval.test.js` (6.76s -> 2.15-2.30s)

Per-file timing (`node --test <file>` individually) identified one file an
order of magnitude slower than everything else:

| File | Before | After |
|---|---:|---:|
| `test/modeleval.test.js` | **6.76s** | **~2.15-2.30s** |
| `test/worktrees.test.js` (2nd slowest) | 0.50s | 0.48s (unchanged) |

`runVariantMatrix()` (server/modeleval.js) spawns a fresh `node --test
--test-reporter=tap <file>` child process per variant test file, once for
the unmutated baseline AND once per applied seeded mutation. For this test
file's fixture (3 model variants, 3-of-6 builtin mutations actually apply)
that's 12 real `node` process spawns per `runVariantMatrix()` call — genuine
work the production code does (spawning `node --test` to score model
variants), not something to fake out. But **four separate tests in the file
called `runVariantMatrix()` with the exact same `(dir, ticket, opts)`**
(fixture sanity / seeded-mutations-and-overlap / never-mutates-target-file /
formatEvidenceSection, plus a near-identical cost-per-defect call that only
adds `tokensByModel`, which doesn't change which mutations get caught) — 48
of the file's ~60 total spawns were exact repeats of the same deterministic
computation, at ~100-150ms of pure Node-startup overhead each.

**Change**: those five tests now share one memoized `runVariantMatrix()`
call (`computeSharedMutationRun()`, computed once, an `after()` hook cleans
up its temp dir), each still asserting exactly what it asserted before —
no coverage was dropped, only the redundant re-computation. Total spawns for
the file dropped from ~60 to ~21. The 12 spawns from that one shared call,
plus the 3-spawn baseline-only test and the 6-spawn custom-mutation test
(both genuinely need their own call — different `opts`), are irreducible:
they're the actual work `eval_model_matrix` does, not test overhead.

`test/worktrees.test.js`, the next-slowest file at ~0.5s, was left alone —
its cost is real `git` `spawnSync` calls building actual worktrees/branches
for FBMCPF-136 coverage, and every remaining file after that sits in the
150-500ms band dominated by per-process Node startup (~100-150ms is simply
the floor for `node --test <file>` under process-per-file isolation), not
redundant setup worth trimming.

## 3. Before / after — full suite (parallel, `npm test`)

- **Before** (post-FBMCPF-161, 540 tests, 53 files): best-of-2 real time
  **8.49s** (11.53s / 8.49s across 2 runs).
- **After** (554 tests — +14 new `test/perf_cache.test.js` — 54 files):
  best-of-3 real time **4.97s** (5.05s / 4.97s / 5.19s across 3 runs, all
  554/554 green every run).
- **Speedup this pass**: ~1.7x, on top of FBMCPF-161's earlier ~1.85-1.9x —
  roughly **3x** off the original pre-FBMCPF-161 serial baseline (~14.8s).
- Serial fallback (`npm run test:serial`) also re-verified green: 554/554,
  ~9.6s.

`npm run check` (all 38 `node --check` targets, including the three touched
server files) passed clean.
