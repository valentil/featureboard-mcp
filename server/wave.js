/**
 * FBMCPF-361: wave dispatch — the plural of next_task.
 *
 * next_task serves ONE ticket. An orchestrator that wants every sub-agent lane
 * full therefore pays N sequential round-trips and still has to guess which of
 * those tickets collide on files: under-parallelize (safe, slow) or fan out and
 * hope. This module answers the whole question in one call — the full
 * dispatchable set, already partitioned into lanes that are mutually
 * file-disjoint, so every lane can run as a concurrent sub-agent and the
 * tickets INSIDE a lane are the ones that must run serially.
 *
 * Composes with steer_project rather than duplicating it: an empty wave is NOT
 * a stop. `stopCondition.met` is. steer_project remains the thing that refills
 * an empty queue; this module just reports whether that loop has gone quiet.
 *
 * DEPENDENCY STYLE: takes a `deps` bag rather than importing metadata/events/
 * storage directly. metadata.js ← storage.js ← board plumbing is already a
 * tangled import graph (see routing.js's "DELIBERATELY ZERO IMPORTS" note), and
 * the registration site in register/board.js already holds every helper this
 * needs in its ctx. Injecting them also makes the lane grouper unit-testable
 * without a board on disk.
 */

import fs from "node:fs";
import path from "node:path";
import { isDispatchable } from "./routing.js";

/** Directories never worth indexing for ticket file-scope matching. */
export const WAVE_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next",
  ".cache", "vendor", "__pycache__", ".venv", "venv", ".idea", ".vscode",
  "releases", "validation-logs",
]);

/** Extensions worth treating as "code a ticket could collide on". */
const CODE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".css", ".html",
  ".py", ".rs", ".go", ".java", ".rb", ".sh", ".sql", ".md", ".yml", ".yaml",
]);

/**
 * Cheap file index of a code root: relative POSIX paths only, NO content reads.
 * explorer.js's codeFileMap reads every file to count lines — far too expensive
 * to run on the dispatch path, and it returns only oversized split candidates
 * anyway, not the full list we need to match ticket text against.
 */
