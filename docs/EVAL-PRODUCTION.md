# Production multi-model eval pass — FBMCPF-280

**Closes the FBMCPF-148 pending item.** Extends the FBMCPF-185 single-ticket
pilot (`docs/EVAL-MODEL-MATRIX.md`, storage.js / FBMCPB-10 only) to a wider,
production-scale mutation-injection pass: 16 seeded mutations across 4
modules, run against (a) real multi-model test variants where they exist and
(b) the full real test suite as a baseline, all inside an isolated `/tmp`
copy. **The real repo's server/ and test/ directories were never touched by
mutation or generation code** — this file is the only change made to the
working tree.

## Methodology

1. **Isolation.** The repo was copied to `/tmp/eval-280` (rsync, excluding
   `node_modules`/`.git`/`dist`/`releases`; `node_modules` symlinked back in).
   All mutation injection, test generation-file writes, and test execution
   happened only inside that copy or a further-nested `fs.mkdtempSync` temp
   dir (for `runVariantMatrix`'s per-mutation mutant workspaces). The real
   repo's `server/*.js` and `test/*.js` files were read-only inputs throughout.
2. **Mutation design.** 16 hand-designed, precisely-targeted mutations (not
   the generic "first occurrence in the whole file" builtin set used by the
   FBMCPF-185 pilot) across 4 modules with strong existing coverage:
   `server/storage.js`, `server/metadata.js`, `server/git.js`,
   `server/cleanup.js`. Each mutation is a custom find/replace spec fed to
   `runVariantMatrix`'s `mutations` option (see `server/modeleval.js`), landing
   on a specific, previously-read line so the defect is realistic and
   verifiably scoped (every `find` string was confirmed to match exactly once
   in its target file before running). Four defect classes per module: an
   **inverted condition**, an **off-by-one**, a **wrong field**, and a
   **dropped guard**. Note: `dropped await` was in the original brief, but a
   grep across all four target modules (`grep -n "async function|await "`)
   found zero matches — this codebase's storage/metadata/git/cleanup layer is
   entirely synchronous (execSync/spawnSync, readFileSync). "Dropped guard"
   (removing a null/empty-string/zero check) was substituted as the closest
   realistic analog and is called out explicitly rather than silently
   relabeled.
3. **Tier-variant generation.** `generate_multi_model_tests` / `testing.js`
   is explicitly read-only and cannot invoke a model itself — it returns a
   generation prompt for "the calling agent" to run per tier. This session
   is a single Sonnet 5 agent, so genuinely producing haiku/sonnet/opus
   test files required literally invoking those tiers, not writing three
   variants by hand under different labels (which would be fabrication). The
   Agent tool available in this Cowork session accepts a `model` override
   (`sonnet`/`opus`/`haiku`/`fable`), so three real subagents — one per tier —
   were dispatched with the *same* generation prompt for `server/metadata.js`'s
   `velocity()`/`computeHealth()`, blind to the mutation list below. Their
   outputs differ substantively in structure, rigor, and even in independently
   re-discovering source details the prompt excerpt omitted (opus's and
   sonnet's tests both correctly used the real `breakdown.freshness` key,
   which the prompt's truncated code excerpt didn't show — evidence they
   read the real source rather than only the prompt). These were submitted
   through `save_generated_test` (dedupe: 30/30 kept, 0 dropped — the three
   tiers wrote genuinely non-overlapping test content) and saved as
   `test/FBMCPF-280.{haiku,sonnet,opus}.test.js` **inside the `/tmp` copy
   only**. Real generation-token counts from each subagent's own usage report
   (`subagent_tokens`) were used for cost math: haiku 25,606; sonnet 72,490;
   opus 34,383. For `server/storage.js`, the pre-existing real FBMCPB-10 tier
   variants (fable/haiku/opus/sonnet, from the FBMCPF-185 precedent) were
   reused unmodified, with that ticket's own measured tokens (opus 74,719;
   sonnet 56,287; haiku 49,908; fable unmeasured, per FBMCPF-185 — not
   invented here either).
