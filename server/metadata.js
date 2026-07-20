/**
 * FeatureBoard v0.3 metadata: project config, work log + velocity, health score.
 *
 * All functions take a Board instance (from storage.js) and a project name, and
 * work against the project's folder on disk:
 *   - <project>/agent_work_log.md   work events (tokens, additions/deletions per ticket)
 *   - <project>/project_config.json legacy config (read-only merge source)
 *   - <project>/.featureboard.config.json  MCP-managed config (products, settings)
 *
 * The work-log line format matches the original app so its analyzers still work:
 *   YYYY-MM-DD HH:MM:SS, <summary>, Task: FBF-1, Add: 2, Del: 0, tokens: 45000, inputTokens: 40000, outputTokens: 5000
 * grouped under "## [YYYY-MM-DD]" date headers.
 */

import fs from "node:fs";
import path from "node:path";
import { getRequirements } from "./requirements.js";
import { decisionsForTicket } from "./decisions.js";
import { handoffsFor } from "./handoffs.js";
import { matchKbForTicket } from "./kb.js";
import { unresolvedReviewComments } from "./reviews.js";
import { worktreeForTicket } from "./worktrees.js";

const WORK_LOG = "agent_work_log.md";
const LEGACY_CONFIG = "project_config.json";
const MANAGED_CONFIG = ".featureboard.config.json";

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
  // FBMCPF-162: write-through invalidation for the work-log parse cache below.
  // Harmless no-op for paths that were never cached (config/scratchpad/test
  // log writes also go through this function).
  workLogCache.delete(path.resolve(p));
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

// FBMCPF-120: "sprints" holds the sprint registry (name/start/end/goal)
const CONFIG_KEYS = ["products", "codeLocation", "agentModel", "description", "website", "featurePrefix", "bugPrefix", "customPrompt", "brandTitle", "brandSubtitle", "brandWords", "brandVoice", "brandPrimary", "brandAccent", "brandLogo", "brandFont", "imageTool", "sprints", "stage", "gitTargets", "worktreeDir", "requireReview", "requireCommitOnDone", "slackWebhook", "slackEvents", "pricing", "rules", "slaThresholds", "autoStatusOnCommit", "doneGates"];

/** Merged view: managed config overlaid on legacy project_config.json. */
export function getProjectConfig(board, project) {
  const dir = board.projectDir(project);
  let legacy = {};
  const lc = readFileSafe(path.join(dir, LEGACY_CONFIG));
  if (lc) {
    try {
      const j = JSON.parse(lc);
      legacy = {
        products: Array.isArray(j.products) ? j.products : [],
        codeLocation: j.codeLocation || null,
        agentModel: j.agentModel || null,
        website: j.website || null,
        featurePrefix: j.featurePrefix || null,
        bugPrefix: j.bugPrefix || null,
        customPrompt: j.customPrompt || null,
      };
    } catch {}
  }
  let managed = {};
  const mc = readFileSafe(path.join(dir, MANAGED_CONFIG));
  if (mc) {
    try {
      managed = JSON.parse(mc);
    } catch {}
  }
  const merged = { project };
  for (const k of CONFIG_KEYS) {
    if (managed[k] !== undefined) merged[k] = managed[k];
    else if (legacy[k] !== undefined && legacy[k] !== null) merged[k] = legacy[k];
  }
  merged.products = merged.products || [];
  return merged;
}

/** Write patch to the managed config (never touches legacy project_config.json). */
export function setProjectConfig(board, project, patch) {
  const dir = board.projectDir(project);
  const p = path.join(dir, MANAGED_CONFIG);
  let managed = {};
  const mc = readFileSafe(p);
  if (mc) {
    try {
      managed = JSON.parse(mc);
    } catch {}
  }
  for (const k of CONFIG_KEYS) {
    if (patch[k] !== undefined) managed[k] = patch[k];
  }
  managed.updatedAt = new Date().toISOString();
  atomicWrite(p, JSON.stringify(managed, null, 2));
  return getProjectConfig(board, project);
}

