/**
 * FeatureBoard PM bridge (FBMCPF-143) — import from Linear/Jira CSV exports
 * and export a board back out to json/csv/markdown.
 *
 * This module is intentionally standalone: it does not import anything that
 * mutates the board, and its only dependency on storage.js is the exported
 * `normalizeDueDate` helper (so "due date" columns get the same YYYY-MM-DD
 * validation the rest of the app uses). `splitCsvLine` is not exported from
 * storage.js, so a small local CSV splitter is implemented below.
 */

import { normalizeDueDate } from "./storage.js";

// ---------------------------------------------------------------------------
// CSV primitives
// ---------------------------------------------------------------------------

/** Split one CSV line, honouring double-quoted fields and "" escapes. */
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Quote a single CSV field only when it needs it. */
function csvField(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Parse CSV text into { headers (raw), rows (array of lowercase-keyed objects) }. */
function parseCsvRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h.trim().toLowerCase()] = (cells[i] != null ? cells[i] : "").trim();
    });
    return row;
  });
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Detect whether raw CSV text looks like a Linear export, a Jira export, or
 * neither ("generic"). Header matching is case-insensitive and by subset —
 * exact column sets vary between Linear/Jira workspace configurations.
 */
export function detectPmFormat(content) {
  const text = String(content || "").trim();
  if (!text) return "generic";
  const firstLine = text.split(/\r?\n/)[0];
  const headers = splitCsvLine(firstLine).map((h) => h.trim().toLowerCase());
  const has = (name) => headers.includes(name);

  // Jira: "Issue key" is essentially unique to Jira's CSV export; paired with
  // "Summary" (Jira's name for the title column) it's an unambiguous signal.
  if (has("issue key") && has("summary")) return "jira-csv";

  // Linear: Title + Status, plus either ID or Priority to avoid false
  // positives on generic "title,status" CSVs.
  if (has("title") && has("status") && (has("id") || has("priority"))) return "linear-csv";

  return "generic";
}

// ---------------------------------------------------------------------------
// Field normalization shared by both mappings
// ---------------------------------------------------------------------------

/**
 * Map an external status string onto FeatureBoard's four statuses. Anything
 * unrecognized (including empty/missing) falls through to "Todo", matching
 * both tools' "backlog" semantics.
 */
export function normalizePmStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (/done|complete|cancel/.test(s)) return "Done";
  if (/in progress|started/.test(s)) return "In Progress";
  if (/in review|^review$/.test(s)) return "Review";
  return "Todo";
}

/**
 * Map an external priority onto FeatureBoard's 1-4 numeric priority.
 * Numeric strings pass straight through; named priorities (Urgent/High/
 * Medium/Low, as used by both Linear and Jira) are mapped. Anything else
 * (blank, "None", "Lowest", ...) is left unset.
 */
export function normalizePmPriority(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const named = { urgent: 1, high: 2, medium: 3, low: 4 };
  const key = s.toLowerCase();
  return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : undefined;
}

