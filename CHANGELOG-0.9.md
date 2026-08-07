# FeatureBoard MCP 0.9.x

## 0.9.1 — impact testing (FBMCPF-387)

First-class impact testing: run ONLY the tests whose require/import dependency
closure contains a changed file, and leave the full suite to CI.

- **`checks.testImpact` project config** (via `set_project_config`): builtin
  mode runs each impacted test entry directly with node; delegated mode
  (`command`) runs the repo's own impact runner once with `FB_IMPACT_CHANGED`
  (newline-separated changed files) and `FB_IMPACT_REVISION` in the env.
  `entries` overrides test-entry discovery (default: every `node <path>.js` in
  package.json scripts, excluding bare `node --check`); `slowPatterns` defers
  matching impacted entries to CI (reported, not run); `ignorePatterns`
  excludes changed files (generated bundles, docs) from impact computation.
- **Impact-graph database**, owned by the board at
  `<project>/.featureboard/checks/impact-graph.json` (override via
  `testImpact.graphPath`): `{ version: 1, builtAt, entries, files: { <rel>:
  { m, s, deps } } }` — per-file direct deps keyed by mtime/size, rebuilt
  incrementally on every run (only changed files are re-parsed). The same
  interchange format CADSolver's `tools/impacted_tests.js` established.
- **Runner integration** (`scripts/run-checks.mjs`): a new impact stage runs
  between the syntax checks and configured commands, emitting an `impact-map`
  summary entry (changed → impacted / deferred / unmapped) plus one
  `impact:<entry>` result per test run. Crash-isolated: an impact-stage error
  fails that entry, never the whole run. Exported for reuse:
  `parseRelativeDeps`, `discoverTestEntries`, `buildImpactGraph`,
  `impactedTests`.
- **Work packets** (`get_work_packet`): when impact testing is configured and
  the graph DB exists, the packet carries `impactedTests` — the test entries
  reachable from the ticket's mentioned files — so agents know the local gate
  up front.
- **server/checks.js**: `resolveChecksConfig` passes `testImpact` through;
  `startChecks` defaults `graphPath` into the board-owned DB; new exports
  `impactGraphPath` / `readImpactGraph`.

Files that no test entry reaches are reported as `unmapped` (CI remains the
backstop). Non-goal for 0.9.1: language walkers beyond JS require/import.