/** Normalize a color: bare/short hex -> #rrggbb lowercased; rgb()/hsl()/names pass through. */
export function normalizeColor(c) {
  if (c == null) return null;
  let v = String(c).trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(v)) v = "#" + v;
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  return v;
}

/**
 * Resolve a project's branding into a compact context for generation prompts.
 * Returns { title, subtitle, words: string[], voice, hasBrand, instruction } where
 * `instruction` is a ready-to-inject block telling the generator to weave the
 * configured brand words + voice into the asset. `hasBrand` is false when nothing
 * brand-related is configured, so callers can skip injection entirely.
 */
export function brandContext(board, project) {
  let cfg = {};
  try {
    cfg = getProjectConfig(board, project) || {};
  } catch {
    cfg = {};
  }
  const title = cfg.brandTitle || null;
  const subtitle = cfg.brandSubtitle || null;
  const words = Array.isArray(cfg.brandWords)
    ? cfg.brandWords.map((w) => String(w).trim()).filter(Boolean)
    : typeof cfg.brandWords === "string"
      ? cfg.brandWords.split(/[,\n]/).map((w) => w.trim()).filter(Boolean)
      : [];
  const voice = cfg.brandVoice ? String(cfg.brandVoice).trim() : null;
  const primary = normalizeColor(cfg.brandPrimary);
  const accent = normalizeColor(cfg.brandAccent);
  const logo = cfg.brandLogo ? String(cfg.brandLogo).trim() : null;
  const font = cfg.brandFont ? String(cfg.brandFont).trim() : null;
  const hasBrand = Boolean(title || subtitle || words.length || voice || primary || accent || logo || font);

  const cv = [];
  if (primary) cv.push(`--brand-primary:${primary}`);
  if (accent) cv.push(`--brand-accent:${accent}`);
  if (font) cv.push(`--brand-font:${font}`);
  const cssVars = cv.length ? `:root{${cv.join(";")}}` : "";

  let instruction = "";
  if (hasBrand) {
    const lines = ["Branding — weave the project's brand into this asset:"];
    if (title) lines.push(`- Brand name: ${title}${subtitle ? ` — ${subtitle}` : ""}`);
    if (words.length) lines.push(`- Brand/trial words to work in naturally (don't force all of them): ${words.join(", ")}`);
    if (voice) lines.push(`- Brand voice/tone: ${voice}`);
    if (primary || accent) lines.push(`- Brand colors: ${[primary && `primary ${primary}`, accent && `accent ${accent}`].filter(Boolean).join(", ")}`);
    if (font) lines.push(`- Brand font: ${font}`);
    if (logo) lines.push(`- Logo: ${logo}`);
    lines.push("- Reflect this in copy, headings, colors, and styling; keep it tasteful, not spammy.");
    instruction = lines.join("\n");
  }
  const swatch = (primary || accent)
    ? `<div style="display:flex;gap:10px;align-items:center;font:12px system-ui">` +
      [["primary", primary], ["accent", accent]].filter(([, c]) => c).map(([n, c]) =>
        `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:14px;height:14px;border-radius:3px;border:1px solid #0002;background:${c}"></span>${n} ${c}</span>`
      ).join("") + `</div>`
    : "";
  return { title, subtitle, words, voice, primary, accent, logo, font, hasBrand, cssVars, swatch, instruction };
}

export function addProduct(board, project, name) {
  const cfg = getProjectConfig(board, project);
  const products = cfg.products.slice();
  if (!products.some((p) => p.toLowerCase() === name.toLowerCase())) products.push(name);
  return setProjectConfig(board, project, { products });
}
export function removeProduct(board, project, name) {
  const cfg = getProjectConfig(board, project);
  const products = cfg.products.filter((p) => p.toLowerCase() !== name.toLowerCase());
  return setProjectConfig(board, project, { products });
}

// ---------------------------------------------------------------------------
// Scratchpad - freeform per-project notes (scratchpad.md)
// ---------------------------------------------------------------------------