/** Split a labels cell on comma or semicolon. */
function normalizePmLabels(raw) {
  return String(raw || "")
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Pull a normalized dueDate (YYYY-MM-DD) out of a row, trying a few common column names. */
function pmDueDate(row) {
  const raw = row["due date"] || row["duedate"] || row["due"] || row["target date"];
  if (!raw) return undefined;
  const { dueDate } = normalizeDueDate(raw);
  return dueDate || undefined;
}

function mapLinearRow(row) {
  const title = (row["title"] || "").trim();
  if (!title) return null;
  const t = { title };
  if (row["description"]) t.description = row["description"];
  if (row["id"]) t.ref = row["id"];
  t.status = normalizePmStatus(row["status"]);
  const priority = normalizePmPriority(row["priority"]);
  if (priority !== undefined) t.priority = priority;
  const labels = normalizePmLabels(row["labels"]);
  if (labels.length) t.labels = labels;
  const typeSrc = row["issue type"] != null ? row["issue type"] : row["type"];
  if (typeSrc && /bug/i.test(typeSrc)) t.type = "bug";
  const due = pmDueDate(row);
  if (due) t.dueDate = due;
  return t;
}

function mapJiraRow(row) {
  const title = (row["summary"] || "").trim();
  if (!title) return null;
  const t = { title };
  if (row["description"]) t.description = row["description"];
  if (row["issue key"]) t.ref = row["issue key"];
  t.status = normalizePmStatus(row["status"]);
  const priority = normalizePmPriority(row["priority"]);
  if (priority !== undefined) t.priority = priority;
  const labels = normalizePmLabels(row["labels"]);
  if (labels.length) t.labels = labels;
  if (Object.prototype.hasOwnProperty.call(row, "issue type")) {
    t.type = /bug/i.test(row["issue type"]) ? "bug" : "feature";
  }
  const due = pmDueDate(row);
  if (due) t.dueDate = due;
  return t;
}

function mapGenericRow(row) {
  const title = (row["title"] || row["name"] || row["summary"] || "").trim();
  if (!title) return null;
  const t = { title };
  const description = row["description"] || row["desc"];
  if (description) t.description = description;
  const ref = row["id"] || row["issue key"] || row["key"] || row["ref"];
  if (ref) t.ref = ref;
  if (row["product"]) t.product = row["product"];
  if (row["status"] != null && row["status"] !== "") t.status = normalizePmStatus(row["status"]);
  const priority = normalizePmPriority(row["priority"]);
  if (priority !== undefined) t.priority = priority;
  const labels = normalizePmLabels(row["labels"]);
  if (labels.length) t.labels = labels;
  const typeSrc = row["issue type"] != null ? row["issue type"] : row["type"];
  if (typeSrc && /bug/i.test(typeSrc)) t.type = "bug";
  const due = pmDueDate(row);
  if (due) t.dueDate = due;
  return t;
}

/**
 * Parse a Linear or Jira CSV export (or a generic CSV, best-effort) into an
 * array of task field objects: {title, description?, product?, dueDate?,
 * priority?, labels?, status?, type?, ref?}. Format is auto-detected via
 * detectPmFormat.
 */
export function parsePmImport(content) {
  const text = String(content || "").trim();
  if (!text) return [];
  const format = detectPmFormat(text);
  const { rows } = parseCsvRows(text);
  const mapper = format === "linear-csv" ? mapLinearRow : format === "jira-csv" ? mapJiraRow : mapGenericRow;
  return rows.map(mapper).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_COLUMNS = [
  "ticket", "title", "description", "status", "type", "product",
  "priority", "labels", "dueDate", "created", "completed", "ref", "linkedIssue",
];

function toExportRow(t) {
  return {
    ticket: t.ticketNumber || "",
    title: t.title || "",
    description: t.description || "",
    status: t.status || "Todo",
    type: t.type || "feature",
    product: t.product || "",
    priority: t.priority != null ? t.priority : "",
    labels: t.labels || [],
    dueDate: t.dueDate || "",
    created: t.createdDate || "",
    completed: t.completionDate || "",
    ref: t.ref || "",
    linkedIssue: t.linkedIssue || "",
  };
}

function toCsv(rows) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push(
      EXPORT_COLUMNS.map((c) => csvField(c === "labels" ? r.labels.join("; ") : r[c])).join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function toMarkdown(tasks) {
  const order = ["Todo", "In Progress", "Review", "Done"];
  const groups = Object.fromEntries(order.map((s) => [s, []]));
  for (const t of tasks) {
    const s = order.includes(t.status) ? t.status : "Todo";
    groups[s].push(t);
  }
  const lines = [];
  for (const s of order) {
    if (!groups[s].length) continue;
    lines.push(`## ${s}`);
    for (const t of groups[s]) {
      const box = s === "Done" ? "x" : " ";
      lines.push(`- [${box}] [${t.ticketNumber}] ${t.title}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Export a board's tasks as "json" | "csv" | "markdown". Read-only — takes an
 * already-constructed Board instance and never writes to disk.
 */
export function exportBoard(board, project, format = "json") {
  if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
  const tasks = board.listTasks(project, {});
  const rows = tasks.map(toExportRow);
  if (format === "json") return JSON.stringify(rows, null, 2);
  if (format === "csv") return toCsv(rows);
  if (format === "markdown") return toMarkdown(tasks);
  throw new Error(`Unknown export format: "${format}". Use json, csv, or markdown.`);
}
