/**
 * FBMCPF-220: semantic diff view — deterministic post-processing for
 * get_ticket_diff (semantic:true). Inspired by Linear Diffs / Guided Reviews:
 * strips whitespace/formatting-only hunks, orders files semantically
 * (core code → tests → docs/config), flags mechanical renames, and emits a
 * ready-to-use review-summary prompt for the orchestrator.
 *
 * Pure heuristics only — no LLM calls, no I/O, no git invocations. Everything
 * works on the unified-diff text getTicketDiff already produced, so the view
 * is assistive by construction: the raw diff stays the source of truth and
 * the emitted prompt says so explicitly.
 */

export const SEMANTIC_DISCLAIMER =
  "Assistive view (deterministic heuristics, no LLM) — verify against the raw diff before acting on it.";

/** Review order: behaviour first, then its tests, then supporting docs/config. */
export const CATEGORY_ORDER = ["core", "tests", "docs/config"];

/**
 * Classify a repo-relative path into core code / tests / docs-and-config.
 * Deterministic, path-only — never inspects content.
 */
export function classifyFile(p) {
  const norm = String(p || "").replace(/\\/g, "/").toLowerCase();
  const base = norm.split("/").pop() || "";
  if (
    /(^|\/)(tests?|__tests__|spec)\//.test(norm) ||
    /\.(test|spec)\.[^.]+$/.test(base)
  ) {
    return "tests";
  }
  if (
    /(^|\/)(docs?|documentation)\//.test(norm) ||
    /(^|\/)\.github\//.test(norm) ||
    /\.(md|markdown|rst|adoc|txt)$/.test(base) ||
    /\.(json|ya?ml|toml|ini|cfg|conf|lock|properties)$/.test(base) ||
    /^(readme|license|changelog|contributing|authors|notice)(\.|$)/.test(base) ||
    base.startsWith(".")
  ) {
    return "docs/config";
  }
  return "core";
}

/**
 * Parse `git show`-style unified diff text into per-file entries:
 * { path, oldPath, newPath, renameFrom, renameTo, similarity, binary,
 *   hunks: [{ header, added: [lines], removed: [lines] }] }.
 * Tolerant of quoted paths and of truncated tails (parses what is there).
 */
export function parseUnifiedDiff(diffText) {
  const files = [];
  if (!diffText) return files;
  let cur = null;
  let hunk = null;
  for (const line of String(diffText).split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = {
        path: null, oldPath: null, newPath: null,
        renameFrom: null, renameTo: null, similarity: null,
        binary: false, hunks: [],
      };
      const m = line.match(/^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/);
      if (m) { cur.oldPath = m[1]; cur.newPath = m[2]; cur.path = m[2]; }
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("similarity index ")) {
      const m = line.match(/(\d+)%/);
      if (m) cur.similarity = Number(m[1]);
      continue;
    }
    if (line.startsWith("rename from ")) { cur.renameFrom = line.slice(12); continue; }
    if (line.startsWith("rename to ")) { cur.renameTo = line.slice(10); cur.path = cur.renameTo; continue; }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { cur.binary = true; continue; }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) {
      hunk = { header: line, added: [], removed: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) hunk.added.push(line.slice(1));
    else if (line.startsWith("-")) hunk.removed.push(line.slice(1));
    // context lines ignored
  }
  return files;
}

const stripWs = (s) => s.replace(/\s+/g, "");

/**
 * A hunk is formatting-only when its removed and added sides are identical
 * once ALL whitespace is stripped: re-indents, blank-line shuffles, line
 * wrapping/joining. A hunk with no +/- lines at all is not "noise", it's
 * nothing — treated as not formatting-only so it simply contributes zero.
 */
export function isFormattingOnlyHunk(hunk) {
  if (!hunk || (!hunk.added.length && !hunk.removed.length)) return false;
  return stripWs(hunk.removed.join("")) === stripWs(hunk.added.join(""));
}

/**
 * Build the semantic view over getTicketDiff's commits array. Aggregates
 * per-file across commits, drops formatting-only hunks from the counts,
 * flags mechanical renames (100% similarity or rename with no hunks), and
 * orders files core → tests → docs/config (churn-desc within category).
 * Deterministic; safe on truncated diffs (sets partial:true).
 */