const SCRATCHPAD = "scratchpad.md";

/** Read a project's scratchpad.md (empty string if none yet). */
export function getScratchpad(board, project) {
  const content = readFileSafe(path.join(board.projectDir(project), SCRATCHPAD)) || "";
  return { project, content, exists: content !== "", bytes: Buffer.byteLength(content, "utf8") };
}

/** Overwrite the scratchpad with new content (atomic). */
export function setScratchpad(board, project, content) {
  const body = content == null ? "" : String(content);
  atomicWrite(path.join(board.projectDir(project), SCRATCHPAD), body);
  return { project, content: body, bytes: Buffer.byteLength(body, "utf8") };
}

/** Append a line/block to the scratchpad, keeping existing content. */
export function appendScratchpad(board, project, text) {
  const p = path.join(board.projectDir(project), SCRATCHPAD);
  const existing = readFileSafe(p) || "";
  const addition = String(text || "").trim();
  const body = existing.trim()
    ? existing.replace(/\s*$/, "") + "\n" + addition + "\n"
    : addition + "\n";
  atomicWrite(p, body);
  return { project, content: body, bytes: Buffer.byteLength(body, "utf8") };
}

// ---------------------------------------------------------------------------
// Work log
// ---------------------------------------------------------------------------

function pad(n) {
  return String(n).padStart(2, "0");
}
function stamp(d = new Date()) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

/** Append a work-log entry in the legacy-compatible format. */
export function logWork(board, project, e) {
  const dir = board.projectDir(project);
  const p = path.join(dir, WORK_LOG);
  let content = readFileSafe(p) || "";
  const { date, time } = stamp();
  const parts = [`${date} ${time}`, (e.summary || "").replace(/\s+/g, " ").trim()];
  if (e.ticket) parts.push(`Task: ${e.ticket}`);
  if (e.additions != null) parts.push(`Add: ${e.additions}`);
  if (e.deletions != null) parts.push(`Del: ${e.deletions}`);
  if (e.tokens != null) parts.push(`tokens: ${e.tokens}`);
  if (e.inputTokens != null) parts.push(`inputTokens: ${e.inputTokens}`);
  if (e.outputTokens != null) parts.push(`outputTokens: ${e.outputTokens}`);
  if (e.model) parts.push(`model: ${e.model}`);
  // FBMCPF-188: commit_feature's enrichment threads the resulting commit's short
  // hash onto the work-log line it emits, so a ticket's history shows which commit
  // it produced without grepping git log for the ticket id.
  if (e.hash) parts.push(`commit:${e.hash}`);
  const line = parts.join(", ");

  // group under a "## [date]" header; add one if the file's latest header differs
  const header = `## [${date}]`;
  let out;
  if (!content.trim()) out = `${header}\n${line}\n`;
  else if (content.includes(header)) out = content.replace(/\s*$/, "") + `\n${line}\n`;
  else out = content.replace(/\s*$/, "") + `\n\n${header}\n${line}\n`;
  atomicWrite(p, out);
  return { date, time, line, ...e };
}

/**
 * FBMCPB-21: flag a probable work-log double-count. The recommended close-out
 * calls set_status Done (which writes a metrics line when given
 * additions/deletions) and THEN log_work — if both carry the same
 * additions/deletions for the same ticket on the same day, velocity counts that
 * one event twice. This returns the pre-existing matching entry so the caller
 * can surface a non-blocking `duplicateSuspected` warning. It never blocks: a
 * ticket legitimately worked across several sessions can repeat numbers, so we
 * only warn. Entries with neither additions nor deletions carry no metrics to
 * double-count and are ignored. Call this BEFORE appending the new entry.
 */
