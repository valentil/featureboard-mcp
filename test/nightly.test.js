import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfig,
  planNightlyRun,
  parseTapSummary,
  prunePlan,
  formatTestLogLine,
  stampParts,
} from "../scripts/run-nightly-tests.mjs";

// FBMCPF-37 — Nightly test scheduling

test("resolveConfig fills defaults and coerces enabled/notify flags", () => {
  const c = resolveConfig({ command: "node", args: ["--test"] });
  assert.equal(c.command, "node");
  assert.deepEqual(c.args, ["--test"]);
  assert.equal(c.enabled, true);
  assert.equal(c.keepRuns, 30);
  assert.equal(c.notifyOnFailureOnly, true);
  assert.equal(c.schedule, "0 3 * * *");
});

test("resolveConfig rejects malformed config", () => {
  assert.throws(() => resolveConfig(null), /must be a JSON object/);
  assert.throws(() => resolveConfig([]), /must be a JSON object/);
  assert.throws(() => resolveConfig({ command: "" }), /command/);
  assert.throws(() => resolveConfig({ command: "npm", args: "test" }), /args/);
  assert.throws(() => resolveConfig({ command: "npm", timeoutMinutes: 0 }), /timeoutMinutes/);
  assert.throws(() => resolveConfig({ command: "npm", keepRuns: 0 }), /keepRuns/);
});

test("planNightlyRun produces an executable, timestamped plan", () => {
  const now = new Date("2026-07-13T03:07:09");
  const plan = planNightlyRun(resolveConfig({ command: "npm", args: ["test"], timeoutMinutes: 5 }), { now });
  assert.equal(plan.enabled, true);
  assert.equal(plan.command, "npm");
  assert.deepEqual(plan.args, ["test"]);
  assert.equal(plan.timeoutMs, 5 * 60_000);
  assert.equal(plan.resultFile, "nightly-2026-07-13T030709.json");
});

test("disabled config surfaces in the plan", () => {
  const plan = planNightlyRun(resolveConfig({ command: "npm", enabled: false }), {});
  assert.equal(plan.enabled, false);
});

test("parseTapSummary reads node:test counters", () => {
  const out = [
    "TAP version 13",
    "# tests 12",
    "# pass 11",
    "# fail 1",
    "# skipped 2",
  ].join("\n");
  const s = parseTapSummary(out);
  assert.equal(s.tests, 12);
  assert.equal(s.passed, 11);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.parsed, true);
});

test("parseTapSummary defaults to zero when nothing parses", () => {
  const s = parseTapSummary("no tap here");
  assert.deepEqual([s.tests, s.passed, s.failed, s.skipped, s.parsed], [0, 0, 0, 0, false]);
});

test("prunePlan keeps the newest keepRuns and deletes older", () => {
  const files = [
    "nightly-2026-07-10T030000.json",
    "nightly-2026-07-11T030000.json",
    "nightly-2026-07-12T030000.json",
    "nightly-2026-07-13T030000.json",
    "unrelated.txt",
  ];
  const del = prunePlan(files, 2);
  assert.deepEqual(del, [
    "nightly-2026-07-10T030000.json",
    "nightly-2026-07-11T030000.json",
  ]);
});

test("prunePlan deletes nothing when under the cap", () => {
  assert.deepEqual(prunePlan(["nightly-2026-07-13T030000.json"], 30), []);
});

test("formatTestLogLine matches the board test_runs.md shape", () => {
  const now = new Date("2026-07-13T03:05:00");
  const passLine = formatTestLogLine({ passed: 12, failed: 0, skipped: 0, exitCode: 0 }, { now });
  assert.match(passLine, /^2026-07-13 03:05:00, passed: 12, failed: 0, skipped: 0, suite: nightly, nightly run pass \(exit 0\)$/);
  const failLine = formatTestLogLine({ passed: 10, failed: 2, skipped: 0, exitCode: 1 }, { now });
  assert.match(failLine, /failed: 2, skipped: 0, suite: nightly, nightly run FAIL \(exit 1\)/);
});

test("stampParts pads date and time", () => {
  const s = stampParts(new Date("2026-01-02T04:05:06"));
  assert.equal(s.date, "2026-01-02");
  assert.equal(s.time, "04:05:06");
  assert.equal(s.fileStamp, "2026-01-02T040506");
});
