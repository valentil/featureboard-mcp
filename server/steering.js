/**
 * FeatureBoard steering loop (FBMCPF-317).
 *
 * The churn loop's answer to an empty queue. Instead of stopping, the
 * orchestrator calls steer_project and gets back the owner's steering pattern
 * as ordered, executable passes:
 *
 *   1. REVIEW  — adversarially review the Done tickets completed since the
 *                last steering pass (diffs via get_ticket_diff semantic:true,
 *                churn drift via churn_reconcile); file bugs for real defects.
 *   2. TIGHTEN — cleanup-scan findings, strengthen findings, hygiene debt:
 *                candidate fixes, not homework — file/fix what's real.
 *   3. RESEARCH— standard-aware research toward the project's `goal`
 *                (polished standards get the competitor/layout/whitepaper/UX
 *                question set), grounded in rag_search prior art; file the
 *                next wave of features tied to the goal.
 *   4. RESUME  — next_task. The loop continues.
 *
 * Steering state persists per project in <projectDir>/steering.json
 * ({ lastSteeringAt, reviewedTickets }) so pass 1 never re-reviews the same
 * work — the same set-once hygiene as standards. Deterministic, zero model
 * calls: this module assembles instructions and evidence; the agent does the
 * thinking.
 */

import fs from "node:fs";
import path from "node:path";
import { getProjectConfig } from "./metadata.js";
import { resolveStandard, researchProfile } from "./standards.js";
import { scanBoardCleanup } from "./cleanup.js";

const STATE_FILE = "steering.json";
const MAX_REVIEW_TICKETS = 8; // one wave's worth — older Done work was either reviewed or is water under the bridge
const MAX_FINDINGS = 10;

function statePath(board, project) {
  return path.join(board.projectDir(project), STATE_FILE);
}

export function readSteeringState(board, project) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(board, project), "utf8"));
    return {
      lastSteeringAt: typeof s.lastSteeringAt === "string" ? s.lastSteeringAt : null,
      reviewedTickets: Array.isArray(s.reviewedTickets) ? s.reviewedTickets : [],
    };
  } catch {
    return { lastSteeringAt: null, reviewedTickets: [] };
  }
}

export function writeSteeringState(board, project, state) {
  const p = statePath(board, project);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, p);
  return state;
}

/** Done tickets not yet reviewed by a steering pass, newest first, capped. */
export function unreviewedDone(board, project, state) {
  const reviewed = new Set(state.reviewedTickets);
  return board
    .listTasks(project, {})
    .filter((t) => t.status === "Done" && !reviewed.has(t.ticketNumber))
    .sort((a, b) => String(b.completionDate || "").localeCompare(String(a.completionDate || "")))
    .slice(0, MAX_REVIEW_TICKETS)
    .map((t) => ({
      ticket: t.ticketNumber,
      title: t.title,
      completed: t.completionDate || null,
      completionSummary: t.completionSummary || null,
    }));
}

/**
 * Assemble the steering packet. Pure read + one state write (marks the review
 * candidates as claimed so the next call moves forward, mirroring lock-once).
 * `now` injectable for tests.
 */
export function steerProject(board, project, { now = new Date(), dryRun = false } = {}) {
  const cfg = getProjectConfig(board, project);
  const std = resolveStandard(cfg.standard);
  const profile = researchProfile(std);
  const state = readSteeringState(board, project);

  // ---- pass 1: review evidence ----
  const review = unreviewedDone(board, project, state);

  // ---- pass 2: tighten evidence (best-effort; a failing scan never blocks steering) ----
  let cleanup = [];
  try {
    const scan = scanBoardCleanup(board, project, { now });
    cleanup = (scan.findings || scan.results || []).slice(0, MAX_FINDINGS);
  } catch { cleanup = []; }
  let strengthen = [];
  try {
    if (cfg.codeLocation) {
      const raw = JSON.parse(fs.readFileSync(path.join(cfg.codeLocation, "strengthen_findings.json"), "utf8"));
      strengthen = (Array.isArray(raw) ? raw : raw.findings || []).slice(0, MAX_FINDINGS);
    }
  } catch { strengthen = []; }

  // ---- pass 3: research questions toward the goal ----
  const goal = (cfg.goal || "").trim() || null;
  const researchQuestions = [
    goal
      ? `Which 2-3 features would move "${goal}" furthest right now? Ground each in prior art (rag_search) before proposing.`
      : "No project goal is set — ask the user for the project's north star ONCE, then store it with set_project_config goal:\"...\" so future steering aims at it.",
    "What did the last wave teach us (completion summaries below) that should change the plan?",
    ...profile.extraQuestions,
  ];

  const open = board.listTasks(project, {}).filter((t) => t.status !== "Done");
  const passes = [
    {
      pass: "review",
      instruction:
        review.length
          ? `Adversarially review these ${review.length} recently-completed tickets — get_ticket_diff (semantic:true) per ticket, churn_reconcile for drift outliers. You are hunting for real defects (wrong matcher fields, stale claims, red tests, silent behavior changes), not style. File log_bug for each REAL defect; fix trivial ones inline under a filed ticket. Do not re-review anything outside this list.`
          : "Nothing new to review since the last steering pass — skip.",
      tickets: review,
    },
    {
      pass: "tighten",
      instruction:
        cleanup.length || strengthen.length
          ? "Triage these hygiene findings: real issues become tickets (or inline fixes under a ticket); noise gets dismissed with dismiss_cleanup_finding so it never resurfaces."
          : "No hygiene findings — skip.",
      cleanup,
      strengthen,
    },
    {
      pass: "research",
      instruction:
        `Research toward the goal at the project's standard ("${std.level}"${std.mandate ? `, mandate: ${std.mandate}` : ""}). ` +
        "Answer the questions below (rag_search for prior art first; web where the standard calls for competitors/whitepapers/UX guides), then file the next wave: add_feature per proposal, each description citing what the research found and how it serves the goal. Cap the wave at what one churn run can finish.",
      goal,
      standard: std.level,
      questions: researchQuestions,
    },
    {
      pass: "resume",
      instruction: "Call next_task and keep churning. Steering is a pit stop, not a destination.",
    },
  ];

  if (!dryRun) {
    writeSteeringState(board, project, {
      lastSteeringAt: now.toISOString(),
      reviewedTickets: [...new Set([...state.reviewedTickets, ...review.map((r) => r.ticket)])].slice(-500),
    });
  }

  const actionable = review.length + cleanup.length + strengthen.length > 0 || !!goal;
  return {
    project,
    steeredAt: now.toISOString(),
    lastSteeringAt: state.lastSteeringAt,
    goal,
    standard: { level: std.level, locked: !!std.locked, ...(std.mandate ? { mandate: std.mandate } : {}) },
    openTickets: open.length,
    actionable,
    stopHint:
      actionable
        ? null
        : "Nothing actionable this pass. If the NEXT steering pass is also empty, report to the user and stop — do not spin.",
    passes,
  };
}
