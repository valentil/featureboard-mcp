import { test } from "node:test";
import assert from "node:assert/strict";
import { exportWorkLog, exportMetricsSeries } from "../server/pmbridge.js";

// FBMCPF-217 — metrics/work-log flat-file export.

const ENTRIES = [
  { date: "2026-07-18", time: "10:00:00", ticket: "FBF-1", summary: "built the thing", model: "sonnet", tokens: 5000, additions: 40, deletions: 3 },
  { date: "2026-07-19", time: "11:30:00", ticket: "FBB-2", summary: 'fixed "quoted, thing"', model: "haiku", tokens: 1200 },
];

test("worklog json export carries all columns", () => {
  const rows = JSON.parse(exportWorkLog(ENTRIES, "json"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ticket, "FBF-1");
  assert.equal(rows[0].additions, 40);
  assert.equal(rows[1].model, "haiku");
});

test("worklog csv export escapes quoted fields and has a header", () => {
  const csv = exportWorkLog(ENTRIES, "csv");
  const lines = csv.split("\n");
  assert.match(lines[0], /^date,time,ticket,summary,model,tokens/);
  assert.equal(lines.length, 3);
  assert.ok(lines[2].includes('"fixed ""quoted, thing"""'));
});

test("completions export sorts dates and keeps status counts in json", () => {
  const metrics = {
    features: { total: 3, done: 2 },
    bugs: { total: 1, closed: 1 },
    completedByDate: { "2026-07-19": 2, "2026-07-18": 1 },
  };
  const j = JSON.parse(exportMetricsSeries(metrics, "json"));
  assert.deepEqual(j.completedByDate.map((r) => r.date), ["2026-07-18", "2026-07-19"]);
  assert.equal(j.features.total, 3);
  const csv = exportMetricsSeries(metrics, "csv");
  assert.equal(csv.split("\n")[0], "date,completed");
  assert.equal(csv.split("\n").length, 3);
});
