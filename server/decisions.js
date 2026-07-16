/**
 * FeatureBoard v0.3 architecture decision records (FBMCPF-139, Foundry-style ADR log).
 *
 * Decisions live per project as a single append-only markdown log at:
 *
 *   <projectDir>/decisions.md
 *
 * with entries appended in the form:
 *
 *   ## ADR-<n>: <title>
 *   *<YYYY-MM-DD>*
 *
 *   **Context:** ...
 *
 *   **Decision:** ...
 *
 *   **Consequences:** ...
 *
 *   **Tickets:** FBF-1, FBB-2
 *
 * IMPORTANT (no import cycle): this module imports ONLY node builtins, mirroring
 * requirements.js — the Board and its projectDir are passed in through arguments,
 * so metadata.js may safely import THIS module for work-packet injection without
 * creating a require/import cycle.
 */

import fs from "node:fs";
import path from "node:path";

// Local copies of the pad-file helpers (same shape as metadata.js/requirements.js).
function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function atomicWrite(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const DECISIONS_FILE = "decisions.md";

/** Absolute path to a project's ADR log. */
function decisionsPath(board, project) {
  return path.join(board.projectDir(project), DECISIONS_FILE);
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEntry(n, title, date, { context = "", decision = "", consequences = "", tickets = [] }) {
  return (
    `## ADR-${n}: ${title}\n` +
    `*${date}*\n\n` +
    `**Context:** ${context}\n\n` +
    `**Decision:** ${decision}\n\n` +
    `**Consequences:** ${consequences}\n\n` +
    `**Tickets:** ${(tickets || []).join(", ")}\n`
  );
}

// ---------------------------------------------------------------------------
// Parsing (tolerant of hand-edited files)
// ---------------------------------------------------------------------------

/**
 * Split a decisions.md body into per-entry chunks keyed off `## ADR-<n>: <title>`
 * headers. Any text before the first header, or between headers that isn't part
 * of an entry's body (e.g. stray hand-written notes), is simply ignored — it
 * never breaks parsing of the entries that follow.
 */
function splitEntries(content) {
  const entries = [];
  const re = /^##\s+ADR-(\d+):\s*(.*)$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(content))) {
    heads.push({ n: parseInt(m[1], 10), title: m[2].trim(), start: m.index, bodyStart: re.lastIndex });
  }
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].start : content.length;
    entries.push({ n: cur.n, title: cur.title, body: content.slice(cur.bodyStart, end) });
  }
  return entries;
}

/** Pull a single `**Field:** ...` block out of an entry body (tolerant of missing fields). */
function field(body, name) {
  const re = new RegExp(`\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*[A-Za-z ]+:\\*\\*|$)`, "i");
  const m = body.match(re);
  return m ? m[1].trim() : "";
}

function parseEntryBody(body) {
  const dateM = body.match(/^\s*\*(\d{4}-\d{2}-\d{2})\*\s*$/m);
  const date = dateM ? dateM[1] : null;

  const context = field(body, "Context");
  const decision = field(body, "Decision");
  const consequences = field(body, "Consequences");
  const ticketsRaw = field(body, "Tickets");
  const tickets = ticketsRaw
    ? ticketsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return { date, context, decision, consequences, tickets };
}

/**
 * Parse a project's decisions.md into a structured array, or [] when the file
 * is absent or empty. Unknown/hand-edited text between entries is ignored;
 * malformed or missing fields within a recognized `## ADR-<n>` entry simply
 * come back empty rather than throwing.
 */
export function listDecisions(board, project) {
  const raw = readFileSafe(decisionsPath(board, project));
  if (raw == null) return [];
  return splitEntries(raw).map((e) => {
    const parsed = parseEntryBody(e.body);
    return {
      id: `ADR-${e.n}`,
      n: e.n,
      title: e.title,
      date: parsed.date,
      context: parsed.context,
      decision: parsed.decision,
      consequences: parsed.consequences,
      tickets: parsed.tickets,
    };
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Append a new decision record to the project's ADR log. Auto-numbers ADR-<n>
 * as one past the highest existing n (so gaps from hand-deleted entries never
 * collide), validates title + decision are present, and writes atomically.
 * Returns the created record.
 */
export function addDecision(board, project, spec = {}) {
  const title = String(spec.title || "").trim();
  const decision = String(spec.decision || "").trim();
  if (!title) throw new Error("A decision title is required.");
  if (!decision) throw new Error("A decision (the actual choice made) is required.");

  const context = String(spec.context || "").trim();
  const consequences = String(spec.consequences || "").trim();
  const tickets = Array.isArray(spec.tickets)
    ? spec.tickets.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const date = spec.date || todayISO();

  const existing = listDecisions(board, project);
  const n = existing.reduce((max, d) => Math.max(max, d.n), 0) + 1;

  ensureDir(board.projectDir(project));
  const p = decisionsPath(board, project);
  const prior = readFileSafe(p) || "";
  const entry = renderEntry(n, title, date, { context, decision, consequences, tickets });
  const body = prior.trim() ? prior.replace(/\s*$/, "") + "\n\n" + entry : entry;
  atomicWrite(p, body);

  return { id: `ADR-${n}`, n, title, date, context, decision, consequences, tickets };
}

/**
 * Decisions relevant to a ticket: either the ticket id is listed in the
 * `**Tickets:**` field, or the ticket id is mentioned anywhere in the entry's
 * title/context/decision/consequences text (e.g. a decision written before the
 * Tickets field was filled in, or one that references a ticket in prose).
 */
export function decisionsForTicket(board, project, ticket) {
  const t = String(ticket || "").trim();
  if (!t) return [];
  const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, "i");
  return listDecisions(board, project).filter(
    (d) =>
      d.tickets.some((x) => x.toLowerCase() === t.toLowerCase()) ||
      re.test(d.title) ||
      re.test(d.context) ||
      re.test(d.decision) ||
      re.test(d.consequences)
  );
}
