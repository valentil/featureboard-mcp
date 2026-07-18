/**
 * FBMCPF-199: narrative project updates — a Linear-style "project update" log
 * that lives between the heavier sprint close-out reports (reports.js).
 *
 * Updates live per project as a dated, append-only markdown log at:
 *
 *   <projectDir>/updates.md
 *
 * with entries of the form:
 *
 *   ## <YYYY-MM-DD> — <health>
 *
 *   <narrative>
 *
 * where health is one of on-track | at-risk | off-track. Mirrors the
 * decisions.js (FBMCPF-139) dated-pad-log + tool pattern and, like it, imports
 * ONLY node builtins (the Board + projectDir are passed in), so metadata.js /
 * index.js can import it freely without any require/import cycle.
 */

import fs from "node:fs";
import path from "node:path";

function readFileSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
function atomicWrite(p, content) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function pad(n) { return String(n).padStart(2, "0"); }
function todayISO(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

const UPDATES_FILE = "updates.md";
export const UPDATE_HEALTH = ["on-track", "at-risk", "off-track"];
export const UPDATE_STALE_DAYS = 7;

function updatesPath(board, project) {
  return path.join(board.projectDir(project), UPDATES_FILE);
}

function renderEntry(date, health, narrative) {
  return `## ${date} — ${health}\n\n${narrative}\n`;
}

/**
 * Parse a project's updates.md into a structured array (oldest-first, matching
 * on-disk order), or [] when the file is absent/empty. Text that isn't part of
 * a recognized `## <date> — <health>` entry is ignored, never fatal.
 */
export function listUpdates(board, project) {
  const raw = readFileSafe(updatesPath(board, project));
  if (raw == null) return [];
  const re = /^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+([a-z-]+)\s*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(raw))) {
    heads.push({ date: m[1], health: m[2].trim(), bodyStart: re.lastIndex, start: m.index });
  }
  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].start : raw.length;
    out.push({ date: cur.date, health: cur.health, narrative: raw.slice(cur.bodyStart, end).trim() });
  }
  return out;
}

/**
 * Append a narrative project update. Validates health is one of UPDATE_HEALTH
 * and that a narrative is present; writes atomically. Returns the created entry.
 */
export function postProjectUpdate(board, project, spec = {}) {
  const health = String(spec.health || "").trim().toLowerCase();
  const narrative = String(spec.narrative || "").trim();
  if (!UPDATE_HEALTH.includes(health)) {
    throw new Error(`health must be one of: ${UPDATE_HEALTH.join(", ")}`);
  }
  if (!narrative) throw new Error("A narrative is required.");
  const date = spec.date || todayISO();

  ensureDir(board.projectDir(project));
  const p = updatesPath(board, project);
  const prior = readFileSafe(p) || "";
  const entry = renderEntry(date, health, narrative);
  const body = prior.trim() ? prior.replace(/\s*$/, "") + "\n\n" + entry : entry;
  atomicWrite(p, body);
  return { date, health, narrative };
}

/**
 * The latest update plus staleness info, or null when none has ever been
 * posted. `stale` is true when the latest update is older than staleDays
 * (default 7), with a ready-to-surface staleHint string. Used by
 * get_metrics/get_health to keep the narrative status visible and to nudge for
 * a fresh update between sprint reports.
 */
export function getLatestUpdate(board, project, { now = new Date(), staleDays = UPDATE_STALE_DAYS } = {}) {
  const all = listUpdates(board, project);
  if (!all.length) return null;
  const latest = all[all.length - 1];
  let ageDays = null, stale = false;
  const then = Date.parse(latest.date + "T00:00:00Z");
  if (!Number.isNaN(then)) {
    ageDays = Math.floor((now.getTime() - then) / 86400000);
    stale = ageDays > staleDays;
  }
  return {
    latest,
    ageDays,
    stale,
    staleHint: stale ? `Last project update is ${ageDays}d old (>${staleDays}d) — consider post_project_update.` : null,
    count: all.length,
  };
}