export function findDuplicateWorkEntry(board, project, entry) {
  if (!entry || !entry.ticket) return null;
  const add = entry.additions != null ? entry.additions : null;
  const del = entry.deletions != null ? entry.deletions : null;
  if (add == null && del == null) return null;
  const { date } = stamp();
  for (const e of readWorkLog(board, project)) {
    if (e.ticket !== entry.ticket || e.date !== date) continue;
    const eAdd = e.additions != null ? e.additions : null;
    const eDel = e.deletions != null ? e.deletions : null;
    if (eAdd === add && eDel === del) return e;
  }
  return null;
}

/** Parse the work log into structured entries. */
export function parseWorkLog(content) {
  const entries = [];
  if (!content) return entries;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const dm = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}),?\s*(.*)$/);
    if (!dm) continue;
    const rest = dm[3];
    const num = (re) => {
      const m = rest.match(re);
      return m ? parseInt(m[1], 10) : null;
    };
    const ticketM = rest.match(/Task:\s*([A-Z][A-Z0-9]*-\d+)/);
    const modelM = rest.match(/model:\s*([^,]+)/i);
    const hashM = rest.match(/commit:([0-9a-f]+)/i);
    entries.push({
      date: dm[1],
      time: dm[2],
      ticket: ticketM ? ticketM[1] : null,
      tokens: num(/(?:^|[,\s])tokens:\s*(\d+)/),
      inputTokens: num(/inputTokens:\s*(\d+)/),
      outputTokens: num(/outputTokens:\s*(\d+)/),
      additions: num(/(?:Add|additions):\s*(\d+)/i),
      deletions: num(/(?:Del|deletions):\s*(\d+)/i),
      model: modelM ? modelM[1].trim() : null,
      hash: hashM ? hashM[1] : null,
      text: rest.replace(/,?\s*(Task:|Add:|Del:|additions:|deletions:|tokens:|inputTokens:|outputTokens:|model:|commit:).*$/i, "").trim(),
    });
  }
  return entries;
}

// FBMCPF-162: mtime-keyed cache — readWorkLog() is called several times per
// tool invocation (get_work_packet, computeHealth, agentMonitor/V2,
// getTimelineData, ticketMetrics all read + re-parse the whole work log) and
// often several times per orchestrator session without the file changing in
// between. Same write-through + mtime/size-defense pattern as the caches in
// storage.js/events.js (FBMCPF-162); logWork()'s atomicWrite() invalidates
// this immediately after every append.
const workLogCache = new Map(); // absolute path -> { mtimeMs, size, entries }

export function readWorkLog(board, project) {
  const p = path.join(board.projectDir(project), WORK_LOG);
  const abs = path.resolve(p);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    workLogCache.delete(abs);
    return [];
  }
  const cached = workLogCache.get(abs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;
  }
  const entries = parseWorkLog(readFileSafe(abs));
  workLogCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  return entries;
}

/** Aggregate velocity from work-log entries. */
export function velocity(entries) {
  const byDate = {};
  const byTicket = {};
  let tokens = 0, additions = 0, deletions = 0, events = entries.length;
  for (const e of entries) {
    tokens += e.tokens || 0;
    additions += e.additions || 0;
    deletions += e.deletions || 0;
    const d = (byDate[e.date] = byDate[e.date] || { tokens: 0, additions: 0, deletions: 0, events: 0 });
    d.tokens += e.tokens || 0;
    d.additions += e.additions || 0;
    d.deletions += e.deletions || 0;
    d.events += 1;
    if (e.ticket) {
      const t = (byTicket[e.ticket] = byTicket[e.ticket] || { tokens: 0, additions: 0, deletions: 0, events: 0, model: null });
      t.tokens += e.tokens || 0;
      t.additions += e.additions || 0;
      t.deletions += e.deletions || 0;
      t.events += 1;
      if (e.model) t.model = e.model;
    }
  }
  const dates = Object.keys(byDate).sort();
  const recent = (days) => {
    const cut = Date.now() - days * 86400000;
    return dates.filter((d) => Date.parse(d) >= cut).reduce((s, d) => s + byDate[d].tokens, 0);
  };
  return {
    totals: { tokens, additions, deletions, events, activeDays: dates.length },
    tokensLast7Days: recent(7),
    tokensLast30Days: recent(30),
    byDate,
    byTicket,
  };
}

