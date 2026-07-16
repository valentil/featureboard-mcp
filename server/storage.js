/**
 * FeatureBoard storage layer.
 *
 * Source of truth is markdown, byte-compatible with the original FeatureBoard app:
 *   - features live in  <project>/featurelist.md
 *   - bugs     live in  <project>/buglist.md
 *
 * A line looks like:
 *   - [ ] [FBF-12] **Title**: description 🔗 FBB-3 [Product: Core] [Labels: a, b] [Created: 2026-07-07 | Due: 2026-07-14]
 * with completion summaries appended before the metadata block:
 *   - [x] [FBF-12] **Title**: description Summary: what got done [Created: ... | Due: ...]
 *
 * A small JSON sidecar in <dataDir>/.featureboard/index.json caches the per-prefix
 * counter so ID allocation is fast, but the markdown is always re-scanned before
 * allocating to guarantee we never collide with IDs already present on disk.
 */

import fs from "node:fs";
import path from "node:path";

const FEATURE_FILE = "featurelist.md";
const BUG_FILE = "buglist.md";
const INDEX_DIR = ".featureboard";
const INDEX_FILE = "index.json";

// ---------------------------------------------------------------------------
// Parsing  (ported from the original js/parser.js, trimmed to the fields we use)
// ---------------------------------------------------------------------------

const LINE_RE =
  /^\s*(?:(?:-|\d+\.|\(\d+\)|\d+)\s+)?\[([ xXpP\-])\]\s*(?:\[?([A-Z][A-Z0-9\-]*\d+)\]?\s+)?(.*?)(?=\s*\[Created:|\s*Linked to:|\s*$)/;

function statusFromChar(ch) {
  const c = ch.toLowerCase();
  if (c === "x") return "Done";
  if (c === "p" || c === "-") return "In Progress";
  return "Todo";
}

function charFromStatus(status) {
  switch (status) {
    case "Done":
      return "x";
    case "In Progress":
      return "-";
    default:
      return " ";
  }
}

/** Parse one markdown file's content into an array of task objects. */
export function parseMarkdown(content, sourceFile) {
  const tasks = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (line.startsWith("#")) continue; // section header

    const match = line.match(LINE_RE);
    if (!match || !match[1]) continue;

    const status = statusFromChar(match[1]);
    const ticketNumber = match[2] || null;
    let titleAndDesc = match[3].trim();

    const rest = line.substring(match[0].length);
    const createdMatch = rest.match(/\[Created:\s*(\d{4}-\d{2}-\d{2})/);
    const dueMatch = rest.match(/\|\s*Due:\s*([^|\]]+)/);
    const completedMatch = rest.match(/\|\s*Completed\s*:\s*(\d{4}-\d{2}-\d{2})/);
    const productMatch = line.match(/\[Product:\s*([^\]]*)\]/);
    const labelsMatch = line.match(/\[Labels:\s*([^\]]*)\]/);
    const refMatch = line.match(/\[Ref:\s*([^\]]*)\]/);
    const priorityMatch = line.match(/\[Priority:\s*(\d+)\]/);
    const attachMatch = line.match(/\[Attachments:\s*([^\]]*)\]/);
    const newFileMatch = line.match(/\[NewFile:\s*([^\]]*)\]/i);
    const websiteMatch = line.match(/\[Website:\s*([^\]]*)\]/i);
    const linkEmoji = titleAndDesc.match(/🔗\s*([A-Z][A-Z0-9\-]*\d+)/);
    const linkWord = rest.match(/Linked to:\s*([A-Z][A-Z0-9\-]*\d+)/);

    // strip the link token out of the title/description text
    titleAndDesc = titleAndDesc.replace(/🔗\s*[A-Z][A-Z0-9\-]*\d+/, "").trim();

    let title = titleAndDesc;
    let description = "";

    if (titleAndDesc.includes("**")) {
      const boldMatch = titleAndDesc.match(/^\*\*([^*]+?)\*\*\s*[:-]?\s*([\s\S]*)/);
      if (boldMatch) {
        title = boldMatch[1].trim();
        description = boldMatch[2].trim();
      }
    } else if (titleAndDesc.includes(":")) {
      title = titleAndDesc.split(":")[0].trim();
      description = titleAndDesc.substring(titleAndDesc.indexOf(":") + 1).trim();
    }

    // strip inline metadata tokens the regex left inside the text
    const stripTokens = (s) =>
      s
        .replace(/\[Product:[^\]]*\]/g, "")
        .replace(/\[Labels:[^\]]*\]/g, "")
        .replace(/\[NewFile:[^\]]*\]/gi, "")
        .replace(/\[Website:[^\]]*\]/gi, "")
        .replace(/\[Attachments:[^\]]*\]/g, "")
        .replace(/\[Ref:[^\]]*\]/g, "")
        .replace(/\[Priority:[^\]]*\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    title = stripTokens(title);
    description = stripTokens(description);

    // completion summary (Done tasks): "... Summary: text"
    let completionSummary = null;
    if (description.includes("Summary:")) {
      const parts = description.split("Summary:");
      description = parts[0].trim();
      completionSummary = parts.slice(1).join("Summary:").trim();
    }

    tasks.push({
      ticketNumber,
      title,
      description,
      status,
      completionSummary,
      createdDate: createdMatch ? createdMatch[1] : null,
      dueDate: dueMatch
        ? dueMatch[1].trim() === "undefined"
          ? null
          : dueMatch[1].trim()
        : null,
      completionDate: completedMatch ? completedMatch[1] : null,
      product: productMatch ? productMatch[1].trim() : null,
      labels: labelsMatch
        ? labelsMatch[1].split(",").map((l) => l.trim()).filter(Boolean)
        : [],
      linkedIssue: (linkEmoji && linkEmoji[1]) || (linkWord && linkWord[1]) || null,
      ref: refMatch ? refMatch[1].trim() : null,
      priority: priorityMatch ? parseInt(priorityMatch[1], 10) : null,
      attachments: attachMatch
        ? attachMatch[1].split(",").map((a) => a.trim()).filter(Boolean)
        : [],
      // "new file" flag from the original app: build this feature in a new file.
      // null when the token is absent; a present [NewFile: false] round-trips as false.
      newFile: newFileMatch
        ? /^(true|yes|1|on)$/i.test(newFileMatch[1].trim())
        : null,
      website: websiteMatch ? websiteMatch[1].trim() || null : null,
      source: sourceFile,
      _raw: rawLine,
    });
  }
  return tasks;
}

