/**
 * FeatureBoard v0.3 requirements refinement (FBMCPF-138, 8090-Refinery style).
 *
 * The server STORES and SERVES structured requirements; DRAFTING the content is
 * the agent's job at runtime (via the `refine` prompt). Requirements live per
 * ticket as a markdown pad file at:
 *
 *   <projectDir>/requirements/<TICKET>.md
 *
 * with a fixed section layout:
 *
 *   # <TICKET> — requirements
 *
 *   ## Intent
 *   ...
 *
 *   ## Assumptions
 *   - ...
 *
 *   ## Acceptance criteria
 *   - [ ] ...
 *
 *   ## Open questions
 *   - ...
 *
 * IMPORTANT (no import cycle): this module imports ONLY node builtins. It never
 * imports metadata.js — the Board and its projectDir are passed in through
 * arguments, so metadata.js may safely import THIS module for work-packet
 * injection without creating a require/import cycle.
 */

import fs from "node:fs";
import path from "node:path";

// Local copies of the pad-file helpers (same shape as metadata.js/storage.js).
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

/** Directory that holds a project's requirements pad files. */
function requirementsDir(board, project) {
  return path.join(board.projectDir(project), "requirements");
}
/** Absolute path to one ticket's requirements pad file. */
function requirementsPath(board, project, ticket) {
  return path.join(requirementsDir(board, project), `${ticket}.md`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function bulletList(items) {
  const arr = (items || []).map((s) => String(s).trim()).filter(Boolean);
  return arr.length ? arr.map((s) => `- ${s}`).join("\n") : "";
}

function renderRequirements(ticket, { intent = "", assumptions = [], acceptanceCriteria = [], openQuestions = [] }) {
  const acLines = (acceptanceCriteria || [])
    .map((c) => (typeof c === "string" ? { text: c, done: false } : c))
    .map((c) => `- [${c && c.done ? "x" : " "}] ${String(c && c.text != null ? c.text : c).trim()}`)
    .filter((l) => l.replace(/^- \[[ x]\]\s*/, "").length > 0);

  return (
    `# ${ticket} — requirements\n\n` +
    `## Intent\n${String(intent || "").trim()}\n\n` +
    `## Assumptions\n${bulletList(assumptions)}\n\n` +
    `## Acceptance criteria\n${acLines.join("\n")}\n\n` +
    `## Open questions\n${bulletList(openQuestions)}\n`
  );
}

// ---------------------------------------------------------------------------
// Parsing (tolerant of hand-edited files)
// ---------------------------------------------------------------------------

/**
 * Split a markdown body into a list of { heading, lines } sections keyed by the
 * `## Heading` lines. Content before the first `##` (e.g. the `#` title) is kept
 * under a null heading so nothing is lost.
 */
function splitSections(content) {
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(/^##\s+(.*)$/);
    if (m) {
      sections.push(current);
      current = { heading: m[1].trim(), lines: [] };
    } else {
      current.lines.push(raw);
    }
  }
  sections.push(current);
  return sections;
}

function bullets(lines) {
  return lines
    .map((l) => l.match(/^\s*[-*]\s+(.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter(Boolean);
}

function parseAcceptance(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    out.push({ text, done: m[1].toLowerCase() === "x" });
  }
  return out;
}

/**
 * Parse a requirements pad file into a structured object, or null when absent.
 * Known sections (Intent/Assumptions/Acceptance criteria/Open questions) are
 * extracted; the full original text is always returned as `raw`, so any
 * hand-added unknown sections are preserved for the caller.
 */
export function getRequirements(board, project, ticket) {
  const raw = readFileSafe(requirementsPath(board, project, ticket));
  if (raw == null) return null;

  const result = { intent: "", assumptions: [], acceptanceCriteria: [], openQuestions: [], raw };
  for (const section of splitSections(raw)) {
    if (!section.heading) continue;
    const key = section.heading.toLowerCase();
    if (key === "intent") {
      result.intent = section.lines.join("\n").trim();
    } else if (key === "assumptions") {
      result.assumptions = bullets(section.lines);
    } else if (key === "acceptance criteria") {
      result.acceptanceCriteria = parseAcceptance(section.lines);
    } else if (key === "open questions") {
      result.openQuestions = bullets(section.lines);
    }
    // unknown sections are intentionally left only in `raw`
  }
  return result;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Render + atomically write a ticket's requirements pad. Validates the ticket
 * exists first (board.getTask returns null for an unknown ticket → we throw).
 * Returns a compact summary with the path and section counts.
 */
export function setRequirements(board, project, ticket, spec = {}) {
  const task = board.getTask(project, ticket);
  if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);

  const intent = spec.intent || "";
  const assumptions = Array.isArray(spec.assumptions) ? spec.assumptions : [];
  const acceptanceCriteria = Array.isArray(spec.acceptanceCriteria) ? spec.acceptanceCriteria : [];
  const openQuestions = Array.isArray(spec.openQuestions) ? spec.openQuestions : [];

  ensureDir(requirementsDir(board, project));
  const p = requirementsPath(board, project, ticket);
  atomicWrite(p, renderRequirements(ticket, { intent, assumptions, acceptanceCriteria, openQuestions }));

  const parsed = getRequirements(board, project, ticket);
  return {
    ticket: task.ticketNumber,
    path: p,
    intent: parsed.intent,
    assumptions: parsed.assumptions.length,
    acceptanceCriteria: parsed.acceptanceCriteria.length,
    openQuestions: parsed.openQuestions.length,
  };
}

/**
 * Toggle the checkbox on acceptance criterion #index (1-based) and rewrite the
 * file in place. Operates on the raw text so hand-added unknown sections and any
 * hand edits survive the rewrite untouched — only the single checkbox marker on
 * the target acceptance-criterion line changes.
 */
export function checkAcceptance(board, project, ticket, index, done = true) {
  const p = requirementsPath(board, project, ticket);
  const raw = readFileSafe(p);
  if (raw == null) throw new Error(`No requirements found for ${ticket} in "${project}".`);

  const lines = raw.split(/\r?\n/);
  let inAcceptance = false;
  const acLineIdx = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.*)$/);
    if (h) {
      inAcceptance = h[1].trim().toLowerCase() === "acceptance criteria";
      continue;
    }
    if (inAcceptance && /^\s*[-*]\s*\[[ xX]\]\s*\S/.test(lines[i])) acLineIdx.push(i);
  }

  const n = Number(index);
  if (!Number.isInteger(n) || n < 1 || n > acLineIdx.length) {
    throw new Error(`Acceptance criterion #${index} out of range (1..${acLineIdx.length}) for ${ticket}.`);
  }
  const target = acLineIdx[n - 1];
  lines[target] = lines[target].replace(/(\[)[ xX](\])/, `$1${done ? "x" : " "}$2`);
  atomicWrite(p, lines.join("\n"));

  return getRequirementsSummary(board, project, ticket);
}

/** Compact summary of the current parsed state (used after a mutation). */
function getRequirementsSummary(board, project, ticket) {
  const parsed = getRequirements(board, project, ticket);
  return {
    ticket,
    path: requirementsPath(board, project, ticket),
    acceptanceCriteria: parsed ? parsed.acceptanceCriteria : [],
    done: parsed ? parsed.acceptanceCriteria.filter((c) => c.done).length : 0,
    total: parsed ? parsed.acceptanceCriteria.length : 0,
  };
}