/** Metrics for a single ticket, from the work log. */
export function ticketMetrics(board, project, ticket) {
  const v = velocity(readWorkLog(board, project).filter((e) => e.ticket === ticket));
  const t = v.byTicket[ticket];
  return t || null;
}

// ---------------------------------------------------------------------------
// Testing center (FBMCPF-34) — record & read test runs
// ---------------------------------------------------------------------------

const TEST_LOG = "test_runs.md";

/** Append a structured test-run entry to <project>/test_runs.md. */
export function logTestRun(board, project, e) {
  const p = path.join(board.projectDir(project), TEST_LOG);
  const content = readFileSafe(p) || "# Test Runs\n";
  const { date, time } = stamp();
  const parts = [`${date} ${time}`, `passed: ${e.passed || 0}`, `failed: ${e.failed || 0}`];
  if (e.skipped != null) parts.push(`skipped: ${e.skipped}`);
  if (e.suite) parts.push(`suite: ${String(e.suite).replace(/,/g, " ")}`);
  if (e.ticket) parts.push(`Task: ${e.ticket}`);
  if (e.summary) parts.push((e.summary || "").replace(/\s+/g, " ").trim());
  const line = parts.join(", ");
  atomicWrite(p, content.replace(/\s*$/, "") + "\n" + line + "\n");
  return { date, time, line, ...e };
}

/** Parse test_runs.md into structured entries (most-recent last on disk). */
export function readTestRuns(board, project) {
  const content = readFileSafe(path.join(board.projectDir(project), TEST_LOG));
  const out = [];
  if (!content) return out;
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}),\s*(.*)$/);
    if (!m) continue;
    const rest = m[3];
    const num = (re) => { const x = rest.match(re); return x ? parseInt(x[1], 10) : null; };
    const suiteM = rest.match(/suite:\s*([^,]+)/);
    const ticketM = rest.match(/Task:\s*([A-Z][A-Z0-9]*-\d+)/);
    out.push({
      date: m[1], time: m[2],
      passed: num(/passed:\s*(\d+)/), failed: num(/failed:\s*(\d+)/), skipped: num(/skipped:\s*(\d+)/),
      suite: suiteM ? suiteM[1].trim() : null,
      ticket: ticketM ? ticketM[1] : null,
      text: rest,
    });
  }
  return out;
}

/** Summarize the latest test run + pass-rate trend. */
export function testSummary(board, project) {
  const runs = readTestRuns(board, project);
  if (!runs.length) return { runs: 0, latest: null, totalPassed: 0, totalFailed: 0 };
  const latest = runs[runs.length - 1];
  const totalPassed = runs.reduce((s, r) => s + (r.passed || 0), 0);
  const totalFailed = runs.reduce((s, r) => s + (r.failed || 0), 0);
  return { runs: runs.length, latest, totalPassed, totalFailed, passing: (latest.failed || 0) === 0 };
}

// ---------------------------------------------------------------------------
// Health score
// ---------------------------------------------------------------------------

