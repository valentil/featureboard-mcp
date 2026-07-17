# Model up/downgrade eval matrix — FBMCPB-10

**mode: real (FBMCPB-10 variants vs seeded mutations in `server/storage.js`)**

Generated 2026-07-17T16:36:09.335Z by directly invoking `runVariantMatrix` (FBMCPF-148,
`server/modeleval.js`) against the four FBMCPB-10 test variants — `test/FBMCPB-10.fable.test.js`,
`test/FBMCPB-10.opus.test.js`, `test/FBMCPB-10.sonnet.test.js`, `test/FBMCPB-10.haiku.test.js`
(manifest: `test/FBMCPB-10.variants.json`) — with `targetFile: "server/storage.js"` and the
default `builtinMutations()` set. Seeded mutations were applied to a temp COPY of
`server/storage.js`; the repo itself was never touched. The MCP tool path
(`eval_model_matrix`) times out on this matrix, so the harness was invoked directly via a
one-off runner script outside the repo (`/tmp`, not committed) that imports `runVariantMatrix`
from `server/modeleval.js`.

## Baseline (unmutated)

All four variant files pass cleanly against the unmutated `server/storage.js`:

| Model | Pass | Fail | Crashed |
| --- | ---: | ---: | :---: |
| fable | 14 | 0 | no |
| opus | 19 | 0 | no |
| sonnet | 19 | 0 | no |
| haiku | 21 | 0 | no |

## Seeded mutations — applied/skipped

All 6 builtin mutations found a matching pattern in `server/storage.js` and were applied.
None were skipped.

| Mutation | Description | Applied | Caught by |
| --- | --- | :---: | --- |
| `flip-strict-eq` | Flip the first `===` to `!==` (or reverse) | yes | *(none)* |
| `flip-loose-eq` | Flip the first `==` to `!=` (or reverse), skipping `===`/`!==` | yes | fable, opus, sonnet, haiku |
| `negate-boolean-literal` | Flip the first `return true`/`return false` | yes | *(none)* |
| `off-by-one-const` | Increment the first standalone numeric literal by 1 | yes | *(none)* |
| `flip-logical-and-or` | Flip the first `&&` to `\|\|` (or reverse) | yes | fable, opus, sonnet, haiku |
| `flip-comparison` | Flip the first `<` to `>` (or reverse) | yes | *(none)* |

Applied: 6/6. Skipped: 0/6.

Only 2 of the 6 seeded defects were caught by *any* variant, and both of those were caught by
**all four** models identically — there was no divergence in which mutations different tiers
noticed. The other 4 mutations (`flip-strict-eq`, `negate-boolean-literal`, `off-by-one-const`,
`flip-comparison`) landed on code paths in `storage.js` that none of the FBMCPB-10 variants
exercise, so none of the four suites caught them.

## Per-model catch summary

| Model | Defects caught | Unique catches | Catch rate | Unique catch rate | Tokens | Cost | Cost / caught defect |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fable | 2/6 | 0 | 0.3333 | 0 | n/a (unmeasured) | n/a | n/a |
| opus | 2/6 | 0 | 0.3333 | 0 | 74,719 | $1.1208 | $0.5604 |
| sonnet | 2/6 | 0 | 0.3333 | 0 | 56,287 | $0.3377 | $0.1689 |
| haiku | 2/6 | 0 | 0.3333 | 0 | 49,908 | $0.1497 | $0.0749 |

fable's generation-token count was not measured for this ticket, so it was intentionally
omitted from `tokensByModel` rather than estimated — its cost and cost-per-caught-defect are
reported as n/a, not zero.

## Overlap matrix

Seeded mutations caught by both row and column model; diagonal = that model's total catches.

| | fable | haiku | opus | sonnet |
| --- | ---: | ---: | ---: | ---: |
| fable | 2 | 2 | 2 | 2 |
| haiku | 2 | 2 | 2 | 2 |
| opus | 2 | 2 | 2 | 2 |
| sonnet | 2 | 2 | 2 | 2 |

Full overlap on both axes for every pair confirms it: all four tiers caught exactly the same
two mutations (`flip-loose-eq`, `flip-logical-and-or`) and missed the same four. Zero unique
catches anywhere.

## Reading

All four model tiers produced test suites that behave identically at the level this eval can
see: same 2/6 seeded-defect catch rate, same defects caught, same defects missed, zero
tier-specific catches. On this evidence, none of the four tiers' tests earned back a
*differentiated* bug-catching edge over the others for `server/storage.js` — the extra
generation spend on opus (74.7k tokens, $1.12) and sonnet (56.3k tokens, $0.34) bought no
additional defects caught versus haiku (49.9k tokens, $0.15), which caught the same two
mutations at roughly a third to a seventh of the cost per catch. If this pattern held up
across more tickets, haiku would be the economical default for this kind of due-date/storage
test generation, with upgrades to sonnet/opus justified only when a ticket's surface area is
large enough that broader prompt coverage (not raw catch rate on this small mutation set)
matters. fable's cost can't be judged from this run since its generation tokens were never
measured — that gap should be closed before drawing a conclusion about fable specifically.

