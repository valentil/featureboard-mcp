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

/**
 * Read-only scan: duplicate groups + stale/placeholder tickets, plus a suggested
 * removal set (the duplicate removal-candidates) for a follow-up pruneBoard call.
 */
export function scanBoardCleanup(board, project, { staleDays = 30, similarity = 0.7, now = new Date() } = {}) {
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  const tasks = board.listTasks(project, {});
  const duplicates = findDuplicateGroups(tasks, { threshold: similarity });
  const stale = findStale(tasks, { staleDays, now });
  const suggestedRemovals = duplicates.flatMap((g) => g.removeCandidates.map((c) => c.ticket));
  return {
    project,
    total: tasks.length,
    duplicateGroups: duplicates.length,
    duplicates,
    staleCount: stale.length,
    stale,
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