/** Composite 0-100 health score with a breakdown. */
export function computeHealth(board, project) {
  const features = board.listTasks(project, { type: "feature" });
  const bugs = board.listTasks(project, { type: "bug" });
  const openBugs = bugs.filter((t) => t.status !== "Done").length;
  const openFeatures = features.filter((t) => t.status !== "Done").length;
  const doneFeatures = features.filter((t) => t.status === "Done").length;
  const log = readWorkLog(board, project);
  const v = velocity(log);
  // FBMCPF-190: token-telemetry coverage — share of the 30 most recent
  // work-log events that recorded a numeric token count. Entries with
  // tokens:null skew velocity and eval readouts (docs/EVIDENCE.md), so this
  // surfaces how trustworthy the token numbers currently are. null when there
  // are no work-log events yet (nothing to measure).
  const recentEvents = log.slice(-30);
  const withTokens = recentEvents.filter((e) => typeof e.tokens === "number").length;
  const tokenCoverage = recentEvents.length
    ? Math.round((withTokens / recentEvents.length) * 100)
    : null;

  // 1. Bug pressure: open bugs relative to total open work (fewer is better)
  const openTotal = openBugs + openFeatures;
  const bugRatio = openTotal ? openBugs / openTotal : 0;
  const bugScore = Math.round((1 - bugRatio) * 100);

  // 2. Progress: completed features vs all features
  const totalF = features.length || 1;
  const progressScore = Math.round((doneFeatures / totalF) * 100);

  // 3. Momentum: any token activity in the last 7 days
  const momentumScore = v.tokensLast7Days > 0 ? 100 : v.tokensLast30Days > 0 ? 60 : 20;

  // 4. Staleness: age of the oldest open ticket (younger is better)
  const openDates = [...features, ...bugs]
    .filter((t) => t.status !== "Done" && t.createdDate)
    .map((t) => Date.parse(t.createdDate))
    .filter((n) => !isNaN(n));
  let stalenessScore = 100;
  if (openDates.length) {
    const oldestDays = (Date.now() - Math.min(...openDates)) / 86400000;
    stalenessScore = Math.max(0, Math.round(100 - Math.min(oldestDays, 180) / 1.8));
  }

  const weights = { bugScore: 0.3, progressScore: 0.25, momentumScore: 0.25, stalenessScore: 0.2 };
  const score = Math.round(
    bugScore * weights.bugScore +
      progressScore * weights.progressScore +
      momentumScore * weights.momentumScore +
      stalenessScore * weights.stalenessScore
  );
  const grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";

  return {
    project,
    score,
    grade,
    tokenCoverage,
    breakdown: {
      bugPressure: { score: bugScore, openBugs, openFeatures },
      progress: { score: progressScore, doneFeatures, totalFeatures: features.length },
      momentum: { score: momentumScore, tokensLast7Days: v.tokensLast7Days, tokensLast30Days: v.tokensLast30Days },
      freshness: { score: stalenessScore },
    },
  };
}

// ---------------------------------------------------------------------------
// Agent monitor (FBMCPF-18) — surface currently-running (In Progress) work
// ---------------------------------------------------------------------------

/**
 * Pure core: given the In Progress tickets and the parsed work log, describe
 * each active ticket's latest activity, cumulative work, idle time, and whether
 * it looks stalled (In Progress but no recent progress). The original app
 * streamed `currentlyRunningTasks` over SSE; here the board's own state (status
 * + work log) is the source of truth, so this is a pull snapshot.
 */
export function computeActiveWork({ inProgress = [], log = [], asOf, stallHours = 24 } = {}) {
  const now = asOf ? new Date(asOf) : new Date();
  const active = inProgress.map((t) => {
    const entries = log.filter((e) => e.ticket === t.ticketNumber);
    const last = entries.length ? entries[entries.length - 1] : null; // log is oldest-first
    const work = entries.reduce(
      (a, e) => ({
        tokens: a.tokens + (e.tokens || 0),
        additions: a.additions + (e.additions || 0),
        deletions: a.deletions + (e.deletions || 0),
        events: a.events + 1,
      }),
      { tokens: 0, additions: 0, deletions: 0, events: 0 }
    );
    let idleHours = null;
    let stalled = true; // no activity yet => stalled until proven otherwise
    let lastActivity = null;
    if (last) {
      lastActivity = { date: last.date, time: last.time, summary: last.text, model: last.model };
      const ts = Date.parse(`${last.date}T${last.time}`);
      if (!isNaN(ts)) {
        idleHours = Math.round(((now - ts) / 3600000) * 10) / 10;
        stalled = idleHours > stallHours;
      } else {
        stalled = false;
      }
    }
    return {
      ticket: t.ticketNumber,
      title: t.title,
      product: t.product || null,
      priority: t.priority != null ? t.priority : null,
      dueDate: t.dueDate || null,
      lastActivity,
      idleHours,
      stalled,
      work,
    };
  });
  // most recently active first; never-touched / stalest sink to the bottom
  active.sort((a, b) => (a.idleHours == null ? Infinity : a.idleHours) - (b.idleHours == null ? Infinity : b.idleHours));
  return {
    project: null,
    asOf: now.toISOString(),
    activeCount: active.length,
    stalledCount: active.filter((a) => a.stalled).length,
    active,
  };
}

