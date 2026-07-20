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
import { fileURLToPath } from "node:url";

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
/**
 * FBMCPF-260: explicit, user/agent-invoked version-update check against
 * featureboard.ai. NOT related to the narrative project updates above (same
 * file for historical reasons — "updates" — but a different feature; see the
 * check_updates tool in server/register/licensing.js, registered near
 * license_status/register_email).
 *
 * Egress contract (see docs/compliance/PRIVACY.md): checkUpdates makes AT
 * MOST one outbound HTTPS GET, and only when called — nothing here runs on a
 * timer, on import, or on server boot. The request carries no body and no
 * identifying data; it is a plain GET of a public JSON file.
 */

const UPDATES_CHECK_URL = "https://featureboard.ai/downloads/latest.json";
const CHECK_TIMEOUT_MS = 5000;

/**
 * Resolve the running server's own version from its package.json, relative to
 * THIS module (server/updates.js -> ../package.json) rather than process.cwd()
 * — the server may run from an unpacked bundle (Cowork plugin install, .mcpb
 * extraction, the IDE zip), and in every one of those layouts package.json
 * ships one directory up from server/, right alongside it. Never throws:
 * falls back to "0.0.0" so checkUpdates stays fail-soft even if package.json
 * is missing or unreadable.
 */
export function resolveCurrentVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/**
 * Compare two dotted, mostly-numeric version strings: -1 if a<b, 0 if equal,
 * 1 if a>b. Splits each on ".", compares segments left-to-right as integers
 * (a non-numeric/missing segment compares as 0), and pads the shorter string
 * with trailing zero segments so unequal lengths compare sanely
 * ("0.7" vs "0.7.0" => equal; "0.6.2" vs "0.7" => a<b).
 */
export function compareVersions(a, b) {
  const as = String(a == null ? "0" : a).split(".");
  const bs = String(b == null ? "0" : b).split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = Number.parseInt(as[i], 10) || 0;
    const bv = Number.parseInt(bs[i], 10) || 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * check_updates — fetch the stable release manifest and report whether a
 * newer FeatureBoard is available.
 *
 * `currentVersion` defaults to resolveCurrentVersion() (the running server's
 * own package.json); `url` defaults to the stable featureboard.ai manifest
 * location. Both are overridable, and `fetchImpl` is injectable, so tests can
 * exercise every path (available / up-to-date / network failure / malformed
 * JSON / timeout) without real network access — mirrors registerEmail
 * (server/registration.js) and notifySlack (server/slack.js).
 *
 * Fail-soft, like those two: this function NEVER throws. Any problem —
 * no fetch implementation, network error, non-2xx response, timeout, or a
 * response body that isn't valid JSON / doesn't carry a version — resolves to
 * { checked:false, reason, current }. Success resolves to
 * { checked:true, current, latest, updateAvailable, releasedAt, notes,
 *   downloads:{plugin,mcpZip}, recommendation }.
 */
export async function checkUpdates({ fetchImpl, currentVersion, url = UPDATES_CHECK_URL } = {}) {
  const current = currentVersion || resolveCurrentVersion();
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { checked: false, reason: "no fetch implementation available", current };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  let res;
  try {
    res = await doFetch(url, { method: "GET", signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const msg = err && err.name === "AbortError" ? `timed out after ${CHECK_TIMEOUT_MS / 1000}s` : (err && err.message) || String(err);
    return { checked: false, reason: `update check failed: ${msg}`, current };
  }
  clearTimeout(timer);

  if (!res || !res.ok) {
    const status = res && res.status != null ? res.status : "unknown";
    return { checked: false, reason: `update server responded with HTTP ${status}`, current };
  }

  let manifest;
  try {
    manifest = await res.json();
  } catch {
    return { checked: false, reason: "update manifest was not valid JSON", current };
  }

  const latest = manifest && manifest.version != null ? String(manifest.version) : null;
  if (!latest) {
    return { checked: false, reason: "update manifest did not include a version", current };
  }

  const updateAvailable = compareVersions(current, latest) < 0;
  const artifacts = (manifest && manifest.artifacts) || {};
  const downloads = {
    plugin: artifacts.plugin || "https://featureboard.ai/downloads/featureboard.plugin",
    mcpZip: artifacts.mcpZip || "https://featureboard.ai/downloads/featureboard-mcp.zip",
  };
  const recommendation = updateAvailable
    ? `Update available: v${latest} (you run v${current}) — Claude Cowork users: reinstall featureboard.plugin; Cursor/Grok users: featureboard-mcp.zip.`
    : `You're up to date (v${current}).`;

  return {
    checked: true,
    current,
    latest,
    updateAvailable,
    releasedAt: (manifest && manifest.releasedAt) || null,
    notes: (manifest && manifest.notes) || "",
    downloads,
    recommendation,
  };
}