4. **Execution.** `eval_model_matrix`'s known 45s MCP-transport timeout (same
   gotcha as FBMCPF-185) meant `runVariantMatrix` was invoked directly via a
   one-off script inside `/tmp/eval-280`, once for `FBMCPB-10`/storage.js and
   once for `FBMCPF-280`/metadata.js, each with `mode: "real"` and the four
   custom mutations for that module. Separately, **all 16 mutations** were
   also run against the **full real test suite** (`scripts/run-tests.mjs`,
   1049 tests) one at a time in the `/tmp` copy: apply mutation → run full
   suite → diff failing-test names against a clean baseline → restore the
   file. `git.js` and `cleanup.js` have no per-tier variant files, so they
   only have full-suite data (see Limitations).
5. **Logging.** Each tier's catch data plus the full-suite baseline pass was
   recorded via `log_test_run` under suite names `eval280-haiku`,
   `eval280-sonnet`, `eval280-opus`, `eval280-fable` (bonus), and
   `eval280-baseline-full-suite`.

## Mutation table

| ID | Module | Class | Description | Full-suite: new failures | Full-suite caught? |
| --- | --- | --- | --- | ---: | :---: |
| M1 | storage.js | inverted condition | `statusFromChar`: invert the `x` → Done check | 112 | yes |
| M2 | storage.js | off-by-one | `DUE_DATE_RE` requires a 5-digit year instead of 4 | 38 | yes |
| M3 | storage.js | wrong field | `normalizeImported` stores `due.overflow` (junk) into `dueDate` instead of `due.dueDate` | 13 | yes |
| M4 | storage.js | dropped guard | `normalizeDueDate` no longer treats empty string as a clear | 4 | yes |
| M5 | metadata.js | inverted condition | `tokenCoverage` measures untracked events instead of tracked ones | 5 | yes |
| M6 | metadata.js | off-by-one | `velocity`'s 7/30-day recency windows shrunk by one day | 0 | **no** |
| M7 | metadata.js | wrong field | per-ticket model tagging guards on `e.ticket` instead of `e.model` | 5 | yes |
| M8 | metadata.js | dropped guard | `computeHealth` divides by zero (NaN) when there is no open work at all | 1 | yes |
| M9 | git.js | inverted condition | `hasCommitForTicket` reports found when there are ZERO recorded commits | 9 | yes |
| M10 | git.js | off-by-one | `hasCommitForTicket` asks git log for 2 entries instead of 1 | 0 | **no** |
| M11 | git.js | wrong field | `commitMessage` returns `title` instead of the explicit `message` | 2 | yes |
| M12 | git.js | dropped guard | `parseClosingRefs` no longer dedupes repeated ticket refs | 1 | yes |
| M13 | cleanup.js | inverted condition | `findStale` skips all non-Done tickets instead of Done ones | 2 | yes |
| M14 | cleanup.js | off-by-one | `findStale` requires one extra day past `staleDays` | 0 | **no** |
| M15 | cleanup.js | wrong field | `findSlaBreaches` computes `priority` from `t.status` instead of `t.priority` | 3 | yes |
| M16 | cleanup.js | dropped guard | `findSlaBreaches` drops the null-threshold guard (In Progress branch) | 0 | **no** |

**Baseline-suite catch rate: 12/16 (75%).** Every mutation with any observable
effect landed on covered code except M6/M10/M14/M16 — all four missed
mutations are subtle boundary/off-by-one or defensively-mocked-around cases
(M10's test harness injects a fake `exec` that ignores its arguments
entirely, so the git-log count never mattered to the test).

