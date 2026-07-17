/**
 * FeatureBoard per-ticket review comments (FBMCPF-135) — PR-style review feedback
 * stored on a ticket so the next work packet can surface it and the agent acts on it.
 *
 * Comments live in a per-project log, one JSON object per line:
 *   <projectDir>/review_comments.jsonl
 *
 * Each record:
 *   {"id":"RC-1","ticket":"FBF-9","comment":"tighten the loop","author":"lewis",
 *    "file":"server/x.js","line":42,"resolved":false,
 *    "createdAt":"2026-07-16T12:00:00.000Z","resolvedAt":null}
 *
 * add appends a line; resolve rewrites the file with the one record flipped
 * (atomic rename). Kept intentionally free of metadata.js / events.js imports so
 * that metadata.js (getWorkPacket) can import THIS module without creating an
 * import cycle — events.js already imports metadata.js, so reviews.js staying
 * dependency-light keeps the graph acyclic. The audit-trail hook (appendEvent)
 * lives in the index.js tool layer instead.
 */

import fs from "node:fs";
import path from "node:path";

export const REVIEW_COMMENTS_FILE = "review_comments.jsonl";

function reviewsPath(board, project) {
  return path.join(board.projectDir(project), REVIEW_COMMENTS_FILE);
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/** Read + parse a project's review comments. Tolerates a missing file and bad lines. */
function readAll(board, project) {
  let content;
  try {
    content = fs.readFileSync(reviewsPath(board, project), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const c = JSON.parse(line);
      if (c && c.id && c.ticket) out.push(c);
    } catch {
      // skip a corrupted line rather than failing the whole read
    }
  }
  return out;
}

function writeAll(board, project, comments) {
  const p = reviewsPath(board, project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = comments.map((c) => JSON.stringify(c)).join("\n");
  atomicWrite(p, comments.length ? body + "\n" : "");
}

/** Next sequential RC-<n> id, one higher than the largest existing numeric id. */
function nextId(comments) {
  let max = 0;
  for (const c of comments) {
    const n = parseInt(String(c.id).replace(/\D+/g, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `RC-${max + 1}`;
}

/**
 * Add a review comment to a ticket. Returns the created record. `author`, `file`
 * and `line` are optional (PR-style anchoring). Throws on a missing ticket/comment.
 */
export function addReviewComment(board, project, ticket, opts = {}) {
  const { comment, author = null, file = null, line = null } = opts;
  if (!ticket || !String(ticket).trim()) throw new Error("ticket is required");
  if (!comment || !String(comment).trim()) throw new Error("comment text is required");
  const comments = readAll(board, project);
  const lineNum = line != null && String(line).trim() !== "" && Number.isFinite(Number(line)) ? Number(line) : null;
  const rec = {
    id: nextId(comments),
    ticket: String(ticket).trim(),
    comment: String(comment).trim(),
    author: author != null && String(author).trim() ? String(author).trim() : null,
    file: file != null && String(file).trim() ? String(file).trim() : null,
    line: lineNum,
    resolved: false,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  comments.push(rec);
  writeAll(board, project, comments);
  return rec;
}

/**
 * List review comments, newest-appended last. Optionally scope to one ticket and
 * hide resolved ones.
 */
export function listReviewComments(board, project, ticket = null, opts = {}) {
  const { includeResolved = true } = opts;
  let out = readAll(board, project);
  if (ticket) out = out.filter((c) => c.ticket === ticket);
  if (!includeResolved) out = out.filter((c) => !c.resolved);
  return out;
}

/** Unresolved review comments for one ticket — the set the next work packet must surface. */
export function unresolvedReviewComments(board, project, ticket) {
  return readAll(board, project).filter((c) => c.ticket === ticket && !c.resolved);
}

/** Ticket numbers that currently carry at least one unresolved review comment. */
export function ticketsWithUnresolvedReviews(board, project) {
  const set = new Set();
  for (const c of readAll(board, project)) {
    if (!c.resolved) set.add(c.ticket);
  }
  return set;
}

/** Resolve a review comment by id (idempotent). Throws when the id is unknown. */
export function resolveReviewComment(board, project, id) {
  const comments = readAll(board, project);
  const rec = comments.find((c) => c.id === id);
  if (!rec) throw new Error(`Review comment ${id} not found.`);
  if (!rec.resolved) {
    rec.resolved = true;
    rec.resolvedAt = new Date().toISOString();
    writeAll(board, project, comments);
  }
  return rec;
}
