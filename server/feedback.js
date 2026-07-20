/**
 * FeatureBoard v0.4 feedback validator (FBMCPF-140, 8090-Refinery "validate_feedback"
 * parity) — turn raw, unstructured feedback (user notes, review comments, bug
 * reports) into candidate tickets.
 *
 * This module is purely deterministic: NO model/LLM calls happen here.
 * Everything is keyword/regex heuristics, same spirit as pmbridge.js's CSV
 * mapping (the only non-builtin dependency is orchestration.js, itself just
 * more deterministic keyword heuristics — see FBMCPF-159). server/index.js
 * wires this up as the `validate_feedback` tool with two modes:
 *   - dry-run (default): parseFeedback() only, nothing is written to the board.
 *   - apply (apply:true): createFeedbackTickets() bulk-creates via the same
 *     board.addTask() path add_features_bulk/plan_work use, filling in
 *     missing model:/cap: labels via orchestration.js's withOrchestrationLabels
 *     on the way (FBMCPF-159 intake guard).
 */

import { withOrchestrationLabels, applyTriage } from "./orchestration.js";
import { getProjectConfig } from "./metadata.js";

// ---------------------------------------------------------------------------
// Splitting raw feedback into candidate items
// ---------------------------------------------------------------------------

// Matches a leading bullet ("-", "*", "•") or numbered marker ("1.", "2)") and
// captures the remainder of the line.
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;

/**
 * Split raw feedback text into candidate item strings. When the text contains
 * bullet/numbered markers, each marker starts a new item (continuation lines
 * with no marker are appended to the current item; blank lines are ignored).
 * Any preamble before the first marker is dropped (e.g. "Notes from the call:").
 * When no markers are found anywhere, falls back to splitting on blank-line
 * paragraph breaks; if there are none of those either, the whole text is one item.
 */
export function splitFeedbackItems(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/);
  const hasMarkers = lines.some((l) => BULLET_RE.test(l));

  if (!hasMarkers) {
    return raw
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  const items = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(BULLET_RE);
    if (m) {
      if (current !== null) items.push(current.trim());
      current = m[1];
      continue;
    }
    if (current === null) continue; // preamble before the first marker
    const t = line.trim();
    if (t) current += ` ${t}`;
  }
  if (current !== null) items.push(current.trim());
  return items.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Classification heuristics
// ---------------------------------------------------------------------------

const BUG_KEYWORDS = [
  "crash", "crashes", "crashed", "crashing",
  "error", "errors",
  "broken", "break", "breaks",
  "bug", "bugs",
  "fix", "fails", "failed", "failing", "failure",
  "doesn't work", "does not work", "not working", "won't work", "wont work",
  "exception", "freeze", "freezes", "frozen", "hangs", "hanging",
  "regression", "glitch", "stack trace", "500 error",
];

const FEATURE_KEYWORDS = [
  "add", "support for", "would be nice", "would love", "would like",
  "please add", "wish", "could you", "can you add", "enhancement",
  "feature request", "it would be great", "can we get", "suggestion",
  "request", "consider adding",
];

const URGENT_KEYWORDS = ["urgent", "critical", "p0", "p1", "blocker", "showstopper", "asap"];

