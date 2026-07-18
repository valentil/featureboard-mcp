/**
 * FeatureBoard board deep-clean & de-duplication (FBMCPF-81).
 *
 * Ports deep-clean-queue + data-cleanup: a read-only scan that finds likely
 * duplicate tickets (by normalized title similarity) and stale/placeholder ones,
 * proposes a removal set, and a *guarded* prune that only deletes ticket ids you
 * pass and defaults to a dry run. Nothing here deletes on its own.
 *
 * Pure helpers (normalizeTitle, titleSimilarity, findDuplicateGroups, findStale)
 * are exported for unit testing; scanBoardCleanup/pruneBoard take a Board.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findUnlabeledTickets } from "./orchestration.js";
import { readWorkLog, getProjectConfig } from "./metadata.js";

const STOPWORDS = new Set(["the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "add", "support"]);
const PLACEHOLDER_RE = /^(test|todo|tbd|tba|asdf|qwer|xxx+|placeholder|untitled|foo|bar|temp|delete ?me|wip)\b/i;

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content tokens of a title (normalized, stopwords removed). */
export function titleTokens(s) {
  return normalizeTitle(s)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Similarity of two titles in [0,1]: 1 if their normalized forms are equal,
 * otherwise the Jaccard overlap of their content-token sets.
 */
export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na && !nb) return 1;
  if (na === nb) return 1;
  const sa = new Set(titleTokens(a));
  const sb = new Set(titleTokens(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

const STATUS_RANK = { Done: 3, "In Progress": 2, Todo: 1 };
function ticketNum(id) {
  const m = String(id || "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Group tickets whose titles are similar at/above `threshold` (union-find over
 * pairwise similarity). Each group nominates a keeper — the most-progressed
 * ticket (Done > In Progress > Todo), tie-broken by the lowest (oldest) number —
 * and lists the rest as removal candidates. Returns only groups with >1 member.
 */
export function findDuplicateGroups(tasks, { threshold = 0.7 } = {}) {
  const n = tasks.length;
  const parent = tasks.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (titleSimilarity(tasks[i].title, tasks[j].title) >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(tasks[i]);
  }
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = members.slice().sort((a, b) => {
      const ra = STATUS_RANK[a.status] || 0;
      const rb = STATUS_RANK[b.status] || 0;
      if (ra !== rb) return rb - ra; // most progressed first
      return ticketNum(a.ticketNumber) - ticketNum(b.ticketNumber); // oldest first
    });
    const keeper = sorted[0];
    const candidates = sorted.slice(1);
    out.push({
      keep: { ticket: keeper.ticketNumber, title: keeper.title, status: keeper.status },
      removeCandidates: candidates.map((c) => ({ ticket: c.ticketNumber, title: c.title, status: c.status })),
      size: members.length,
    });
  }
  return out;
}

function ageDays(createdDate, now) {
  if (!createdDate) return null;
  const then = new Date(createdDate + "T00:00:00Z").getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86400000);
}

/**
 * Flag stale / placeholder tickets: still-open (Todo) tickets older than
 * `staleDays`, and any open ticket whose title looks like a placeholder or is
 * trivially short with no description. Done tickets are never flagged.
 */
export function findStale(tasks, { staleDays = 30, now = new Date() } = {}) {
  const out = [];
  for (const t of tasks) {
    if (t.status === "Done") continue;
    const age = ageDays(t.createdDate, now);
    const reasons = [];
    const title = String(t.title || "").trim();
    if (PLACEHOLDER_RE.test(title)) reasons.push("placeholder title");
    if (title.replace(/[^a-z0-9]/gi, "").length < 3 && !t.description) reasons.push("empty/trivial");
    if (age != null && age >= staleDays && t.status === "Todo") reasons.push(`stale: ${age}d in Todo`);
    if (reasons.length) out.push({ ticket: t.ticketNumber, title: t.title, status: t.status, ageDays: age, reasons });
  }
  return out.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
}

// ---------------------------------------------------------------------------
// FBMCPF-198: priority-scaled SLA / stale escalation.
//
// Beyond the generic "old Todo / placeholder" staleness above, these are
// priority-aware service-level checks: a high-priority ticket sitting In
// Progress with no recent work-log activity, or a ticket languishing in Todo,
// breaches its SLA sooner the higher its priority. Thresholds are per-priority
// (keyed by the numeric priority; `default` covers unprioritized/other values)
// and overridable per project via the slaThresholds config key. Pure: callers
// pass the current time and a ticket->last-activity-date map so it stays
// deterministic and testable.
// ---------------------------------------------------------------------------

export const DEFAULT_SLA_THRESHOLDS = {
  // days In Progress with no work-log activity before we escalate
  inProgressDays: { 0: 1, 1: 1, 2: 3, 3: 5, default: 7 },
  // days sitting in Todo before we call it stale
  todoDays: { 0: 1, 1: 3, 2: 7, 3: 14, default: 30 },
};

/** Merge a project's slaThresholds config over the defaults (per-map shallow merge). */
export function resolveSlaThresholds(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  return {
    inProgressDays: { ...DEFAULT_SLA_THRESHOLDS.inProgressDays, ...(c.inProgressDays || {}) },
    todoDays: { ...DEFAULT_SLA_THRESHOLDS.todoDays, ...(c.todoDays || {}) },
  };
}

function thresholdFor(map, priority) {
  if (!map) return null;
  if (priority != null && map[priority] != null) return Number(map[priority]);
  return map.default != null ? Number(map.default) : null;
}

/**
 * Flag SLA breaches among open tickets. In Progress tickets breach when the days
 * since their last activity (last work-log date, else createdDate) reach their
 * priority's inProgressDays threshold (severity "escalate"). Todo tickets breach
 * when their age reaches todoDays (severity "stale"). Done/Review are ignored.
 * `lastActivity` maps ticketNumber -> YYYY-MM-DD of last work-log event.
 */
export function findSlaBreaches(tasks, { slaThresholds = DEFAULT_SLA_THRESHOLDS, lastActivity = {}, now = new Date() } = {}) {
  const ip = slaThresholds.inProgressDays || DEFAULT_SLA_THRESHOLDS.inProgressDays;
  const td = slaThresholds.todoDays || DEFAULT_SLA_THRESHOLDS.todoDays;
  const out = [];
  for (const t of tasks) {
    const priority = t.priority != null ? t.priority : null;
    const plabel = priority != null ? `P${priority}` : "unprioritized";
    if (t.status === "In Progress") {
      const thr = thresholdFor(ip, priority);
      if (thr == null) continue;
      const last = lastActivity[t.ticketNumber] || t.createdDate || null;
      const age = ageDays(last, now);
      if (age != null && age >= thr) {
        out.push({ ticket: t.ticketNumber, title: t.title, status: t.status, priority, ageDays: age, threshold: thr, severity: "escalate", reason: `In Progress ${age}d with no activity (SLA ${thr}d for ${plabel})` });
      }
    } else if (t.status === "Todo") {
      const thr = thresholdFor(td, priority);
      if (thr == null) continue;
      const age = ageDays(t.createdDate, now);
      if (age != null && age >= thr) {
        out.push({ ticket: t.ticketNumber, title: t.title, status: t.status, priority, ageDays: age, threshold: thr, severity: "stale", reason: `Todo ${age}d (SLA ${thr}d for ${plabel})` });
      }
    }
  }
  return out.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
}

// ---------------------------------------------------------------------------
// FBMCPF-204: dismiss cleanup findings without deleting anything.
//
// A finding can otherwise only be acted on (prune) or ignored forever, so it
// keeps reappearing every scan. Dismissals are recorded in an append-only jsonl
// sidecar and suppress a finding on future scans. Finding ids are STABLE — a
// short hash of type+ticket — so the same finding stays dismissed across
// rescans (until the ticket changes category and produces a different finding).
// ---------------------------------------------------------------------------

const DISMISSALS_FILE = ".featureboard.cleanup_dismissals.jsonl";

/** Stable id for a finding: short sha1 of "<type>:<ticket>". */
export function findingId(type, ticket) {
  return crypto.createHash("sha1").update(`${type}:${ticket || ""}`).digest("hex").slice(0, 12);
}

function dismissalsPath(board, project) {
  return path.join(board.projectDir(project), DISMISSALS_FILE);
}

/** Map of dismissed finding id -> record. Tolerates a missing/corrupt file. */
export function readDismissals(board, project) {
  const map = new Map();
  let content = null;
  try { content = fs.readFileSync(dismissalsPath(board, project), "utf8"); } catch { content = null; }
  if (!content) return map;
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { const rec = JSON.parse(t); if (rec && rec.id) map.set(rec.id, rec); } catch { /* skip bad line */ }
  }
  return map;
}

