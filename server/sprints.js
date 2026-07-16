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
    const u = board.updateTask(project, ticket, { labels });
    updated.push({ ticket: u.ticketNumber, labels: u.labels });
  }
  return { sprint: name, updated };
}