export function indexCodeFiles(root, { maxDepth = 6, limit = 20000 } = {}) {
  const files = new Set();
  const basenames = new Map();
  if (!root) return { root: null, files, basenames, truncated: false };
  let base;
  try {
    base = path.resolve(root);
    const st = fs.statSync(base);
    if (!st.isDirectory()) return { root: null, files, basenames, truncated: false };
  } catch {
    return { root: null, files, basenames, truncated: false };
  }

  let truncated = false;
  const walk = (abs, depth) => {
    if (depth < 0 || truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (e.isDirectory()) {
        if (WAVE_IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(path.join(abs, e.name), depth - 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!CODE_EXTS.has(ext)) continue;
        const rel = path.relative(base, path.join(abs, e.name)).split(path.sep).join("/");
        files.add(rel);
        const bn = e.name.toLowerCase();
        if (!basenames.has(bn)) basenames.set(bn, []);
        basenames.get(bn).push(rel);
        if (files.size >= limit) { truncated = true; return; }
      }
    }
  };
  walk(base, maxDepth);
  return { root: base, files, basenames, truncated };
}

// Path-ish tokens in free text. Broader than metadata.js's PATH_RE (which only
// catches absolute paths) because ticket descriptions overwhelmingly name files
// the way humans do: "server/wave.js", "wave.js", "skills/featureboarding/SKILL.md".
const TOKEN_RE = /[A-Za-z0-9_.\-]+(?:[\/\\][A-Za-z0-9_.\-]+)*\.[A-Za-z0-9]{1,5}/g;
/** Explicit opt-in label: `files:server/wave.js,server/index.js`. */
const FILES_LABEL_RE = /^files:(.+)$/i;

/** Normalize a raw token to a repo-relative POSIX path, or null. */
function normalizeToken(tok, indexRoot) {
  let s = String(tok || "").trim().replace(/\\/g, "/");
  if (!s) return null;
  if (indexRoot) {
    const r = indexRoot.replace(/\\/g, "/");
    if (s.toLowerCase().startsWith(r.toLowerCase() + "/")) s = s.slice(r.length + 1);
  }
  s = s.replace(/^\.\//, "").replace(/^\/+/, "");
  return s || null;
}

/**
 * Resolve a ticket's file scope against the code index.
 *
 * Three bases, most trustworthy first:
 *   "label"    — an explicit files: label, always honoured verbatim
 *   "text"     — paths named in title/description/work-log that EXIST in the index
 *   "unknown"  — nothing resolved; the ticket gets its own lane and a flag,
 *                because "no files named" means "scope unknown", never "no
 *                conflicts". Callers isolate these with a worktree.
 */
export function ticketFileScope(task, index, { extraText = "" } = {}) {
  const out = new Set();
  const rootRel = index && index.root ? index.root : null;

  for (const l of (task && task.labels) || []) {
    const m = String(l).match(FILES_LABEL_RE);
    if (!m) continue;
    for (const raw of m[1].split(",")) {
      const n = normalizeToken(raw, rootRel);
      if (n) out.add(n);
    }
  }
  if (out.size) return { files: [...out].sort(), basis: "label" };

  const text = `${(task && task.title) || ""}\n${(task && task.description) || ""}\n${extraText || ""}`;
  const ambiguous = [];
  for (const tok of text.match(TOKEN_RE) || []) {
    const n = normalizeToken(tok, rootRel);
    if (!n) continue;
    if (index.files.has(n)) { out.add(n); continue; }
    // Bare filename: accept only when it names exactly one file in the repo.
    // Two files called index.js tell us nothing about which one this ticket
    // touches, so an ambiguous basename is treated as no signal at all.
    if (!n.includes("/")) {
      const hits = index.basenames.get(n.toLowerCase());
      if (hits && hits.length === 1) out.add(hits[0]);
      else if (hits && hits.length > 1) ambiguous.push(n);
    }
  }
  if (out.size) {
    const r = { files: [...out].sort(), basis: "text" };
    if (ambiguous.length) r.ambiguous = [...new Set(ambiguous)].sort();
    return r;
  }
  return { files: [], basis: "unknown" };
}

/**
 * Partition entries into file-disjoint lanes (union-find over shared files).
 *
 * Entry: { ticket, files, order }. Two entries sharing ANY file land in the
 * same lane; lanes are therefore mutually disjoint by construction and safe to
 * run concurrently. Entries with an empty file set are each their own lane —
 * unknown scope is isolated, never merged into someone else's lane.
 *
 * Lanes are ordered by their best member's `order` (the caller's queue rank),
 * and members within a lane keep that same order, so a lane is a serial
 * to-do list and lane 0 always holds the highest-priority open ticket.
 */
export function groupLanes(entries) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const e of entries) parent.set(e.ticket, e.ticket);

  const owner = new Map(); // file -> first ticket claiming it
  for (const e of entries) {
    for (const f of e.files || []) {
      if (owner.has(f)) union(e.ticket, owner.get(f));
      else owner.set(f, e.ticket);
    }
  }

  const byRoot = new Map();
  for (const e of entries) {
    const r = find(e.ticket);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(e);
  }

  const lanes = [...byRoot.values()];
  for (const l of lanes) l.sort((a, b) => a.order - b.order);
  lanes.sort((a, b) => a[0].order - b[0].order);
  return lanes;
}

/** Queue ordering next_task uses: In Progress first, then priority, due, id. */
function queueSort(open) {
  const rank = (t) => (t.status === "In Progress" ? 0 : 1);
  const prio = (t) => (t.priority != null ? t.priority : Infinity);
  const dueVal = (t) => (t.dueDate ? Date.parse(t.dueDate) || Infinity : Infinity);
  const num = (t) => parseInt((t.ticketNumber || "").replace(/\D+/g, ""), 10) || 0;
  return open.slice().sort((a, b) => rank(a) - rank(b) || prio(a) - prio(b) || dueVal(a) - dueVal(b) || num(a) - num(b));
}

/**
 * Build the wave.
 *
 * deps: { getProjectConfig, buildDispatchDirective, isBlocked,
 *         ticketsWithUnresolvedReviews, lastDispatchForTicket,
 *         getSteeringStatus, uncollectedChecks, compactView, blend }
 * Every dep is optional — missing ones degrade to a safe default rather than
 * throwing, so a partially-wired caller still gets lanes.
 */
