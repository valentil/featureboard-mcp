/**
 * FBMCPF-215: transition gates — per-project preconditions on moving a ticket
 * to Done. Generalizes the two existing hardcoded gates (requireReview in
 * storage.js, requireCommitOnDone in git.js) into a configurable set:
 *
 *   doneGates: {
 *     requireResolvedReview: true,   // no unresolved review comments on the ticket
 *     requirePassingTest:    true,   // a logged test run for the ticket with failed:0
 *     requireWorkLog:        true,   // at least one log_work entry for the ticket
 *   }
 *
 * Each toggle is independent and off by default. approve:true overrides all of
 * them (the same human escape hatch the older gates honour) — enforcement
 * happens in set_status, which checks approve before calling this. Never
 * throws: config/read hiccups resolve to "no gate", mirroring evaluateCommitGate.
 */

import { getProjectConfig, readTestRuns, readWorkLog } from "./metadata.js";
import { unresolvedReviewComments } from "./reviews.js";

/** Evaluate the configured Done gates for a ticket. Returns { refuse, missing, error? }. */
export function evaluateDoneGates(board, project, ticket) {
  let gates;
  try {
    gates = (getProjectConfig(board, project) || {}).doneGates;
  } catch {
    gates = null;
  }
  if (!gates || typeof gates !== "object") return { refuse: false, missing: [] };

  const missing = [];
  const tk = String(ticket).trim();

  if (gates.requireResolvedReview) {
    try {
      const open = unresolvedReviewComments(board, project, tk);
      if (open.length) missing.push(`${open.length} unresolved review comment(s) — resolve_review_comment first`);
    } catch {}
  }

  if (gates.requirePassingTest) {
    try {
      const runs = readTestRuns(board, project).filter((r) => r.ticket === tk);
      const passing = runs.some((r) => (r.failed == null || r.failed === 0) && (r.passed || 0) > 0);
      if (!passing) missing.push("no passing test run logged for this ticket — log_test_run first");
    } catch {}
  }

  if (gates.requireWorkLog) {
    try {
      const hasWork = readWorkLog(board, project).some((e) => e.ticket === tk);
      if (!hasWork) missing.push("no work-log entry for this ticket — log_work first");
    } catch {}
  }

  if (!missing.length) return { refuse: false, missing: [] };
  return {
    refuse: true,
    missing,
    error: `Done gate: ${missing.join("; ")}. Pass approve:true to override (doneGates config).`,
  };
}