This is a single-ticket, single-target-file, 6-mutation sample — read it as one data point in
the FBMCPF-148 series, not a general verdict on model tiers.

## Raw JSON

<details>
<summary>Full <code>runVariantMatrix</code> result</summary>

```json
{
  "ticket": "FBMCPB-10",
  "dir": "/sessions/sharp-great-mccarthy/mnt/featureboard-mcp",
  "targetFile": "server/storage.js",
  "mode": "real",
  "generatedAt": "2026-07-17T16:36:09.335Z",
  "models": [
    "fable",
    "haiku",
    "opus",
    "sonnet"
  ],
  "baseline": {
    "fable": { "pass": 14, "fail": 0, "crashed": false },
    "haiku": { "pass": 21, "fail": 0, "crashed": false },
    "opus": { "pass": 19, "fail": 0, "crashed": false },
    "sonnet": { "pass": 19, "fail": 0, "crashed": false }
  },
  "mutations": [
    {
      "id": "flip-strict-eq",
      "description": "Flip the first === to !== (or !== to ===)",
      "applied": true,
      "caughtBy": [],
      "testsCaught": {}
    },
    {
      "id": "flip-loose-eq",
      "description": "Flip the first == to != (or != to ==), skipping ===/!==",
      "applied": true,
      "caughtBy": ["fable", "haiku", "opus", "sonnet"],
      "testsCaught": {
        "fable": [
          "normalizeDueDate: null, undefined and empty string all clear without overflow",
          "normalizeDueDate: valid YYYY-MM-DD passes through exactly, whitespace trimmed",
          "normalizeDueDate: prose and near-miss formats become overflow verbatim (trimmed)",
          "normalizeDueDate: non-string input is String()-coerced, numbers reject to overflow",
          "addTask: junk dueDate is remapped into description and dueDate is null",
          "addTask: junk dueDate appends to an existing description, space-joined, order preserved",
          "addTask: valid dueDate is stored and survives a re-read from markdown",
          "addTask: bugs get the same junk remap as features",
          "updateTask: junk dueDate throws Invalid dueDate and leaves the task untouched on disk",
          "updateTask: null clears the dueDate; omitting dueDate leaves it unchanged",
          "updateTask: a valid replacement dueDate is accepted",
          "import (JSON): junk due folds into description, valid dueDate kept, due/dueDate both honored",
          "import (CSV): junk due remaps; every imported dueDate is absent or canonical + sortable"
        ],
        "haiku": [
          "normalizeDueDate handles null input",
          "normalizeDueDate handles whitespace string as overflow",
          "normalizeDueDate rejects prose description as junk",
          "normalizeDueDate rejects US date format",
          "normalizeDueDate rejects DD-MM-YYYY format",
          "normalizeDueDate rejects partial date",
          "addTask stores valid dueDate without modification",
          "addTask moves junk dueDate to description",
          "addTask with junk dueDate and empty description creates description from junk",
          "updateTask accepts valid dueDate",
          "addTask appends junk dueDate to existing description",
          "valid dueDate values can be sorted chronologically",
          "addTask with multiple fields including junk dueDate preserves other fields",
          "normalizeDueDate rejects dates without dashes",
          "addTask with bug type moves junk dueDate to description",
          "board with mixed valid/invalid dueDate values handles both correctly"
        ],
        "opus": [
          "normalizeDueDate: null/undefined/empty clear the field with no overflow",
          "normalizeDueDate: a valid YYYY-MM-DD passes through unchanged, no overflow",
          "normalizeDueDate: surrounding whitespace is trimmed off a valid date",
          "normalizeDueDate: junk is rejected as a date and preserved verbatim in overflow",
          "normalizeDueDate: format validation is strict on digit counts and anchoring",
          "normalizeDueDate: validation is structural (format), not calendrical",
          "addTask: a valid dueDate is stored and serialized with a Due: token",
          "addTask: junk dueDate is remapped to description; no dueDate stored",
          "addTask: junk dueDate appends to an EXISTING description, preserving both",
          "addTask: the due field only affects dueDate, not other fields",
          "updateTask: a valid dueDate change persists to disk",
          "updateTask: dueDate:null clears the field",
          "updateTask: junk dueDate THROWS and mutates nothing on disk (reject, not remap)",
          "updateTask: omitting dueDate leaves the existing value untouched",
          "parseImport JSON: legacy due prose is remapped to description; valid dueDate kept",
          "parseImport JSON: junk due appends to an existing description (data preservation)",
          "parseImport CSV: junk in a due column is remapped; a valid due column is kept",
          "parseImport: no imported task ever carries a non-date dueDate (sort/filter integrity)"
        ],
        "sonnet": [
          "normalizeDueDate accepts a well-formed YYYY-MM-DD string",
          "normalizeDueDate treats null and empty string as an explicit clear, no overflow",
          "normalizeDueDate flags prose as overflow and does not set dueDate",
          "normalizeDueDate trims surrounding whitespace before validating",
          "normalizeDueDate rejects date-time and slash-formatted strings as overflow",
          "normalizeDueDate only validates shape, not calendar correctness",
          "normalizeDueDate coerces non-string values via String()",
          "addTask stores a valid dueDate and leaves description untouched",
          "addTask remaps a prose dueDate into description and clears dueDate",
          "addTask uses junk due text as the description when none was provided",
          "addTask leaves dueDate null when it is omitted entirely",
          "updateTask accepts a valid replacement dueDate",
          "updateTask rejects a prose dueDate with a descriptive error and writes nothing",
          "parseImport (csv) remaps a junk due column into the description",
          "parseImport (csv) keeps a valid duedate column as dueDate untouched",
          "parseImport (json) remaps a junk dueDate field into description for tasks array",
          "parseImport (json) keeps a valid dueDate field for a bare object payload",
          "end-to-end: importing a legacy CSV row through addTask never leaves a junk dueDate on disk",
          "end-to-end: importing a legacy CSV row with a valid due date preserves it through addTask"
        ]
      }
    },
    {
      "id": "negate-boolean-literal",
      "description": "Flip the first `return true`/`return false`",
      "applied": true,
      "caughtBy": [],
      "testsCaught": {}
    },
    {
      "id": "off-by-one-const",
      "description": "Increment the first standalone numeric literal by 1",
      "applied": true,
      "caughtBy": [],
      "testsCaught": {}
    },
    {
      "id": "flip-logical-and-or",
      "description": "Flip the first && to || (or || to &&)",
      "applied": true,
      "caughtBy": ["fable", "haiku", "opus", "sonnet"],
      "testsCaught": {
        "fable": [
          "addTask: valid dueDate is stored and survives a re-read from markdown",
          "updateTask: junk dueDate throws Invalid dueDate and leaves the task untouched on disk",
          "updateTask: null clears the dueDate; omitting dueDate leaves it unchanged",
          "updateTask: a valid replacement dueDate is accepted"
        ],
        "haiku": [
          "updateTask accepts valid dueDate",
          "parseMarkdown preserves junk dueDate as-is from markdown",
          "parseMarkdown extracts valid YYYY-MM-DD from due field"
        ],
        "opus": [
          "addTask: a valid dueDate is stored and serialized with a Due: token",
          "addTask: junk dueDate is remapped to description; no dueDate stored",
          "addTask: junk dueDate appends to an EXISTING description, preserving both",
          "updateTask: a valid dueDate change persists to disk",
          "updateTask: dueDate:null clears the field",
          "updateTask: junk dueDate THROWS and mutates nothing on disk (reject, not remap)",
          "updateTask: omitting dueDate leaves the existing value untouched"
        ],
        "sonnet": [
          "addTask stores a valid dueDate and leaves description untouched",
          "addTask remaps a prose dueDate into description and clears dueDate",
          "addTask uses junk due text as the description when none was provided",
          "updateTask accepts a valid replacement dueDate",
          "updateTask rejects a prose dueDate with a descriptive error and writes nothing",
          "end-to-end: importing a legacy CSV row through addTask never leaves a junk dueDate on disk",
          "end-to-end: importing a legacy CSV row with a valid due date preserves it through addTask"
        ]
      }
    },
    {
      "id": "flip-comparison",
      "description": "Flip the first < to > (or > to <), skipping <=/>=/shift/generics-ish forms",
      "applied": true,
      "caughtBy": [],
      "testsCaught": {}
    }
  ],
  "perModel": [
    {
      "model": "fable",
      "totalMutations": 6,
      "defectsCaught": 2,
      "uniqueDefectsCaught": 0,
      "catchRate": 0.3333,
      "uniqueCatchRate": 0,
      "tokens": null,
      "cost": null,
      "costPerCaughtDefect": null
    },
    {
      "model": "haiku",
      "totalMutations": 6,
      "defectsCaught": 2,
      "uniqueDefectsCaught": 0,
      "catchRate": 0.3333,
      "uniqueCatchRate": 0,
      "tokens": 49908,
      "cost": 0.1497,
      "costPerCaughtDefect": 0.0749
    },
    {
      "model": "opus",
      "totalMutations": 6,
      "defectsCaught": 2,
      "uniqueDefectsCaught": 0,
      "catchRate": 0.3333,
      "uniqueCatchRate": 0,
      "tokens": 74719,
      "cost": 1.1208,
      "costPerCaughtDefect": 0.5604
    },
    {
      "model": "sonnet",
      "totalMutations": 6,
      "defectsCaught": 2,
      "uniqueDefectsCaught": 0,
      "catchRate": 0.3333,
      "uniqueCatchRate": 0,
      "tokens": 56287,
      "cost": 0.3377,
      "costPerCaughtDefect": 0.1689
    }
  ],
  "overlap": {
    "fable": { "fable": 2, "haiku": 2, "opus": 2, "sonnet": 2 },
    "haiku": { "fable": 2, "haiku": 2, "opus": 2, "sonnet": 2 },
    "opus": { "fable": 2, "haiku": 2, "opus": 2, "sonnet": 2 },
    "sonnet": { "fable": 2, "haiku": 2, "opus": 2, "sonnet": 2 }
  },
  "summary": "6/6 seeded mutations applied; fable caught the most (2/6)."
}
```

</details>