export function buildSemanticView(commits = []) {
  const byPath = new Map();
  let partial = false;
  for (const c of commits || []) {
    if (!c || typeof c.diff !== "string") continue;
    if (c.diffTruncated) partial = true;
    for (const f of parseUnifiedDiff(c.diff)) {
      const key = f.path || f.newPath || f.oldPath || "(unknown)";
      let entry = byPath.get(key);
      if (!entry) {
        entry = {
          path: key, category: classifyFile(key),
          additions: 0, deletions: 0, keptHunks: 0, strippedHunks: 0,
          rename: null, binary: false, commits: [],
        };
        byPath.set(key, entry);
      }
      if (f.binary) entry.binary = true;
      if (f.renameFrom && f.renameTo) {
        entry.rename = {
          from: f.renameFrom,
          to: f.renameTo,
          similarity: f.similarity,
          mechanical: f.similarity === 100 || f.hunks.length === 0,
        };
      }
      for (const h of f.hunks) {
        if (isFormattingOnlyHunk(h)) { entry.strippedHunks++; continue; }
        entry.keptHunks++;
        entry.additions += h.added.length;
        entry.deletions += h.removed.length;
      }
      if (c.shortHash && !entry.commits.includes(c.shortHash)) entry.commits.push(c.shortHash);
    }
  }

  const files = [...byPath.values()].sort((a, b) => {
    const cat = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (cat !== 0) return cat;
    const churn = (b.additions + b.deletions) - (a.additions + a.deletions);
    if (churn !== 0) return churn;
    return a.path.localeCompare(b.path);
  });

  const byCategory = {};
  for (const cat of CATEGORY_ORDER) byCategory[cat] = files.filter((f) => f.category === cat).length;
  const totals = {
    filesChanged: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    keptHunks: files.reduce((n, f) => n + f.keptHunks, 0),
    strippedHunks: files.reduce((n, f) => n + f.strippedHunks, 0),
    mechanicalRenames: files.filter((f) => f.rename && f.rename.mechanical).length,
    byCategory,
  };

  return {
    order: CATEGORY_ORDER,
    files,
    totals,
    partial,
    disclaimer: SEMANTIC_DISCLAIMER,
    reviewPrompt: buildReviewPrompt(files, totals, partial),
  };
}

/**
 * Deterministic review-summary prompt for the orchestrator: walk the diff in
 * semantic order, noise pre-stripped, with the assistive disclaimer baked in.
 */
export function buildReviewPrompt(files, totals, partial) {
  const lines = [];
  lines.push("Review the changes for this ticket in the order below (core code first, then tests, then docs/config).");
  for (const cat of CATEGORY_ORDER) {
    const group = files.filter((f) => f.category === cat);
    if (!group.length) continue;
    lines.push("");
    lines.push(`${cat.toUpperCase()} (${group.length} file${group.length === 1 ? "" : "s"}):`);
    for (const f of group) {
      const bits = [`+${f.additions}/-${f.deletions}`];
      if (f.strippedHunks) bits.push(`${f.strippedHunks} formatting-only hunk${f.strippedHunks === 1 ? "" : "s"} stripped`);
      if (f.rename) {
        bits.push(f.rename.mechanical
          ? `mechanical rename from ${f.rename.from}`
          : `renamed from ${f.rename.from} (with edits)`);
      }
      if (f.binary) bits.push("binary");
      lines.push(`- ${f.path} (${bits.join("; ")})`);
    }
  }
  lines.push("");
  lines.push(`Focus on behaviour: ${totals.strippedHunks} formatting-only hunk(s) and ${totals.mechanicalRenames} mechanical rename(s) were set aside as noise.`);
  lines.push("For each core file check: the change matches the ticket's intent, edge cases, error handling, and that the tests cover the new behaviour.");
  if (partial) lines.push("NOTE: one or more diffs were truncated by the byte cap — this view is incomplete; raise maxBytes for the full picture.");
  lines.push(`IMPORTANT: ${SEMANTIC_DISCLAIMER}`);
  return lines.join("\n");
}