export function buildWave(board, project, deps = {}, opts = {}) {
  const {
    type = "all",
    maxLanes = null,
    occupied = [],
    laneDepth = null,
  } = opts;

  const cfg = deps.getProjectConfig ? deps.getProjectConfig(board, project) : {};
  const etaHintsOn = cfg && cfg.etaHints !== false;
  const occupiedSet = new Set(occupied.map((t) => String(t).toUpperCase()));

  const openAll = board.listTasks(project, { type }).filter((t) => t.status !== "Done");

  let reviewBacklog = new Set();
  if (deps.ticketsWithUnresolvedReviews) {
    try { reviewBacklog = deps.ticketsWithUnresolvedReviews(board, project); } catch { reviewBacklog = new Set(); }
  }
  const isBlocked = deps.isBlocked || (() => false);
  const awaitingReview = (t) => t.status === "Review" && !reviewBacklog.has(t.ticketNumber);

  const blockedSkipped = openAll.filter((t) => isBlocked(board, project, t)).length;
  const reviewSkipped = openAll.filter((t) => !isBlocked(board, project, t) && awaitingReview(t)).length;
  const servable = queueSort(openAll.filter((t) => !isBlocked(board, project, t) && !awaitingReview(t)));

  const index = indexCodeFiles(cfg && cfg.codeLocation ? cfg.codeLocation : null);

  const parallelEntries = [];
  const sequential = [];
  const inFlight = [];

  servable.forEach((t, i) => {
    const dispatch = deps.buildDispatchDirective
      ? deps.buildDispatchDirective(t, { blocked: false, etaHints: etaHintsOn, blend: deps.blend || null })
      : { model: "sonnet", cap: null, effort: null, subAgent: true, parallelizable: true, instruction: "" };

    const scope = ticketFileScope(t, index);
    const view = deps.compactView ? deps.compactView(t) : { ticketNumber: t.ticketNumber, title: t.title, status: t.status, type: t.type };
    const entry = {
      ...view,
      ticket: t.ticketNumber,
      dispatch,
      files: scope.files,
      fileScope: scope.basis,
      ...(scope.ambiguous ? { ambiguousFileHints: scope.ambiguous } : {}),
      order: i,
    };

    if (occupiedSet.has(String(t.ticketNumber).toUpperCase())) {
      let d = null;
      if (deps.lastDispatchForTicket) {
        try { d = deps.lastDispatchForTicket(board, project, t.ticketNumber); } catch { d = null; }
      }
      inFlight.push({ ...entry, lastDispatch: d });
      return;
    }
    // routing.js is the single source of truth for what may leave the
    // orchestrator. fable never appears in lanes[], by construction.
    if (!isDispatchable(dispatch.model)) sequential.push(entry);
    else parallelEntries.push(entry);
  });

  // A lane holding an in-flight ticket is BUSY: its remaining tickets share
  // files with something a sub-agent is editing right now, so handing them out
  // would defeat the whole point of the partition. Merge in-flight entries for
  // grouping, then drop any lane they landed in from the dispatchable set.
  const grouped = groupLanes(parallelEntries.concat(inFlight.map((e) => ({ ...e }))));
  const inFlightIds = new Set(inFlight.map((e) => e.ticket));

  const freeLanes = [];
  const busyLanes = [];
  for (const lane of grouped) {
    const blockedByRunning = lane.some((e) => inFlightIds.has(e.ticket));
    const dispatchable = lane.filter((e) => !inFlightIds.has(e.ticket));
    const shaped = {
      lane: 0,
      tickets: dispatchable.map(({ order, ...rest }) => rest),
      files: [...new Set(lane.flatMap((e) => e.files || []))].sort(),
      serial: dispatchable.length > 1,
      ...(dispatchable.some((e) => e.fileScope === "unknown")
        ? { isolate: "Unknown file scope — give this lane its own worktree (create_worktree)." }
        : {}),
    };
    if (blockedByRunning) {
      if (dispatchable.length) busyLanes.push({ ...shaped, waitingOn: lane.filter((e) => inFlightIds.has(e.ticket)).map((e) => e.ticket) });
    } else if (dispatchable.length) {
      freeLanes.push(shaped);
    }
  }

  let lanes = freeLanes;
  let lanesWithheld = 0;
  if (maxLanes != null && maxLanes >= 0 && lanes.length > maxLanes) {
    lanesWithheld = lanes.length - maxLanes;
    lanes = lanes.slice(0, maxLanes);
  }
  if (laneDepth != null && laneDepth > 0) {
    lanes = lanes.map((l) => (l.tickets.length > laneDepth ? { ...l, tickets: l.tickets.slice(0, laneDepth), truncated: true } : l));
  }
  lanes.forEach((l, i) => { l.lane = i; });

  // --- stop condition ------------------------------------------------------
  // Deliberately NOT "the wave came back empty". steer_project exists precisely
  // because an empty queue is a refill event, not an ending. `met` is true only
  // when there is nothing open, nothing running, no uncollected check results,
  // and steering itself has gone quiet.
  let uncollectedChecks = null;
  if (deps.uncollectedChecks) {
    try { uncollectedChecks = deps.uncollectedChecks(board, project); } catch { uncollectedChecks = null; }
  }
  let steering = null;
  if (deps.getSteeringStatus) {
    try { steering = deps.getSteeringStatus(board, project); } catch { steering = null; }
  }

  const openInScope = servable.length;
  const uncollected = Array.isArray(uncollectedChecks) ? uncollectedChecks.length : (uncollectedChecks || 0);
  const steeringIdle = steering ? (steering.goalOnlyStreak || 0) >= 2 : false;
  const unreviewedDone = steering ? steering.unreviewedDoneCount || 0 : 0;

  const reasons = [];
  if (openInScope) reasons.push(`${openInScope} open ticket(s) still servable`);
  if (inFlight.length) reasons.push(`${inFlight.length} ticket(s) still running`);
  if (uncollected) reasons.push(`${uncollected} uncollected check run(s) — call get_check_results`);
  if (unreviewedDone) reasons.push(`${unreviewedDone} Done ticket(s) not yet reviewed — call steer_project`);
  if (!steeringIdle && !openInScope && !inFlight.length)
    reasons.push("steering has not gone idle — call steer_project before stopping");

  const stopCondition = {
    met: reasons.length === 0,
    openInScope,
    inFlight: inFlight.length,
    blockedSkipped,
    reviewSkipped,
    uncollectedChecks: uncollected,
    unreviewedDone,
    steeringPassesIdle: steering ? steering.goalOnlyStreak || 0 : null,
    reasons,
    instruction: reasons.length
      ? "NOT done. Fill every free lane, refill on each completion, and re-call next_wave. An empty wave is a steer_project event, not a stop."
      : "Stop condition met: queue clear, nothing running, checks collected, steering idle. Report to the user.",
  };

  return {
    project,
    lanes,
    laneCount: lanes.length,
    ...(lanesWithheld ? { lanesWithheld } : {}),
    sequential: sequential.map(({ order, ...rest }) => rest),
    inFlight: inFlight.map(({ order, ...rest }) => rest),
    ...(busyLanes.length ? { busyLanes: busyLanes.map((l, i) => ({ ...l, lane: `busy-${i}` })) } : {}),
    codeIndex: {
      root: index.root,
      fileCount: index.files.size,
      ...(index.truncated ? { truncated: true } : {}),
    },
    stopCondition,
    instruction:
      `Fill ALL ${lanes.length} lane(s) NOW as concurrent sub-agents — no lane sits idle while a dispatchable ticket exists. ` +
      "Tickets WITHIN a lane share files and must run serially; lanes are file-disjoint and safe to run at once. " +
      "For each ticket: set_status In Progress, get_work_packet, dispatch at its dispatch.model, then record_dispatch. " +
      "When a lane finishes, re-call next_wave with occupied=[still-running tickets] and refill it immediately. " +
      (sequential.length ? `${sequential.length} orchestrator-only ticket(s) in sequential[] run inline, one at a time. ` : "") +
      "Stop only when stopCondition.met is true.",
  };
}