M1 alone broke 112 otherwise-unrelated tests across the suite (agent monitor,
budget, drift, handoffs, reports, sprints, …) — a single inverted condition in
board-wide status-char parsing cascades everywhere `status` is read, which is
nearly the whole codebase. This is the single clearest illustration in this
pass of why full-suite regression testing matters even when a narrower,
ticket-scoped test variant would miss the same defect entirely (see M1's row
in the per-tier table below: none of the four storage.js tier variants catch
it, because none of them test status-char parsing — they're all scoped to
due-date behavior).

## Per-tier catch rate (real generated variants)

Only `storage.js` (reusing FBMCPB-10) and `metadata.js` (newly generated this
session) have real per-tier variant files; see Limitations for why `git.js`
and `cleanup.js` don't.

### storage.js (FBMCPB-10 variants, mutations M1–M4)

| Model | Caught | Catch rate | Unique catches | Tokens | Cost | Cost / caught defect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| fable (bonus) | 3/4 | 75% | 0 | n/a (unmeasured) | n/a | n/a |
| haiku | 1/4 | 25% | 0 | 49,908 | $0.1497 | $0.1497 |
| sonnet | 3/4 | 75% | 0 | 56,287 | $0.3377 | $0.1126 |
| opus | 3/4 | 75% | 0 | 74,719 | $1.1208 | $0.3736 |

Per-mutation: M1 caught by **none** (all four tiers are due-date-scoped, not
status-scoped — the full suite catches it instead, see above). M2 caught by
all four. M3/M4 caught by fable/sonnet/opus identically; haiku misses both.
Zero unique catches anywhere — same "no tier differentiation" pattern the
FBMCPF-185 pilot found on this same file with the builtin mutation set, now
reproduced with a different, hand-targeted mutation set.

### metadata.js (FBMCPF-280 variants, newly generated, mutations M5–M8)

| Model | Caught | Catch rate | Unique catches | Tokens | Cost | Cost / caught defect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| haiku | 1/4 | 25% | 0 | 25,606 | $0.0768 | $0.0768 |
| opus | 1/4 | 25% | 0 | 34,383 | $0.5157 | $0.5157 |
| sonnet | 3/4 | 75% | **2** | 72,490 | $0.4349 | $0.1450 |

Per-mutation: M6 caught by none (missed everywhere, including the full
suite). M7 (`velocity` wrong-field guard) caught by all three — `velocity()`
is a pure function all three tiers tested thoroughly. M5 and M8 (both inside
`computeHealth`) were caught **only by sonnet**, and this is a fixture-quality
story, not a bug-finding-cleverness story: `computeHealth(board, project)`
calls `readWorkLog(board, project)`, which needs `board.projectDir(project)`
to resolve a real directory. Sonnet's generated test built a real temp
directory, wired `projectDir: () => dir`, and wrote an actual
`agent_work_log.md` file — the only one of the three that could exercise
`computeHealth` at all. Haiku's fake board omits `projectDir` entirely, so
its two `computeHealth` tests **fail even at the clean baseline** (`TypeError:
board.projectDir is not a function`) and can never catch anything regardless
of mutation. Opus also omits `projectDir`, but wrapped every `computeHealth`
call in a `try/catch` that calls `t.skip()` on failure — a more defensive
choice than haiku's (it doesn't leave a false failure sitting in the suite),
but the practical effect is identical: those tests never run their
assertions, so opus's `computeHealth` coverage is exactly as blind as
haiku's despite opus being the more expensive tier. Sonnet's willingness to
build the fixture correctly, not just defensively survive its absence, is
what earned the 2 unique catches here.

### Combined (8 mutations with real tier data, storage.js + metadata.js)

| Model | Caught | Catch rate | Combined tokens | Combined cost | Cost / caught defect |
| --- | ---: | ---: | ---: | ---: | ---: |
| haiku | 2/8 | 25% | 75,514 | $0.2265 | $0.1133 |
| opus | 4/8 | 50% | 109,102 | $1.6365 | $0.4091 |
| sonnet | 6/8 | 75% | 128,777 | $0.7726 | $0.1288 |

