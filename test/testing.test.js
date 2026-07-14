import { test } from "node:test";
import assert from "node:assert/strict";
import { groupBySuite, coverageByProduct } from "../server/testing.js";

// FBMCPF-75 — organize tests by suite

test("groupBySuite rolls up per suite; newest run is latest", () => {
  const runs = [
    { suite: "unit", date: "2026-07-10", passed: 5, failed: 1 },
    { suite: "unit", date: "2026-07-11", passed: 8, failed: 0 },
    { suite: "e2e", date: "2026-07-11", passed: 2, failed: 2 },
  ];
  const r = groupBySuite(runs);
  assert.equal(r.count, 2);
  const unit = r.suites.find((s) => s.suite === "unit");
  assert.equal(unit.runs, 2);
  assert.equal(unit.latest.date, "2026-07-11");
  assert.equal(unit.passing, true); // latest had 0 fails
  assert.equal(unit.totalPassed, 13);
  assert.equal(unit.totalFailed, 1);
  const e2e = r.suites.find((s) => s.suite === "e2e");
  assert.equal(e2e.passing, false);
  assert.equal(e2e.passRate, 50);
  assert.deepEqual(r.failing, ["e2e"]);
});

test("groupBySuite buckets unlabeled runs + handles empty", () => {
  assert.deepEqual(groupBySuite([]), { suites: [], count: 0, failing: [] });
  const r = groupBySuite([{ passed: 1, failed: 0 }]);
  assert.equal(r.suites[0].suite, "(unlabeled)");
  assert.equal(r.suites[0].passing, true);
});

// FBMCPF-103 — coverage by product
test("coverageByProduct rolls up tested vs untested per product", () => {
  const tasks = [
    { ticketNumber: "FBF-1", product: "Board" },
    { ticketNumber: "FBF-2", product: "Board" },
    { ticketNumber: "FBB-3", product: "CRM" },
    { ticketNumber: "FBF-4" }, // no product
  ];
  const runs = [{ ticket: "FBF-1", suite: "unit" }, { ticket: "FBB-3" }, { ticket: "FBF-1" }];
  const r = coverageByProduct(tasks, runs);
  const board = r.products.find((p) => p.product === "Board");
  assert.equal(board.total, 2);
  assert.equal(board.tested, 1);
  assert.equal(board.coveragePct, 50);
  assert.deepEqual(board.untestedTickets, ["FBF-2"]);
  assert.equal(r.products.find((p) => p.product === "CRM").coveragePct, 100);
  assert.equal(r.products.find((p) => p.product === "(unassigned)").tested, 0);
  assert.equal(r.overall.total, 4);
  assert.equal(r.overall.tested, 2);
  assert.equal(r.overall.coveragePct, 50);
});

test("coverageByProduct handles empty inputs", () => {
  assert.deepEqual(coverageByProduct([], []), { products: [], overall: { total: 0, tested: 0, untested: 0, coveragePct: 0 } });
});
