// Sprint support (FBMCPF-120): first-class sprints on top of the existing
// `sprint:<name>` label convention used by the board artifact.
//
// - The sprint registry (name + optional start/end dates + goal) is persisted
//   in the MCP-managed project config under `sprints`.
// - Ticket membership stays a `sprint:<name>` label, so boards written with
//   the older label-only convention keep working, and any client that can set
//   labels can move tickets between sprints.

import * as meta from "./metadata.js";

export const SPRINT_LABEL_RE = /^sprint:(.+)$/i;

/** Sprint name carried by a task's labels, or null. */
export function sprintOfTask(t) {
  for (const l of t.labels || []) {
    const m = String(l).match(SPRINT_LABEL_RE);
    if (m) return m[1].trim();
  }
  return null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validName(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Sprint name is required.");
  if (/[:,[\]]/.test(n)) throw new Error("Sprint names cannot contain ':', ',', '[' or ']'.");
  return n;
}

function readRegistry(board, project) {
  const cfg = meta.getProjectConfig(board, project);
  return Array.isArray(cfg.sprints) ? cfg.sprints.filter((s) => s && s.name) : [];
}

/** Create a sprint, or update dates/goal on an existing one (name match is case-insensitive). */
export function createSprint(board, project, { name, start = null, end = null, goal = null } = {}) {
  const n = validName(name);
  for (const d of [start, end]) {
    if (d != null && d !== "" && !DATE_RE.test(String(d))) {
      throw new Error(`Invalid date "${d}" — use YYYY-MM-DD.`);
    }
  }
  if (start && end && end < start) throw new Error("Sprint end date is before its start date.");
  const sprints = readRegistry(board, project);
  let s = sprints.find((x) => x.name.toLowerCase() === n.toLowerCase());
  if (s) {
    if (start != null) s.start = start || null;
    if (end != null) s.end = end || null;
    if (goal != null) s.goal = goal || null;
  } else {
    s = { name: n, start: start || null, end: end || null, ...(goal ? { goal } : {}) };
    sprints.push(s);
  }
  meta.setProjectConfig(board, project, { sprints });
  return s;
}

/** All sprints (registry + label-only ones), each with progress counts. */
export function listSprints(board, project) {
  const tasks = board.listTasks(project, {});
  const sprints = readRegistry(board, project).map((s) => ({ ...s }));
  const byKey = new Map(sprints.map((s) => [s.name.toLowerCase(), s]));
  for (const t of tasks) {
    const n = sprintOfTask(t);
    if (n && !byKey.has(n.toLowerCase())) {
      const s = { name: n, start: null, end: null };
      sprints.push(s);
      byKey.set(n.toLowerCase(), s);
    }
  }
  for (const s of sprints) {
    const mine = tasks.filter((t) => (sprintOfTask(t) || "").toLowerCase() === s.name.toLowerCase());
    s.total = mine.length;
    s.done = mine.filter((t) => t.status === "Done").length;
    s.inProgress = mine.filter((t) => t.status === "In Progress").length;
    s.todo = mine.filter((t) => t.status === "Todo").length;
    s.complete = s.total > 0 && s.done === s.total;
  }
  const backlogOpen = tasks.filter((t) => !sprintOfTask(t) && t.status !== "Done").length;
  return { sprints, backlogOpen };
}

/** Assign one or more tickets to a sprint (replaces any sprint label); sprint=null clears. */
export function assignSprint(board, project, tickets, sprint) {
  const name = sprint == null || sprint === "" ? null : validName(sprint);
  if (name) createSprint(board, project, { name }); // auto-register in the config
  const list = Array.isArray(tickets) ? tickets : [tickets];
  const updated = [];
  for (const ticket of list) {
    const t = board.getTask(project, ticket);
    const labels = (t.labels || []).filter((l) => !SPRINT_LABEL_RE.test(String(l)));
    if (name) labels.push(`sprint:${name}`);
    const u = board.updateTask(project, ticket, { labels }, { source: "assign_sprint" }); // FBMCPF-142
    updated.push({ ticket: u.ticketNumber, labels: u.labels });
  }
  return { sprint: name, updated };
}

// priority-aware rollover on close_sprint (FBMCPF-197) ----------------------
//
// When a sprint closes with open (non-Done) tickets, close_sprint's
// rolloverMode decides what happens to them:
//   'review' (default) — planRollover() only: a categorized plan, nothing moves.
//   'auto'              — applyRollover() mutates the board per the plan.
//   'off'               — legacy behavior, neither function is called.
//
// Priority buckets (ticket.priority; null/undefined counts as unprioritized):
//   P0/P1 (0 or 1)      -> autoRoll: retag sprint:<old> -> sprint:<nextSprint>
//                          when a nextSprint name is given; otherwise the
//                          ticket stays put and gets a `rollover-pending` label.
//   P2/P3 (2 or 3)      -> flagged: gets a `rollover-candidate` label for a
//                          human to triage; sprint label is left alone.
//   P4+ / unprioritized -> dropped: sprint label removed (back to backlog).

export const ROLLOVER_CANDIDATE_LABEL = "rollover-candidate";
export const ROLLOVER_PENDING_LABEL = "rollover-pending";

function priorityBucket(priority) {
  if (priority == null) return "drop";
  if (priority <= 1) return "auto";
  if (priority <= 3) return "flag";
  return "drop";
}

function openSprintTickets(board, project, sprintName) {
  const name = String(sprintName || "").trim();
  return board
    .listTasks(project, {})
    .filter((t) => (sprintOfTask(t) || "").toLowerCase() === name.toLowerCase() && t.status !== "Done");
}

/**
 * Categorize a sprint's still-open tickets into rollover buckets by priority.
 * Pure read — never mutates. Used both to preview ('review' mode) and as the
 * basis for applyRollover ('auto' mode).
 */
export function planRollover(board, project, sprintName, { nextSprint = null } = {}) {
  const open = openSprintTickets(board, project, sprintName);
  const buckets = { auto: [], flag: [], drop: [] };
  for (const t of open) {
    buckets[priorityBucket(t.priority)].push({
      ticket: t.ticketNumber,
      title: t.title,
      priority: t.priority != null ? t.priority : null,
      status: t.status,
    });
  }
  return {
    sprint: sprintName,
    nextSprint: nextSprint || null,
    autoRoll: buckets.auto,
    flagged: buckets.flag,
    dropped: buckets.drop,
  };
}

function addLabel(board, project, ticket, label) {
  const t = board.getTask(project, ticket);
  if ((t.labels || []).includes(label)) return t;
  return board.updateTask(project, ticket, { labels: [...(t.labels || []), label] }, { source: "close_sprint_rollover" });
}

/**
 * Apply planRollover()'s plan to the board: retag P0/P1 tickets into
 * nextSprint (or flag them rollover-pending if no nextSprint was given),
 * label P2/P3 tickets rollover-candidate, and drop the sprint label from
 * P4+/unprioritized tickets back to the backlog.
 */
export function applyRollover(board, project, sprintName, { nextSprint = null } = {}) {
  const plan = planRollover(board, project, sprintName, { nextSprint });

  const autoRolled = plan.autoRoll.map((item) => {
    if (nextSprint) {
      const r = assignSprint(board, project, [item.ticket], nextSprint);
      return { ...r.updated[0], sprint: nextSprint };
    }
    const u = addLabel(board, project, item.ticket, ROLLOVER_PENDING_LABEL);
    return { ticket: u.ticketNumber, sprint: sprintName, labels: u.labels, flag: ROLLOVER_PENDING_LABEL };
  });

  const flaggedUpdated = plan.flagged.map((item) => {
    const u = addLabel(board, project, item.ticket, ROLLOVER_CANDIDATE_LABEL);
    return { ticket: u.ticketNumber, labels: u.labels };
  });

  const droppedUpdated = plan.dropped.map((item) => {
    const r = assignSprint(board, project, [item.ticket], null);
    return r.updated[0];
  });

  return { ...plan, applied: true, autoRolled, flaggedUpdated, droppedUpdated };
}