/** Serialize a task object back into a single markdown line. */
export function serializeTask(t) {
  const statusChar = charFromStatus(t.status);
  const idPart = t.ticketNumber ? ` [${t.ticketNumber}]` : "";
  const link = t.linkedIssue ? ` 🔗 ${t.linkedIssue}` : "";
  const product = t.product ? ` [Product: ${t.product}]` : "";
  const labels = t.labels && t.labels.length ? ` [Labels: ${t.labels.join(", ")}]` : "";
  const newFile = t.newFile != null ? ` [NewFile: ${t.newFile}]` : "";
  const website = t.website ? ` [Website: ${t.website}]` : "";
  const ref = t.ref ? ` [Ref: ${t.ref}]` : "";
  const priority = t.priority != null ? ` [Priority: ${t.priority}]` : "";
  const attachments =
    t.attachments && t.attachments.length ? ` [Attachments: ${t.attachments.join(", ")}]` : "";
  const summary =
    t.status === "Done" && t.completionSummary ? ` Summary: ${t.completionSummary}` : "";

  const created = t.createdDate || new Date().toISOString().split("T")[0];
  const due = t.dueDate ? ` | Due: ${t.dueDate}` : "";
  const completed =
    t.status === "Done" && t.completionDate ? ` | Completed: ${t.completionDate}` : "";
  const meta = ` [Created: ${created}${due}${completed}]`;

  const descPart = t.description ? `: ${t.description}` : ":";
  return `- [${statusChar}]${idPart} **${t.title}**${descPart}${link}${product}${labels}${newFile}${website}${ref}${priority}${attachments}${summary}${meta}`;
}