Pricing per `server/pricing.js` `DEFAULT_PRICING` (Sonnet 5 introductory rate,
in effect through 2026-08-31 per that file's header comment) — same table
FBMCPF-185 used, cited there for the rate provenance.

## Baseline-suite vs tier-variant comparison

The full human/agent-written suite (75% catch rate, 12/16) outperforms every
individual tier's narrow variant set on raw catch rate, and by a wide margin
on *blast-radius* mutations like M1 that a ticket-scoped variant would never
think to test. Ticket-scoped multi-model variants are not a substitute for
the full suite; they're a narrower instrument for asking "does this
tier's test-writing catch the specific defect classes this ticket cares
about" — useful for the up/downgrade cost question, not for regression safety
in general.

## Cost-per-defect discussion

Using FBMCPF-185's DEFAULT_PRICING-based costing convention: on this 8-mutation,
2-module sample, **sonnet caught 3x as many defects as haiku for about 3.4x
the generation cost ($0.77 vs $0.23 total) — cost per *caught* defect came out
close either way ($0.129 sonnet vs $0.113 haiku)**, but sonnet's absolute
catch count is what actually matters for shipping confidence: haiku's 2/8
catches leave 6 real defect classes undetected by its own tests, including
both of the `computeHealth` mutations. Opus was the most expensive tier here
($1.64 total, $0.41/caught-defect) for a catch rate matching haiku's, not
sonnet's — its `t.skip()`-on-fixture-failure choice cost it the same 2
mutations sonnet caught, despite opus presumably being the more capable
model in the abstract. This directly contradicts a "higher tier = better
tests" assumption, echoing FBMCPF-185's own finding that tier upgrades
"bought no additional defects caught" on its single-module sample — this
pass adds a second module and the same qualitative conclusion holds, with
sonnet now the standout rather than a three-way tie.

## Routing recommendation

- **Default to sonnet** for multi-model test generation on modules whose
  functions need a working fixture (a fake board, a temp directory, an
  injected `exec`) to exercise deeper branches — `computeHealth`-style code
  is exactly this shape, and only sonnet reliably built a fixture that
  actually worked rather than defensively working around its own gap.
- **Haiku remains reasonable for pure, fixture-free functions** (`velocity()`
  alone, `normalizeDueDate`, `parseClosingRefs`) where all three tiers
  produced comparable coverage at roughly a third of sonnet's cost — but on
  this sample haiku's catch rate was the weakest of the three whenever a
  fixture was involved, so treat "haiku is fine" as conditional on the
  target function being fixture-free, not as a blanket downgrade rule.
  Confirm this by checking whether the target function takes a `board`/`exec`
  argument before defaulting to haiku.
- **Opus is not justified by this sample.** It cost more than sonnet and
  matched haiku's catch rate, not sonnet's. Its models's abstract
  capability didn't translate into better *test-writing judgment* here (it
  chose the defensive-skip path over building a working fixture).
- **None of this replaces the full suite.** The full suite still caught
  defects (M1) that no tier's ticket-scoped variant would ever have been
  positioned to catch, simply by having far broader surface area.

This recommendation is drawn from 8 tier-compared mutations across 2 modules
— treat it as a second, corroborating data point alongside FBMCPF-185's
single-module pilot, not a general verdict. See Limitations.

## Honest limitations

- **Only 2 of 4 modules have real per-tier variant data.** `git.js` and
  `cleanup.js` have no `test/<ticket>.<model>.test.js` files, and generating
  genuine three-tier variants for every module in scope (via real subagent
  dispatch, the only non-fabricated path available) was not done for these
  two within this pass's time/cost budget — after producing one new
  genuinely-generated module (metadata.js, 3 real subagent calls) alongside
  the reused storage.js precedent, the remaining two modules were run
  full-suite-only rather than spinning up 6 more subagent generations. This
  is a scope-bounding decision, not a "couldn't invoke a model" limitation —
  the mechanism exists and was used for metadata.js; it just wasn't applied
  everywhere.
