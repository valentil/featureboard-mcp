/**
 * FeatureBoard test organization (FBMCPF-75).
 *
 * Ports organize-tests: group the recorded test runs (from the testing center,
 * FBMCPF-34 — test_runs.md) by suite so each suite's latest status and pass-rate
 * are visible, instead of one flat list. Pure over an array of run records
 * ({ suite, passed, failed, skipped, ticket, date, time, ... }); the tool feeds it
 * from meta.readTestRuns. Exported for tests.
 */

/** Group test-run records by suite with a per-suite rollup (newest-first runs). */
export function groupBySuite(runs = []) {
  const bySuite = {};
  for (const r of runs) {
    const s = (r.suite && String(r.suite).trim()) || "(unlabeled)";
    (bySuite[s] = bySuite[s] || []).push(r);
  }
  const suites = Object.keys(bySuite)
    .sort()
    .map((s) => {
      const rs = bySuite[s];
      const latest = rs[rs.length - 1]; // readTestRuns yields oldest→newest on disk
      const totalPassed = rs.reduce((a, r) => a + (r.passed || 0), 0);
      const totalFailed = rs.reduce((a, r) => a + (r.failed || 0), 0);
      const denom = totalPassed + totalFailed;
      return {
        suite: s,
        runs: rs.length,
        latest: latest ? { date: latest.date, time: latest.time || null, passed: latest.passed || 0, failed: latest.failed || 0 } : null,
        passing: latest ? (latest.failed || 0) === 0 : null,
        totalPassed,
        totalFailed,
        passRate: denom ? Math.round((totalPassed / denom) * 1000) / 10 : null,
      };
    });
  const failing = suites.filter((s) => s.passing === false).map((s) => s.suite);
  return { suites, count: suites.length, failing };
}

/**
 * Coverage-by-product rollup (FBMCPF-103): for each product, how many of its
 * tickets have at least one recorded test run (by ticket id) vs none. Pure over
 * tasks (features+bugs) + test-run records. Lists untested tickets per product.
 */
export function coverageByProduct(tasks = [], runs = []) {
  const tested = new Set(
    (Array.isArray(runs) ? runs : [])
      .map((r) => r && r.ticket)
      .filter(Boolean)
      .map((t) => String(t))
  );
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const byProduct = {};
  for (const t of Array.isArray(tasks) ? tasks : []) {
    const p = (t.product && String(t.product).trim()) || "(unassigned)";
    (byProduct[p] = byProduct[p] || []).push(t);
  }
  const products = Object.keys(byProduct).sort().map((p) => {
    const list = byProduct[p];
    const untested = list.filter((t) => !tested.has(String(t.ticketNumber)));
    return {
      product: p,
      total: list.length,
      tested: list.length - untested.length,
      untested: untested.length,
      coveragePct: pct(list.length - untested.length, list.length),
      untestedTickets: untested.map((t) => t.ticketNumber),
    };
  });
  const total = Array.isArray(tasks) ? tasks.length : 0;
  const testedTotal = (Array.isArray(tasks) ? tasks : []).filter((t) => tested.has(String(t.ticketNumber))).length;
  return {
    products,
    overall: { total, tested: testedTotal, untested: total - testedTotal, coveragePct: pct(testedTotal, total) },
  };
}