/** Record a dismissal (append-only). Returns the stored record. */
export function dismissCleanupFinding(board, project, { findingId: id, reason } = {}) {
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  const fid = String(id || "").trim();
  if (!fid) throw new Error("findingId is required (copy it from a scan_board_cleanup finding's id).");
  const rec = { id: fid, reason: reason ? String(reason) : null, date: new Date().toISOString() };
  const p = dismissalsPath(board, project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
  return { ...rec, project };
}

/**
 * Read-only scan: duplicate groups + stale/placeholder tickets, plus a suggested
 * removal set (the duplicate removal-candidates) for a follow-up pruneBoard call.
 */
export function scanBoardCleanup(board, project, { staleDays = 30, similarity = 0.7, now = new Date() } = {}) {
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  const tasks = board.listTasks(project, {});
  const duplicates = findDuplicateGroups(tasks, { threshold: similarity });
  const stale = findStale(tasks, { staleDays, now });
  // FBMCPF-159: intake orchestration guard — open tickets missing a model:/cap:
  // label never got a sub-model orchestration decision at intake. Surfaced here
  // (read-only, same as duplicates/stale) rather than as a separate tool.
  const unlabeled = findUnlabeledTickets(tasks);
  // FBMCPF-198: priority-scaled SLA breaches. Last-activity per ticket comes from
  // the work log (latest entry date); slaThresholds is project-overridable.
  const lastActivity = {};
  for (const e of readWorkLog(board, project)) {
    if (e.ticket && e.date) lastActivity[e.ticket] = e.date; // log is oldest-first, so last wins
  }
  let slaCfg = {};
  try { slaCfg = (getProjectConfig(board, project) || {}).slaThresholds || {}; } catch { slaCfg = {}; }
  const slaThresholds = resolveSlaThresholds(slaCfg);
  const slaBreaches = findSlaBreaches(tasks, { slaThresholds, lastActivity, now });

  // FBMCPF-204: annotate every finding with its stable id and drop the ones the
  // user has dismissed; dismissedCount reports how many were suppressed.
  const dismissed = readDismissals(board, project);
  let dismissedCount = 0;
  const annotateKeep = (type, items, ticketOf) => {
    const kept = [];
    for (const it of items) {
      const id = findingId(type, ticketOf(it));
      if (dismissed.has(id)) { dismissedCount += 1; continue; }
      kept.push({ ...it, id });
    }
    return kept;
  };
  const keptDuplicates = annotateKeep("duplicate", duplicates, (g) => g.keep.ticket);
  const keptStale = annotateKeep("stale", stale, (x) => x.ticket);
  const keptUnlabeled = annotateKeep("unlabeled", unlabeled, (x) => x.ticket);
  const keptSla = annotateKeep("sla", slaBreaches, (x) => x.ticket);

  const suggestedRemovals = keptDuplicates.flatMap((g) => g.removeCandidates.map((c) => c.ticket));
  return {
    project,
    total: tasks.length,
    duplicateGroups: keptDuplicates.length,
    duplicates: keptDuplicates,
    staleCount: keptStale.length,
    stale: keptStale,
    unlabeledCount: keptUnlabeled.length,
    unlabeled: keptUnlabeled,
    slaBreachCount: keptSla.length,
    slaBreaches: keptSla,
    dismissedCount,
    suggestedRemovals,
    note: suggestedRemovals.length
      ? `Review the groups, then prune_board with the ticket ids to remove (dry run by default; pass confirm:true to delete).`
      : "No duplicate removal candidates found.",
  };
}

/**
 * Guarded prune: deletes ONLY the ticket ids provided, and only when confirm is
 * true (otherwise returns a dry-run preview). Skips ids that don't exist.
 */
export function pruneBoard(board, project, tickets = [], { confirm = false } = {}) {
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  if (!Array.isArray(tickets) || !tickets.length) throw new Error("provide the ticket ids to prune");
  const resolved = [];
  const missing = [];
  for (const id of tickets) {
    const t = board.getTask(project, id);
    if (t) resolved.push({ ticket: id, title: t.title });
    else missing.push(id);
  }
  if (!confirm) {
    return { project, dryRun: true, wouldDelete: resolved, missing, count: resolved.length, note: "Pass confirm:true to delete these." };
  }
  const deleted = [];
  for (const r of resolved) {
    board.deleteTask(project, r.ticket);
    deleted.push(r.ticket);
  }
  return { project, dryRun: false, deleted, missing, count: deleted.length };
}


// --- Test-suite deep-clean (FBMCPF-104) -------------------------------------

function normalizeContent(c) {
  return String(c || "").replace(/\s+/g, " ").trim();
}

/** True when every assertion in a test file is the generated TODO placeholder. */
export function isStubOnly(content) {
  const c = String(content || "");
  const tests = (c.match(/\btest\s*\(/g) || []).length;
  const asserts = (c.match(/assert\./g) || []).length;
  const todos = (c.match(/assert\.ok\(\s*true\s*,\s*["'`]TODO/gi) || []).length;
  return tests >= 1 && asserts >= 1 && todos === asserts;
}

/**
 * Read-only scan of a set of test files ({ name, content }) for likely cruft:
 *  - duplicates: byte-identical (whitespace-normalized) content, grouped;
 *  - stale: filename embeds a ticket id (e.g. FBF-9-*.test.js) not in knownTickets;
 *  - emptyStubs: only TODO-placeholder assertions (never filled in).
 * Returns a suggested removal set. Deletes nothing.
 */
export function scanTestFiles(files = [], { knownTickets = [], ticketRe = /\b([A-Z]{2,10}-\d+)\b/ } = {}) {
  const known = new Set((knownTickets || []).map((t) => String(t)));
  const byContent = new Map();
  for (const f of files) {
    const key = normalizeContent(f.content);
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(f.name);
  }
  const duplicates = [];
  for (const names of byContent.values()) {
    if (names.length > 1) {
      const sorted = names.slice().sort();
      duplicates.push({ files: sorted, keep: sorted[0], removeCandidates: sorted.slice(1) });
    }
  }
  const stale = [];
  for (const f of files) {
    const m = String(f.name).match(ticketRe);
    if (m && !known.has(m[1])) stale.push({ file: f.name, ticket: m[1], reason: "ticket no longer on the board" });
  }
  const emptyStubs = [];
  for (const f of files) {
    if (isStubOnly(f.content)) emptyStubs.push({ file: f.name, reason: "only TODO-placeholder assertions" });
  }
  const suggestedRemovals = [...new Set([
    ...duplicates.flatMap((d) => d.removeCandidates),
    ...stale.map((s) => s.file),
  ])];
  return {
    files: files.length,
    duplicateGroups: duplicates.length,
    duplicates,
    staleCount: stale.length,
    stale,
    emptyStubCount: emptyStubs.length,
    emptyStubs,
    suggestedRemovals,
    note: suggestedRemovals.length
      ? "Review, then delete the suggested files yourself (emptyStubs are flagged separately — fill them in rather than delete)."
      : "No duplicate or stale test files found.",
  };
}