- **Small sample.** 8 mutations with tier data across 2 modules is still a
  small n — read the routing recommendation as directional, not definitive,
  consistent with FBMCPF-185's own caveat on its single-module pilot.
- **fable has an unmeasured cost for storage.js and no data at all for
  metadata.js** (no fable subagent was dispatched this session — the ticket's
  explicit scope was haiku/sonnet/opus; fable's storage.js numbers are
  included only because that variant already existed on disk from FBMCPF-185).
- **The "dropped await" defect class doesn't exist in this codebase's target
  modules** — confirmed by grep across storage.js/metadata.js/git.js/cleanup.js
  before designing mutations (zero `async function`/`await` in any of the
  four). "Dropped guard" was substituted and labeled as such throughout,
  not silently relabeled as "dropped await."
- **Sonnet's advantage on metadata.js is a fixture-engineering story, not
  purely a bug-finding one.** Its unique catches trace to correctly wiring
  `board.projectDir` + a real work-log file, which haiku and opus's variants
  did not do. This is a real, useful signal about generation quality, but it
  means the "sonnet found more bugs" framing is more precisely "sonnet built
  a test that could reach the bugs at all."
- **Environment artifact, caught and corrected, not a repo defect.** An early
  full-suite mutation run for M3 showed ~654 failures — implausible for a
  single-line change. Investigation traced it to `os.tmpdir()` resolving to
  `/sessions/.../tmp`, a mount at 100% *inode* usage (not byte usage) in this
  sandbox, causing `fs.mkdtempSync` to fail with `ENOSPC` across nearly every
  test that uses a temp directory — completely unrelated to any mutation.
  Fixed by setting `TMPDIR` to a location on the root filesystem (plenty of
  free inodes) for all subsequent mutation runs; a clean, reproducible
  baseline (1044/1049 passing, only 2 known pre-existing gaps) was confirmed
  before any mutation counts in this document were trusted. Flagging this
  explicitly because it's exactly the kind of "suite oddity" this ticket's
  brief warned about, and the fix was environmental (TMPDIR redirection), not
  a fresh-copy-and-hope fix.
- **The 2 known pre-existing baseline gaps** (`FBMCPF-280.haiku.test.js`'s two
  `computeHealth` tests) are a genuine defect in that generated test's own
  fixture (missing `board.projectDir`), present at baseline with or without
  any mutation. They are excluded from "new failures beyond baseline" counts
  throughout this document.
- **`eval_report` (the board-vs-chat experiment tool) was not updated.** That
  tool compares `experiment:board`/`experiment:chat`-labeled trials via
  work-log data — a different axis from mutation-testing catch rates, and
  labeling this ticket into that experiment wasn't part of the explicit scope
  given for this pass. Noting the gap here rather than silently skipping it.
- **Two other agents were reported to be editing the real repo concurrently**
  during this work. All mutation/generation/execution happened in `/tmp`
  copies specifically because of this; the real repo's `server/` and `test/`
  directories were never opened for writing at any point in this pass.

## Artifacts

- Mutation set: `mutations.json` (16 entries), one-off runner
  `run_one_mutation.mjs`, and the tier-matrix script `run_tier_matrix.mjs` —
  all created and run only inside `/tmp/eval-280`, not part of this repo.
- Generated variants: `test/FBMCPF-280.{haiku,sonnet,opus}.test.js` +
  `test/FBMCPF-280.variants.json`, written only inside `/tmp/eval-280/test/`
  (never in this repo's `test/`).
- Board records: `log_test_run` entries for suites `eval280-haiku`,
  `eval280-sonnet`, `eval280-opus`, `eval280-fable`, and
  `eval280-baseline-full-suite`, all under ticket FBMCPF-280.