// ---------------------------------------------------------------------------
// Import  (FBMCPF-55) — parse an external backlog into task field objects
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

// FBMCPB-10: due dates must be YYYY-MM-DD. Legacy boards carried prose in the
// due field, which breaks date sorting and range filters. Junk is remapped to
// the description (adds/imports) or rejected (explicit updates).
export const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function normalizeDueDate(value) {
  if (value == null || value === "") return { dueDate: null };
  const s = String(value).trim();
  if (DUE_DATE_RE.test(s)) return { dueDate: s };
  return { dueDate: null, overflow: s };
}

function normalizeImported(x) {
  if (typeof x === "string") return { title: x.trim() };
  if (!x || typeof x !== "object") return null;
  const due = normalizeDueDate(x.dueDate || x.due);
  let description = x.description != null ? String(x.description) : (x.desc != null ? String(x.desc) : undefined);
  if (due.overflow) description = description ? `${description} ${due.overflow}` : due.overflow; // junk due -> description
  const t = {
    title: String(x.title || x.name || "").trim(),
    description,
    product: x.product || undefined,
    dueDate: due.dueDate || undefined,
    labels: Array.isArray(x.labels) ? x.labels : undefined,
    status: x.status || undefined,
  };
  const p = parseInt(x.priority, 10);
  if (!isNaN(p)) t.priority = p;
  if (x.type && /bug/i.test(String(x.type))) t.type = "bug";
  else if (x.type && /feat/i.test(String(x.type))) t.type = "feature";
  return t.title ? t : null;
}

function parseImportMarkdown(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l))
    .map((l) => {
      const box = l.match(/\[([ xX~\-])\]/);
      const done = box && /[xX]/.test(box[1]);
      let s = l
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // bullet / numbered marker
        .replace(/^\[[ xX~\-]\]\s*/, "") // leading checkbox
        .replace(/\*\*/g, "")
        .trim();
      if (!s) return null;
      const m = s.match(/^(.*?):\s+(.*)$/);
      const t = m ? { title: m[1].trim(), description: m[2].trim() } : { title: s };
      if (done) t.status = "Done";
      return t.title ? t : null;
    })
    .filter(Boolean);
}

function parseImportCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 1) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const hasHeader = headers.some((h) => ["title", "name", "description", "desc", "product", "priority", "type", "due", "duedate", "labels", "status"].includes(h));
  const rows = hasHeader ? lines.slice(1) : lines;
  return rows
    .map((line) => {
      const cells = splitCsvLine(line);
      if (!hasHeader) return normalizeImported({ title: cells[0], description: cells[1], product: cells[2] });
      const row = {};
      headers.forEach((h, i) => (row[h] = (cells[i] || "").trim()));
      return normalizeImported({
        title: row.title || row.name,
        description: row.description || row.desc,
        product: row.product,
        dueDate: row.due || row.duedate,
        priority: row.priority,
        type: row.type,
        status: row.status,
        labels: row.labels ? row.labels.split(/[;|]/).map((x) => x.trim()).filter(Boolean) : undefined,
      });
    })
    .filter(Boolean);
}

function parseImportJson(text) {
  const data = JSON.parse(text);
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (data && (data.features || data.bugs || data.tasks)) {
    arr = [].concat(
      (data.features || []).map((x) => ({ ...(typeof x === "string" ? { title: x } : x), type: "feature" })),
      (data.bugs || []).map((x) => ({ ...(typeof x === "string" ? { title: x } : x), type: "bug" })),
      data.tasks || []
    );
  } else if (data && typeof data === "object") arr = [data];
  return arr.map(normalizeImported).filter(Boolean);
}

/**
 * Parse an external backlog (markdown checklist, CSV, or JSON) into an array of
 * task field objects ({title, description?, product?, dueDate?, priority?, labels?,
 * type?, status?}). `format` may be "auto" (default), "markdown", "csv" or "json".
 */