/** Escape a string for safe use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive whole-word/phrase matches from `keywords` found in `text`. */
function findKeywordMatches(text, keywords) {
  const lower = String(text || "");
  const matches = [];
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRe(kw)}\\b`, "i");
    if (re.test(lower)) matches.push(kw);
  }
  return matches;
}

/**
 * Classify a feedback item as "bug" or "feature" via keyword heuristics.
 * Bug wins ties (a report mentioning both "broken" and "add" usually IS the
 * bug report — "please add error handling so it stops crashing"); with no
 * signal at all, defaults to "feature" (the more common shape of raw notes).
 */
export function classifyFeedback(text) {
  const matchedBugKeywords = findKeywordMatches(text, BUG_KEYWORDS);
  const matchedFeatureKeywords = findKeywordMatches(text, FEATURE_KEYWORDS);
  const type = matchedBugKeywords.length >= 1 && matchedBugKeywords.length >= matchedFeatureKeywords.length
    ? "bug"
    : "feature";
  return { type, matchedBugKeywords, matchedFeatureKeywords };
}

/** Suggest a priority (1 = highest) from explicit urgency cues; null when none found. */
export function suggestPriority(text) {
  const matchedKeywords = findKeywordMatches(text, URGENT_KEYWORDS);
  return { priority: matchedKeywords.length ? 1 : null, matchedKeywords };
}

/**
 * Suggest a product by matching the project's configured product names against
 * the feedback text (whole-word/phrase, case-insensitive). Longer product names
 * are tried first so e.g. "Mobile App" beats a coincidental shorter overlap.
 */
export function suggestProduct(text, products) {
  const list = Array.isArray(products)
    ? products.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim())
    : [];
  const byLength = [...list].sort((a, b) => b.length - a.length);
  for (const p of byLength) {
    const re = new RegExp(`\\b${escapeRe(p.toLowerCase())}\\b`, "i");
    if (re.test(String(text || "").toLowerCase())) return { product: p, matchedKeyword: p };
  }
  return { product: null, matchedKeyword: null };
}

/** Derive a short title from an item's text: its first sentence, capped in length. */
function deriveTitle(text, maxLen = 90) {
  const cleaned = String(text || "").trim();
  const sentenceMatch = cleaned.match(/^(.*?[.!?])(\s|$)/);
  let title = (sentenceMatch ? sentenceMatch[1] : cleaned).trim();
  if (!title) title = cleaned;
  if (title.length > maxLen) {
    const cut = title.slice(0, maxLen).replace(/\s+\S*$/, "");
    title = `${cut || title.slice(0, maxLen)}…`;
  }
  return title;
}

// ---------------------------------------------------------------------------
// Candidate building
// ---------------------------------------------------------------------------

function buildCandidate(itemText, index, products) {
  const description = String(itemText || "").trim();
  const cls = classifyFeedback(description);
  const pr = suggestPriority(description);
  const pd = suggestProduct(description, products);
  return {
    index,
    title: deriveTitle(description),
    description,
    type: cls.type,
    product: pd.product,
    priority: pr.priority,
    signals: {
      bugKeywords: cls.matchedBugKeywords,
      featureKeywords: cls.matchedFeatureKeywords,
      priorityKeywords: pr.matchedKeywords,
      productKeyword: pd.matchedKeyword,
    },
  };
}

/**
 * Parse raw freeform feedback text into candidate tickets. Each candidate's
 * `type`/`product`/`priority` are pre-filled heuristic suggestions — the exact
 * shape createFeedbackTickets() expects, so a caller can edit this array in
 * place and pass it straight back for apply mode.
 */
export function parseFeedback(rawText, products = []) {
  return splitFeedbackItems(rawText).map((item, i) => buildCandidate(item, i, products));
}

// ---------------------------------------------------------------------------
// Bulk creation (apply mode)
// ---------------------------------------------------------------------------

/**
 * Bulk-create candidate tickets via the same board.addTask() path used by
 * add_features_bulk/plan_work. Candidates missing a title are rejected up
 * front so a bad entry never creates a partial batch.
 */
export function createFeedbackTickets(board, project, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  list.forEach((c, i) => {
    if (!c || !String(c.title || "").trim()) throw new Error(`Candidate at index ${i} is missing a title.`);
  });
  return list.map((c) => {
    const type = c.type === "bug" ? "bug" : "feature";
    const fields = {
      title: c.title,
      description: c.description || undefined,
      product: c.product || undefined,
      priority: c.priority != null ? c.priority : undefined,
      labels: Array.isArray(c.labels) && c.labels.length ? c.labels : undefined,
    };
    return board.addTask(project, type, withOrchestrationLabels(type, fields));
  });
}

// ---------------------------------------------------------------------------
// FBMCPF-216: capture_ask — scoped-down Linear Asks. Structure ONE pasted
// external request (a Slack message, forwarded email body, chat snippet) into
// a ticket via the same heuristics as validate_feedback, tagged with its
// source channel (ask:slack, ask:email, …). Deliberately NOT a live intake
// listener — see docs/research/COMPETITOR-CONCEPTS-2026-07.md's rejection of
// daemon-based routers; the orchestrator pastes, this structures.
// ---------------------------------------------------------------------------

/** Sanitize a source channel into an ask:<slug> label. */
export function askLabel(source) {
  const slug = String(source || "external").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "external";
  return `ask:${slug}`;
}

/**
 * Capture a pasted external request as a single ticket. Returns the created
 * ticket plus the heuristic signals so the caller can see why it classified
 * the way it did. `from` (the original requester) is recorded in the
 * description header, not lost.
 */
export function captureAsk(board, project, { source, text, from = null } = {}) {
  if (!text || !String(text).trim()) throw new Error("text is required — paste the request to capture.");
  let products = [];
  try {
    products = getProjectConfig(board, project).products || [];
  } catch {}
  const c = buildCandidate(text, 0, products);
  const header = [`Source: ${source || "external"}`, from ? `From: ${from}` : null].filter(Boolean).join(" · ");
  const fields = {
    title: c.title,
    description: `[${header}] ${c.description.replace(/\s+/g, " ")}`,
    product: c.product || undefined,
    priority: c.priority != null ? c.priority : undefined,
    labels: [askLabel(source)],
  };
  // FBMCPF-233: triage intelligence — when the keyword heuristics left product/
  // priority empty, fill them from similar historical tickets (explicit and
  // keyword-derived values win; history only fills gaps).
  let triage = null;
  try {
    const tri = applyTriage(board.listTasks ? board.listTasks(project, {}) : [], fields);
    Object.assign(fields, tri.fields);
    triage = tri.triage;
  } catch {}
  const created = board.addTask(project, c.type, withOrchestrationLabels(c.type, fields));
  return { ...created, ask: { source: source || "external", from, type: c.type, signals: c.signals, ...(triage ? { triage } : {}) } };
}
