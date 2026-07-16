// Plan chaining (FBMCPF-137) — turn a set of freshly-created tickets plus their
// dependency edges into an execution plan of topological "waves" (parallel
// groups). Lives here rather than in budget.js because it is dependency-graph
// logic (kin to storage's wouldCycle/isBlocked), a separate concern from the
// estimator/model-tiering that budget.js owns; storage.js is read-only for this
// ticket so a small dedicated module is the cleanest home.

/**
 * Group `created` tickets into execution waves given `edges`.
 *
 * @param {string[]} created  ticket numbers in creation order.
 * @param {{ticket: string, blockedBy: string[]}[]} edges applied blocker edges.
 * @returns {string[][]} waves — waves[0] is every ticket with no unmet blocker
 *   (safe to run in parallel), waves[1] the next group once those are done, etc.
 *
 * Only blockers that are themselves in `created` count (dangling refs and
 * self-edges are ignored). Cycle-forming edges are rejected upstream and never
 * reach here, but as a safety net any residual unschedulable tickets are
 * emitted together as a final wave so every created ticket appears exactly once.
 */
export function computeWaves(created, edges) {
  const nodes = (created || []).map((t) => String(t));
  const inSet = new Set(nodes);
  const blockers = new Map(nodes.map((n) => [n, new Set()]));
  for (const e of edges || []) {
    const t = String(e && e.ticket);
    if (!inSet.has(t)) continue;
    for (const b of (e.blockedBy || [])) {
      const bb = String(b);
      if (inSet.has(bb) && bb !== t) blockers.get(t).add(bb);
    }
  }
  const waves = [];
  const done = new Set();
  let remaining = nodes.slice();
  while (remaining.length) {
    const ready = remaining.filter((n) => [...blockers.get(n)].every((b) => done.has(b)));
    if (!ready.length) {
      // Safety net for an unexpected residual cycle: schedule the rest together.
      waves.push(remaining.slice());
      break;
    }
    waves.push(ready);
    for (const n of ready) done.add(n);
    remaining = remaining.filter((n) => !done.has(n));
  }
  return waves;
}
