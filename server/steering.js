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
      // FBMCPB-45: consecutive passes whose ONLY actionable content was
      // open-ended goal research (no concrete review/tighten work). Bounds the
      // otherwise-infinite research loop so the documented "two empty passes →
      // stop" valve can actually fire.
      goalOnlyStreak: Number.isInteger(s.goalOnlyStreak) && s.goalOnlyStreak >= 0 ? s.goalOnlyStreak : 0,
    };
  } catch {
    return { lastSteeringAt: null, reviewedTickets: [], goalOnlyStreak: 0 };
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
      instruction: goal
        ? `Research toward the goal at the project's standard ("${std.level}"${std.mandate ? `, mandate: ${std.mandate}` : ""}). ` +
          "Answer the questions below (rag_search for prior art first; web where the standard calls for competitors/whitepapers/UX guides), then file the next wave: add_feature per proposal, each description citing what the research found and how it serves the goal. Cap the wave at what one churn run can finish."
        : "NO PROJECT GOAL IS SET — do this FIRST: ask the user for the project's north star ONCE, then store it with set_project_config goal:\"...\". Steering research has no direction to aim at until a goal exists, so don't invent a wave of features as if directed; set the goal, then re-run steer_project.",
      goal,
      goalMissing: !goal,
      standard: std.level,
      questions: researchQuestions,
    },
    {
      pass: "resume",
      instruction: "Call next_task and keep churning. Steering is a pit stop, not a destination.",
    },
  ];

  // FBMCPB-45: `actionable` must be able to become false so the documented
  // "two consecutive non-actionable passes → stop" valve can fire. Concrete
  // work (unreviewed Done tickets, cleanup/strengthen findings) is always
  // actionable and resets the streak. An open-ended goal, on its own, is only
  // good for ONE research wave: after that we require NEW concrete work (which
  // surfaces as fresh review items once tickets reach Done) before steering is
  // actionable again. Without this, any project with a goal set — which the
  // research pass actively encourages — could never self-terminate.
  const concrete = review.length + cleanup.length + strengthen.length > 0;
  let goalOnlyStreak = state.goalOnlyStreak;
  if (concrete) {
    goalOnlyStreak = 0;
  } else if (goal) {
    goalOnlyStreak = state.goalOnlyStreak + 1;
  } else {
    goalOnlyStreak = 0;
  }
  // First goal-only pass (streak === 1) emits the research wave and stays
  // actionable; subsequent consecutive goal-only passes are non-actionable.
  const actionable = concrete || (!!goal && goalOnlyStreak <= 1);

  if (!dryRun) {
    writeSteeringState(board, project, {
      lastSteeringAt: now.toISOString(),
      reviewedTickets: [...new Set([...state.reviewedTickets, ...review.map((r) => r.ticket)])].slice(-500),
      goalOnlyStreak,
    });
  }

  return {
    project,
    steeredAt: now.toISOString(),
    lastSteeringAt: state.lastSteeringAt,
    goal,
    goalMissing: !goal, // FBMCPB-44: surfaced so a goalless steer prompts the user to set one
    standard: { level: std.level, locked: !!std.locked, ...(std.mandate ? { mandate: std.mandate } : {}) },
    openTickets: open.length,
    actionable,
    stopHint:
      actionable
        ? null
        : "Nothing actionable this pass (no new review/tighten work; the goal's research wave is already out). If the NEXT steering pass is also empty, report to the user and stop — do not spin.",
    passes,
  };
}

/**
 * FBMCPF-319: read-only observability into the steering loop for a project —
 * without running (or mutating) a pass. Surfaces the persisted steering.json
 * state (lastSteeringAt, how many Done tickets have been claimed/reviewed, and
 * the goalOnlyStreak that gates the auto-stop) alongside a live snapshot: goal /
 * goalMissing, open-ticket count, how many Done tickets are still unreviewed,
 * and the tickets FILED SINCE the last steering pass (a proxy for "what the last
 * pass produced", since steering itself doesn't author tickets — the agent
 * does). Pure read; never writes steering.json.
 */
export function getSteeringStatus(board, project) {
  const cfg = getProjectConfig(board, project);
  const state = readSteeringState(board, project);
  const goal = (cfg.goal || "").trim() || null;

  const tasks = board.listTasks(project, {});
  const reviewed = new Set(state.reviewedTickets);
  const unreviewedDoneCount = tasks.filter((t) => t.status === "Done" && !reviewed.has(t.ticketNumber)).length;
  const openTickets = tasks.filter((t) => t.status !== "Done").length;

  // Items filed on/after the last steering pass (local calendar day compare).
  const sinceDay = state.lastSteeringAt ? state.lastSteeringAt.slice(0, 10) : null;
  const filedSinceLastSteering = sinceDay
    ? tasks
        .filter((t) => t.createdDate && t.createdDate >= sinceDay)
        .map((t) => ({ ticket: t.ticketNumber, title: t.title, status: t.status, created: t.createdDate }))
    : [];

  return {
    project,
    goal,
    goalMissing: !goal,
    lastSteeringAt: state.lastSteeringAt,
    everSteered: !!state.lastSteeringAt,
    reviewedCount: state.reviewedTickets.length,
    reviewedTickets: state.reviewedTickets.slice(-50), // most recent, capped for context
    goalOnlyStreak: state.goalOnlyStreak,              // consecutive goal-only (non-actionable-bound) passes
    unreviewedDoneCount,
    openTickets,
    filedSinceLastSteering,
  };
}