/** Board wrapper: monitor a project's currently-running (In Progress) tickets. */
export function agentMonitor(board, project, opts = {}) {
  const inProgress = board.listTasks(project, {}).filter((t) => t.status === "In Progress");
  const log = readWorkLog(board, project);
  const result = computeActiveWork({
    inProgress,
    log,
    asOf: opts.asOf,
    stallHours: opts.stallHours != null ? opts.stallHours : 24,
  });
  return { ...result, project };
}

// ---------------------------------------------------------------------------
// Work packet — a focused per-ticket brief for processing one ticket
// ---------------------------------------------------------------------------

const PATH_RE = /[A-Za-z]:\\[\\\w.\-]+|\/[\w./\-]+\.\w{1,5}/g;

// FBMCPF-125: local model hint (kept in sync with budget.js suggestModel; no import to avoid a cycle)
function suggestModelForPacket(t) {
  for (const l of t.labels || []) { const m = String(l).match(/^model:([a-z0-9._-]+)$/i); if (m) return m[1].toLowerCase(); }
  if (t.type === "bug") return "sonnet";
  if (/architect|schema|storage|server|parallel|orchestr|dependenc|refactor|migration|protocol/i.test(`${t.title} ${t.description || ""}`)) return "opus";
  const light = new Set(["Docs & Packaging", "Website", "Board UI", "Board UX", "Media", "Mail & Marketing"]);
  if (t.product && light.has(t.product)) return "sonnet";
  return t.priority != null && t.priority <= 3 ? "opus" : "sonnet";
}

/**
 * FBMCPF-149: resolve a project's git commit destinations. A project has TWO
 * ledgers that can live in different repos: the code (at codeLocation) and the
 * projectpad (the board's markdown files, in the boards data dir). Explicit
 * gitTargets config wins; otherwise we fall back to codeLocation / the project dir.
 * Returns { stage, codeRepo, padRepo, preflight }.
 */
export function resolveGitTargets(board, project) {
  let cfg = {};
  try {
    cfg = getProjectConfig(board, project) || {};
  } catch {
    cfg = {};
  }
  const stage = cfg.stage || "incubating";
  const gt = cfg.gitTargets || {};
  const codeRepo = gt.codeRepo || { path: cfg.codeLocation || null };
  const padRepo = gt.padRepo || { path: board.projectDir(project), note: "projectpad — the board's markdown files" };
  const preflight = `stage=${stage} · code commits → ${codeRepo.path || "(none)"} · pad commits → ${padRepo.path || "(none)"}`;
  return { stage, codeRepo, padRepo, preflight };
}