export function parseImport(content, format = "auto") {
  const text = String(content || "").trim();
  if (!text) return [];
  let fmt = format;
  if (fmt === "auto") {
    if (/^[[{]/.test(text)) fmt = "json";
    else {
      const first = text.split(/\r?\n/)[0];
      if (!/^\s*(?:[-*+]|\d+[.)]|\[)/.test(first) && first.includes(",")) fmt = "csv";
      else fmt = "markdown";
    }
  }
  if (fmt === "json") return parseImportJson(text);
  if (fmt === "csv") return parseImportCsv(text);
  return parseImportMarkdown(text);
}

// ---------------------------------------------------------------------------
// Testing helpers (FBMCPF-63/34/35/36) — pure, agent-native computations
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  ("the a an and or of to in for on with is are be this that it as at by from into your you our we add fix " +
   "make support enable allow build create update remove new feature bug board task ticket").split(/\s+/)
);
function keywords(s) {
  return [...new Set((String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOPWORDS.has(w)))];
}

/** Boilerplate test file (path + content) for a ticket — the "fixtest" port. */
export function suggestTestStub(task, codeLocation) {
  const slug =
    String(task.title || task.ticketNumber || "feature")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "feature";
  const base = codeLocation ? String(codeLocation).replace(/[\\/]+$/, "") : ".";
  const sep = base.includes("\\") ? "\\" : "/";
  const fileName = (task.ticketNumber ? task.ticketNumber + "-" : "") + slug + ".test.js";
  const path = base + sep + "test" + sep + fileName;
  const title = task.title || task.ticketNumber || "feature";
  const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const desc = task.description ? String(task.description).replace(/\s+/g, " ").trim() : "TODO: describe the behaviour under test";
  const content =
`import { test } from "node:test";
import assert from "node:assert/strict";

// ${task.ticketNumber ? task.ticketNumber + " — " : ""}${title}
// ${desc}
test("${safeTitle}", () => {
  // Arrange

  // Act

  // Assert
  assert.ok(true, "TODO: replace with a real assertion");
});
`;
  return { path, fileName, framework: "node:test", content };
}

/**
 * Split a free-text prompt into discrete testable behaviours: newlines/bullets
 * first, else sentence / "and" / ";" clauses. Strips a leading "should".
 */
export function splitBehaviors(text) {
  let parts = String(text || "").split(/\r?\n|(?:^|\s)[-*•]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) {
    parts = String(text || "").split(/[;.]\s+|,?\s+and\s+/i).map((x) => x.trim()).filter(Boolean);
  }
  parts = parts.map((x) => x.replace(/^(should|and)\s+/i, "").replace(/[.;]+$/, "").trim()).filter(Boolean);
  return parts.length ? parts : ["behaves as described"];
}

/**
 * Generate a FULL node:test file (path + content) from a prompt (or ticket) —
 * one test() block per described behaviour, not just the single boilerplate stub
 * of suggestTestStub. Optionally imports a target module. Pure; the tool writes it.
 */
export function generateTestFromPrompt({ prompt, ticket, title, module, codeLocation } = {}) {
  const desc = String(prompt || title || "").trim();
  if (!desc) throw new Error("a prompt (or title) is required to generate a test");
  const behaviors = splitBehaviors(desc);
  const nameBase = title || ticket || behaviors[0] || "feature";
  const slug = String(nameBase).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "feature";
  const base = codeLocation ? String(codeLocation).replace(/[\\/]+$/, "") : ".";
  const sep = base.includes("\\") ? "\\" : "/";
  const fileName = (ticket ? ticket + "-" : "") + slug + ".test.js";
  const filePath = base + sep + "test" + sep + fileName;
  const esc = (x) => String(x).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const importLine = module ? `import * as mod from "${esc(module)}";\n` : "";
  const header = `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${importLine}`;
  const suiteComment = `\n// ${ticket ? ticket + " — " : ""}${title || "generated test"}\n// From prompt: ${desc.replace(/\s+/g, " ").slice(0, 200)}\n`;
  const blocks = behaviors
    .map((b) => `test(${JSON.stringify(b)}, () => {\n  // Arrange\n\n  // Act\n\n  // Assert — TODO: verify that ${esc(b)}\n  assert.ok(true, ${JSON.stringify("TODO: implement — " + b)});\n});`)
    .join("\n\n");
  const content = header + suiteComment + blocks + "\n";
  return { path: filePath, fileName, framework: "node:test", behaviors, content };
}

/** Rank existing features by keyword overlap with a bug — the "bug impact scan". */
export function bugImpactScan(bug, features) {
  const bugKw = new Set(keywords((bug.title || "") + " " + (bug.description || "")));
  if (!bugKw.size) return [];
  return features
    .map((f) => {
      const fKw = keywords((f.title || "") + " " + (f.description || "") + " " + (f.product || ""));
      const overlaps = fKw.filter((w) => bugKw.has(w));
      let score = overlaps.length;
      if (bug.product && f.product && bug.product === f.product) score += 1;
      return { ticket: f.ticketNumber, title: f.title, status: f.status, score, overlaps };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

/** Group bugs under the feature they're linked to — the "regression manager" view. */
export function computeRegressions(bugs, features) {
  const featById = Object.fromEntries(features.map((f) => [f.ticketNumber, f]));
  const groups = {};
  const orphans = [];
  bugs.forEach((b) => {
    if (b.linkedIssue && featById[b.linkedIssue]) (groups[b.linkedIssue] = groups[b.linkedIssue] || []).push(b);
    else orphans.push(b);
  });
  const regressions = Object.keys(groups)
    .map((fid) => {
      const f = featById[fid];
      const list = groups[fid];
      return {
        feature: fid,
        title: f.title,
        featureStatus: f.status,
        openBugs: list.filter((b) => b.status !== "Done").length,
        bugs: list.map((b) => ({ ticket: b.ticketNumber, title: b.title, status: b.status })),
      };
    })
    .sort((a, b) => b.openBugs - a.openBugs || b.bugs.length - a.bugs.length);
  return { regressions, unlinkedBugs: orphans.map((b) => ({ ticket: b.ticketNumber, title: b.title, status: b.status })) };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Board (project) model
// ---------------------------------------------------------------------------

export class Board {
  /** @param {string} dataDir root folder containing project subfolders */
  constructor(dataDir) {
    if (!dataDir) throw new Error("FEATUREBOARD_DATA_DIR is not set.");
    this.dataDir = path.resolve(dataDir);
    ensureDir(this.dataDir);
  }

  // --- projects ---

  listProjects() {
    const entries = fs.existsSync(this.dataDir)
      ? fs.readdirSync(this.dataDir, { withFileTypes: true })
      : [];
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = path.join(this.dataDir, e.name);
      const hasFeatures = fs.existsSync(path.join(dir, FEATURE_FILE));
      const hasBugs = fs.existsSync(path.join(dir, BUG_FILE));
      if (hasFeatures || hasBugs) {
        projects.push({ name: e.name, prefix: this._prefixFor(e.name) });
      }
    }
    return projects;
  }

  projectDir(name) {
    const dir = path.join(this.dataDir, name);
    if (!path.resolve(dir).startsWith(this.dataDir)) {
      throw new Error(`Invalid project name: ${name}`);
    }
    return dir;
  }

  projectExists(name) {
    const dir = this.projectDir(name);
    return (
      fs.existsSync(path.join(dir, FEATURE_FILE)) ||
      fs.existsSync(path.join(dir, BUG_FILE))
    );
  }

  createProject(name, description) {
    const dir = this.projectDir(name);
    if (this.projectExists(name)) {
      throw new Error(`Project "${name}" already exists.`);
    }
    ensureDir(dir);
    const featureHeader = `# Feature List\n${description ? `\n${description}\n` : ""}`;
    const bugHeader = `# Bug List\n`;
    atomicWrite(path.join(dir, FEATURE_FILE), featureHeader);
    atomicWrite(path.join(dir, BUG_FILE), bugHeader);
    return { name, prefix: this._prefixFor(name) };
  }

  // --- prefix / id allocation ---

  /**
   * Project initials, matching the original FeatureBoard logic: split on
   * camelCase boundaries and separators, take the first letter of each part.
   * "FeatureBoard" -> "FB", "My New App" -> "MNA", "crm" -> "C".
   */
  _prefixFor(name) {
    const parts = name.split(/(?=[A-Z])|[\s_-]/).filter((x) => x.length > 0);
    let initials = parts.map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!initials) initials = "P";
    return initials;
  }

  _fileFor(type) {
    return type === "bug" ? BUG_FILE : FEATURE_FILE;
  }

  /**
   * The full ticket prefix for a type (e.g. "FBF" / "FBB"). Prefer the prefix
   * already used by existing tickets in the file so any board stays compatible
   * regardless of its folder name; fall back to the name-derived prefix.
   */
  _fullPrefix(name, type) {
    const suffix = type === "bug" ? "B" : "F";
    const content = readFileSafe(path.join(this.projectDir(name), this._fileFor(type)));
    if (content) {
      const counts = {};
      const re = /\[([A-Z][A-Z0-9]*)-\d+\]/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        counts[m[1]] = (counts[m[1]] || 0) + 1;
      }
      const dominant = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      if (dominant) return dominant;
    }
    return `${this._prefixFor(name)}${suffix}`;
  }

  /** Scan on-disk IDs (authoritative) and reconcile with the JSON index counter. */
  /** FBMCPB-11: ticket ids that appear more than once on the board. */
  findDuplicateTickets(name) {
    const dupes = [];
    for (const file of ["featurelist.md", "buglist.md"]) {
      const content = readFileSafe(path.join(this.projectDir(name), file));
      if (!content) continue;
      const seen = new Map();
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*- \[[ xX~\-]\]\s*\[([A-Za-z]+-\d+)\]\s*\*\*(.*?)\*\*/);
        if (!m) continue;
        const [, id, title] = m;
        if (seen.has(id)) dupes.push({ ticket: id, file, first: seen.get(id), duplicate: title });
        else seen.set(id, title);
      }
    }
    return dupes;
  }

  /** FBMCPB-11: renumber later occurrences of duplicated ids to fresh ids. */
  repairDuplicateTickets(name, { dryRun = true } = {}) {
    const changes = [];
    for (const file of ["featurelist.md", "buglist.md"]) {
      const type = file === "buglist.md" ? "bug" : "feature";
      const p = path.join(this.projectDir(name), file);
      const content = readFileSafe(p);
      if (!content) continue;
      const lines = content.split(/\r?\n/);
      const seen = new Set();
      let touched = false;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*- \[[ xX~\-]\]\s*)\[([A-Za-z]+-\d+)\]/);
        if (!m) continue;
        const id = m[2];
        if (!seen.has(id)) { seen.add(id); continue; }
        if (dryRun) { changes.push({ file, line: i + 1, from: id }); continue; }
        const fresh = this._nextId(name, type);
        lines[i] = lines[i].replace(`[${id}]`, `[${fresh}]`);
        seen.add(fresh);
        touched = true;
        changes.push({ file, line: i + 1, from: id, to: fresh });
      }
      if (touched) atomicWrite(p, lines.join("\n"));
    }
    return { dryRun, changes };
  }

  _nextId(name, type) {
    const fullPrefix = this._fullPrefix(name, type);
    const content = readFileSafe(path.join(this.projectDir(name), this._fileFor(type))) || "";
    const re = new RegExp(`\\[${fullPrefix}-(\\d+)\\]`, "g");
    let max = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
    const idx = this._readIndex();
    idx.counters = idx.counters || {};
    const cached = idx.counters[fullPrefix] || 0;
    const next = Math.max(max, cached) + 1;
    idx.counters[fullPrefix] = next;
    this._writeIndex(idx);
    return `${fullPrefix}-${next}`;
  }

  _readIndex() {
    const p = path.join(this.dataDir, INDEX_DIR, INDEX_FILE);
    const raw = readFileSafe(p);
    if (!raw) return { counters: {} };
    try {
      return JSON.parse(raw);
    } catch {
      return { counters: {} };
    }
  }

  _writeIndex(idx) {
    const dir = path.join(this.dataDir, INDEX_DIR);
    ensureDir(dir);
    atomicWrite(path.join(dir, INDEX_FILE), JSON.stringify(idx, null, 2));
  }

  // --- reading tasks ---

  _readTasks(name, type) {
    const file = this._fileFor(type);
    const content = readFileSafe(path.join(this.projectDir(name), file));
    if (content == null) return [];
    return parseMarkdown(content, file).map((t) => ({ ...t, type }));
  }

  listTasks(name, { type = "all", status, product, label, search } = {}) {
    if (!this.projectExists(name)) throw new Error(`Project "${name}" not found.`);
    let tasks = [];
    if (type === "all" || type === "feature") tasks = tasks.concat(this._readTasks(name, "feature"));
    if (type === "all" || type === "bug") tasks = tasks.concat(this._readTasks(name, "bug"));

    if (status) tasks = tasks.filter((t) => t.status.toLowerCase() === status.toLowerCase());
    if (product) tasks = tasks.filter((t) => (t.product || "").toLowerCase() === product.toLowerCase());
    if (label) tasks = tasks.filter((t) => t.labels.some((l) => l.toLowerCase() === label.toLowerCase()));
    if (search) {
      const q = search.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          (t.title || "").toLowerCase().includes(q) ||
          (t.description || "").toLowerCase().includes(q)
      );
    }
    tasks.sort((a, b) => ticketNum(b.ticketNumber) - ticketNum(a.ticketNumber));
    return tasks;
  }

  getTask(name, ticket) {
    const all = this.listTasks(name, {});
    return all.find((t) => t.ticketNumber === ticket) || null;
  }

  // --- writing tasks ---

  addTask(name, type, fields) {
    if (!this.projectExists(name)) throw new Error(`Project "${name}" not found.`);
    const ticketNumber = this._nextId(name, type);
    const due = normalizeDueDate(fields.dueDate);
    let description = fields.description || "";
    if (due.overflow) description = description ? `${description} ${due.overflow}` : due.overflow; // junk due -> description (FBMCPB-10)
    const task = {
      ticketNumber,
      title: fields.title,
      description,
      status: fields.status || "Todo",
      completionSummary: null,
      createdDate: new Date().toISOString().split("T")[0],
      dueDate: due.dueDate,
      completionDate: null,
      product: fields.product || null,
      labels: fields.labels || [],
      linkedIssue: fields.linkedIssue || null,
      ref: fields.ref || null,
      priority: fields.priority != null ? fields.priority : null,
      attachments: fields.attachments || [],
      newFile: fields.newFile != null ? fields.newFile : null,
      website: fields.website || null,
      type,
    };
    const file = this._fileFor(type);
    const filePath = path.join(this.projectDir(name), file);
    let content = readFileSafe(filePath);
    if (content == null) content = type === "bug" ? "# Bug List\n" : "# Feature List\n";
    const line = serializeTask(task);
    const sep = content.endsWith("\n") ? "" : "\n";
    atomicWrite(filePath, `${content}${sep}${line}\n`);
    // echo the authoritative written line so callers don't re-read the file
    return { ...task, line, _raw: line };
  }

  /** Rewrite the single line matching ticket, applying a transform fn(task)->task|null(delete). */
  _mutate(name, ticket, transform) {
    const type = ticketType(ticket);
    const file = this._fileFor(type);
    const filePath = path.join(this.projectDir(name), file);
    const content = readFileSafe(filePath);
    if (content == null) throw new Error(`Task ${ticket} not found (no ${file}).`);

    const lines = content.split(/\r?\n/);
    // FBMCPB-11: a duplicated id would make this update ambiguous — refuse.
    const tRe = new RegExp(`^\\s*- \\[[ xX~\\-]\\]\\s*\\[${escapeRe(ticket)}\\]`);
    const dupCount = lines.filter((l) => tRe.test(l)).length;
    if (dupCount > 1) throw new Error(`Ticket ${ticket} appears ${dupCount} times on this board — run repair_duplicate_ids first.`);
    let matched = false;
    let result = null;
    for (let i = 0; i < lines.length; i++) {
      if (!new RegExp(`\\[${escapeRe(ticket)}\\]`).test(lines[i])) continue;
      const parsed = parseMarkdown(lines[i], file)[0];
      if (!parsed) continue;
      matched = true;
      const updated = transform({ ...parsed, type });
      if (updated === null) {
        lines.splice(i, 1);
        // return the pre-delete task, flagged
        result = { ...parsed, type, deleted: true };
      } else {
        // rewrite the line and echo the authoritative post-write line back so
        // callers never see a stale checkbox (e.g. "- [ ]" after moving to Done)
        const newLine = serializeTask(updated);
        lines[i] = newLine;
        result = { ...updated, line: newLine, _raw: newLine };
      }
      break;
    }
    if (!matched) throw new Error(`Task ${ticket} not found.`);
    atomicWrite(filePath, lines.join("\n"));
    return result;
  }

  updateTask(name, ticket, fields) {
    return this._mutate(name, ticket, (t) => {
      if (fields.title != null) t.title = fields.title;
      if (fields.description != null) t.description = fields.description;
      if (fields.dueDate !== undefined) {
        const due = normalizeDueDate(fields.dueDate);
        if (due.overflow) throw new Error(`Invalid dueDate "${fields.dueDate}" — use YYYY-MM-DD, or null to clear.`);
        t.dueDate = due.dueDate;
      }
      if (fields.product !== undefined) t.product = fields.product;
      if (fields.labels != null) t.labels = fields.labels;
      if (fields.linkedIssue !== undefined) t.linkedIssue = fields.linkedIssue;
      if (fields.ref !== undefined) t.ref = fields.ref;
      if (fields.priority !== undefined) t.priority = fields.priority;
      if (fields.attachments != null) t.attachments = fields.attachments;
      if (fields.newFile !== undefined) t.newFile = fields.newFile;
      if (fields.website !== undefined) t.website = fields.website;
      return t;
    });
  }

  setStatus(name, ticket, status, completionSummary) {
    return this._mutate(name, ticket, (t) => {
      t.status = status;
      if (status === "Done") {
        if (completionSummary) t.completionSummary = completionSummary;
        t.completionDate = new Date().toISOString().split("T")[0];
      }
      return t;
    });
  }

  linkTasks(name, ticket, linkedIssue) {
    return this._mutate(name, ticket, (t) => {
      t.linkedIssue = linkedIssue;
      return t;
    });
  }

  deleteTask(name, ticket) {
    const existing = this.getTask(name, ticket);
    if (!existing) throw new Error(`Task ${ticket} not found.`);
    this._mutate(name, ticket, () => null);
    return existing;
  }

  // --- metrics ---

  getMetrics(name) {
    const features = this._readTasks(name, "feature");
    const bugs = this._readTasks(name, "bug");
    const count = (arr, s) => arr.filter((t) => t.status === s).length;
    return {
      project: name,
      features: {
        total: features.length,
        todo: count(features, "Todo"),
        inProgress: count(features, "In Progress"),
        done: count(features, "Done"),
      },
      bugs: {
        total: bugs.length,
        open: bugs.filter((t) => t.status !== "Done").length,
        closed: count(bugs, "Done"),
      },
      completedByDate: completionHistogram([...features, ...bugs]),
    };
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function ticketNum(ticket) {
  if (!ticket) return 0;
  const m = ticket.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

function ticketType(ticket) {
  const m = ticket.match(/([A-Z])-\d+$/);
  if (m && m[1] === "B") return "bug";
  return "feature";
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function completionHistogram(tasks) {
  const out = {};
  for (const t of tasks) {
    if (t.status === "Done" && t.completionDate) {
      out[t.completionDate] = (out[t.completionDate] || 0) + 1;
    }
  }
  return out;
}