export function getWorkPacket(board, project, ticket, opts = {}) {
  const task = board.getTask(project, ticket);
  if (!task) throw new Error(`Ticket ${ticket} not found in "${project}".`);
  const cfg = getProjectConfig(board, project);

  const linkedTask = task.linkedIssue ? board.getTask(project, task.linkedIssue) : null;
  const linked = linkedTask
    ? {
        ticket: linkedTask.ticketNumber,
        title: linkedTask.title,
        status: linkedTask.status,
        description: linkedTask.description,
        completionSummary: linkedTask.completionSummary,
      }
    : task.linkedIssue || null;

  const scratch = readFileSafe(path.join(board.projectDir(project), "scratchpad.md"));
  const scratchpadMentions = scratch
    ? scratch.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l.toLowerCase().includes(ticket.toLowerCase()))
    : [];

  const recentWork = readWorkLog(board, project).filter((e) => e.ticket === ticket).slice(-10);

  const mentioned = new Set();
  const scan = (s) => { (String(s || "").match(PATH_RE) || []).forEach((p) => mentioned.add(p)); };
  scan(task.description);
  recentWork.forEach((e) => scan(e.text));
  const filesToRead = [cfg.codeLocation, ...mentioned].filter(Boolean);

  const definitionOfDone =
    task.type === "bug"
      ? ["Reproduce the issue", "Fix the root cause (edit at the code location, not projectpads)", "Verify the fix", "Add or adjust a test that would have caught it", "Record the fix in the completion summary"]
      : ["Implement the described behaviour", "Verify it works end to end", "Add or adjust a test", "Update docs if user-facing", "Summarize what was built"];

  // FBMCPF-138: if a requirements packet exists for this ticket, surface it and
  // make the definition of done ticket-specific — each acceptance criterion
  // (prefixed "AC:") plus the generic wrap-up item — instead of the generic list.
  let requirements = null;
  try {
    requirements = getRequirements(board, project, task.ticketNumber);
  } catch {
    requirements = null;
  }
  let effectiveDoD = definitionOfDone;
  if (requirements && requirements.acceptanceCriteria.length) {
    effectiveDoD = requirements.acceptanceCriteria
      .map((c) => `AC: ${c.text}`)
      .concat(definitionOfDone[definitionOfDone.length - 1]);
  }

  const packet = {
    ticket: task.ticketNumber,
    type: task.type,
    status: task.status,
    title: task.title,
    description: task.description,
    product: task.product,
    labels: task.labels,
    priority: task.priority,
    dueDate: task.dueDate,
    ref: task.ref,
    newFile: task.newFile,
    website: task.website,
    linked,
    project: {
      name: project,
      codeLocation: cfg.codeLocation || null,
      customPrompt: cfg.customPrompt || null,
      agentModel: cfg.agentModel || null,
      website: cfg.website || null,
    },
    filesToRead,
    gitTargets: resolveGitTargets(board, project),
    scratchpadMentions,
    recentWork,
    suggestedModel: suggestModelForPacket(task),
    definitionOfDone: effectiveDoD,
    closeOut:
      "When done: set_status Done with a one-line completionSummary, then log_work with additions/deletions (and model), and — when git is configured — commit per ticket (commit_feature, message referencing the ticket id). Only the orchestrator writes to the board; work one ticket at a time.",
  };
  if (requirements) packet.requirements = requirements;
  // FBMCPF-139/144: relevant ADRs + predecessor handoffs (only when non-empty)
  try {
    const decisions = decisionsForTicket(board, project, task.ticketNumber);
    if (decisions.length) packet.decisions = decisions;
    const handoffs = handoffsFor(board, project, task.ticketNumber);
    if (handoffs.length) packet.handoffs = handoffs;
    // FBMCPF-141: keyword-match kb/ docs against title/description/labels/product;
    // top few (title + short excerpt + path) only, so packets stay lean.
    const kbMatches = matchKbForTicket(board, project, task);
    if (kbMatches.length) packet.kbMatches = kbMatches;
    // FBMCPF-135: unresolved review comments the next agent must act on.
    const reviewComments = unresolvedReviewComments(board, project, task.ticketNumber);
    if (reviewComments.length) packet.reviewComments = reviewComments;
    // FBMCPF-136: when a git worktree exists for this ticket, surface its path,
    // branch and merge-back guidance so a parallel sub-agent edits there, not the repo.
    const wt = worktreeForTicket(board, project, task.ticketNumber);
    if (wt) packet.worktree = wt;
  } catch {}
  // FBMCPF-192: history-driven filesToRead hints — files that Done tickets
  // sharing this ticket's product/labels historically touched. Computed by the
  // caller (the git scan lives in git.js; importing it here would create a
  // metadata\u2194git cycle) and passed in, so getWorkPacket stays git-free.
  if (Array.isArray(opts.historicalFiles) && opts.historicalFiles.length) {
    packet.historicalFiles = opts.historicalFiles;
  }
  return packet;
}
