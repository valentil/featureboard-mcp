/**
 * FeatureBoard usage telemetry — anonymous, opt-out, batched (FBMCPF-374/375/376).
 *
 * WHAT IS COLLECTED: per-day counts of which FeatureBoard TOOLS were called
 * (tool name -> count), plus a random anonymous install id, the server version,
 * process.platform and the Node major version. That is the entire payload.
 * No emails, no file paths, no board content, no ticket text, no arguments —
 * nothing a tool was called WITH, only that it was called. The install id is a
 * crypto.randomUUID() minted locally on first use and stored in
 * <dataDir>/.featureboard/telemetry.json next to registration.json; it is never
 * derived from, or joined to, the registration email or anything else.
 *
 * WHY: DAU/WAU/MAU and per-tool usage so development effort follows real usage
 * (see docs/compliance/PRIVACY.md for the user-facing disclosure).
 *
 * OPT-OUT (checked on every record AND every send — either kill switch fully
 * disables both counting and network):
 *   - env:    FEATUREBOARD_TELEMETRY=0|false|off|no|disabled
 *   - config: `telemetry: false` in <dataDir>/.featureboard.global.json
 *             (set via the set_global_config tool). Read raw here — not through
 *             git.js's getGlobalConfig — to keep this module import-cycle-free.
 *
 * TRANSPORT: local-first, daily batched. recordToolCall() only increments an
 * in-memory counter and debounce-flushes to telemetry.json; maybeSendTelemetry()
 * POSTs the accumulated days to TELEMETRY_URL at most once per 24h (5s timeout,
 * fire-and-forget). The receiver stores per (installId, day) with REPLACE
 * semantics, so re-sending today's partial counts tomorrow is safe. After a
 * successful send, fully-elapsed days are pruned locally.
 *
 * FAILURE-TOLERANT, mirroring registration.js: nothing here ever throws into a
 * tool call, and a network failure backs off for an hour rather than retrying
 * on every call. Multiple concurrent server processes sharing one dataDir may
 * clobber each other's counters occasionally — accepted; telemetry is
 * approximate by design.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STATE_DIR = ".featureboard";
const STATE_FILE = "telemetry.json";
const GLOBAL_CONFIG_FILE = ".featureboard.global.json"; // keep in sync with git.js
const POST_TIMEOUT_MS = 5000;
const SEND_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most one POST per 24h
const RETRY_BACKOFF_MS = 60 * 60 * 1000; // after a failed POST, wait an hour
const FLUSH_DELAY_MS = 1500; // debounce for counter writes
const KEEP_DAYS = 14; // local retention cap even if sends keep failing

export const TELEMETRY_URL =
  process.env.FEATUREBOARD_TELEMETRY_URL || "https://featureboard.ai/api/telemetry";

// ---------------------------------------------------------------------------
// enable / disable

const OFF_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

/** True unless the env var or the account-wide config opts out. Never throws. */
export function telemetryEnabled(dataDir) {
  const env = String(process.env.FEATUREBOARD_TELEMETRY || "").trim().toLowerCase();
  if (OFF_VALUES.has(env)) return false;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dataDir, GLOBAL_CONFIG_FILE), "utf8")
    );
    if (raw && raw.telemetry === false) return false;
  } catch {
    /* missing/malformed config -> default enabled */
  }
  return true;
}

// ---------------------------------------------------------------------------
// state (in-memory cache per dataDir, debounced flush to telemetry.json)

function statePath(dataDir) {
  return path.join(dataDir, STATE_DIR, STATE_FILE);
}

function pad(n) {
  return String(n).padStart(2, "0");
}
function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** dataDir -> { state, dirty, timer, nextAttemptAt, inFlight } */
const cache = new Map();
let exitHookInstalled = false;

function entryFor(dataDir) {
  let e = cache.get(dataDir);
  if (e) return e;
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
  } catch {
    /* first run or unreadable -> fresh state */
  }
  if (!state || typeof state !== "object") state = {};
  if (typeof state.installId !== "string" || !state.installId) {
    state.installId = crypto.randomUUID();
    state.createdAt = new Date().toISOString();
  }
  if (!state.days || typeof state.days !== "object") state.days = {};
  e = { state, dirty: true, timer: null, nextAttemptAt: 0, inFlight: false };
  cache.set(dataDir, e);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const [dir] of cache) {
        try {
          flushSync(dir);
        } catch {
          /* exiting anyway */
        }
      }
    });
  }
  return e;
}

/** Atomic-rename write of the cached state, if dirty. Never throws. */
function flushSync(dataDir) {
  const e = cache.get(dataDir);
  if (!e || !e.dirty) return;
  try {
    const p = statePath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(e.state, null, 2), "utf8");
    fs.renameSync(tmp, p);
    e.dirty = false;
  } catch {
    /* leave dirty; a later flush may succeed */
  }
}

function scheduleFlush(dataDir) {
  const e = cache.get(dataDir);
  if (!e || e.timer) return;
  e.timer = setTimeout(() => {
    e.timer = null;
    flushSync(dataDir);
  }, FLUSH_DELAY_MS);
  if (typeof e.timer.unref === "function") e.timer.unref();
}

/** Drop any days beyond the local retention window (oldest first). */
function pruneOldDays(state) {
  const keys = Object.keys(state.days).sort();
  while (keys.length > KEEP_DAYS) delete state.days[keys.shift()];
}

// ---------------------------------------------------------------------------
// public API

/**
 * Count one tool call for today. Cheap (in-memory increment + debounced write),
 * never throws, no-op when opted out.
 */
export function recordToolCall(dataDir, toolName) {
  try {
    if (!dataDir || !toolName) return { recorded: false };
    if (!telemetryEnabled(dataDir)) return { recorded: false, reason: "opted out" };
    const e = entryFor(dataDir);
    const day = todayISO();
    const bucket = e.state.days[day] || (e.state.days[day] = {});
    bucket[toolName] = (bucket[toolName] || 0) + 1;
    pruneOldDays(e.state);
    e.dirty = true;
    scheduleFlush(dataDir);
    return { recorded: true };
  } catch {
    return { recorded: false };
  }
}

/**
 * POST accumulated usage to TELEMETRY_URL if due (>=24h since last success,
 * >=1h since last failure, something to send, not opted out). Fire-and-forget
 * safe: never throws, never blocks a tool response when un-awaited.
 * `fetchImpl` / `now` are injectable for tests.
 */
export async function maybeSendTelemetry(dataDir, { version, fetchImpl, now } = {}) {
  try {
    if (!dataDir) return { sent: false, reason: "no dataDir" };
    if (!telemetryEnabled(dataDir)) return { sent: false, reason: "opted out" };
    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== "function") return { sent: false, reason: "no fetch implementation" };

    const e = entryFor(dataDir);
    const nowMs = typeof now === "number" ? now : Date.now();
    if (e.inFlight) return { sent: false, reason: "send already in flight" };
    if (nowMs < e.nextAttemptAt) return { sent: false, reason: "backing off after failure" };
    const last = e.state.lastSentAt ? Date.parse(e.state.lastSentAt) : 0;
    if (last && nowMs - last < SEND_INTERVAL_MS) return { sent: false, reason: "sent within 24h" };
    const dayKeys = Object.keys(e.state.days);
    if (dayKeys.length === 0) return { sent: false, reason: "nothing to send" };

    const payload = {
      installId: e.state.installId,
      version: version || null,
      platform: process.platform,
      nodeVersion: process.versions && process.versions.node ? process.versions.node : null,
      days: e.state.days,
      sentAt: new Date(nowMs).toISOString(),
    };

    e.inFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const res = await doFetch(TELEMETRY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res || !res.ok) {
        e.nextAttemptAt = nowMs + RETRY_BACKOFF_MS;
        const status = res && res.status != null ? res.status : "unknown";
        return { sent: false, warning: `telemetry listener responded with HTTP ${status}` };
      }
      // Success: fully-elapsed days are recorded server-side; today stays local
      // (its updated counts re-send tomorrow — receiver replaces per (id, day)).
      const today = todayISO(new Date(nowMs));
      for (const d of dayKeys) if (d < today) delete e.state.days[d];
      e.state.lastSentAt = new Date(nowMs).toISOString();
      e.dirty = true;
      flushSync(dataDir);
      return { sent: true, days: dayKeys.length };
    } catch (err) {
      e.nextAttemptAt = nowMs + RETRY_BACKOFF_MS;
      const msg =
        err && err.name === "AbortError" ? "timed out after 5s" : (err && err.message) || String(err);
      return { sent: false, warning: `telemetry POST failed: ${msg}` };
    } finally {
      clearTimeout(timer);
      e.inFlight = false;
    }
  } catch (err) {
    return { sent: false, warning: (err && err.message) || String(err) };
  }
}

/** Current telemetry state for surfacing on get_health (FBMCPF-378). Never throws. */
export function getTelemetryStatus(dataDir) {
  try {
    const enabled = telemetryEnabled(dataDir);
    if (!enabled) {
      // Do not mint an install id for an opted-out user just to report status.
      let installId = null;
      let lastSentAt = null;
      try {
        const raw = JSON.parse(fs.readFileSync(statePath(dataDir), "utf8"));
        installId = (raw && raw.installId) || null;
        lastSentAt = (raw && raw.lastSentAt) || null;
      } catch {
        /* none */
      }
      return { enabled: false, installId, lastSentAt, pendingDays: 0, endpoint: TELEMETRY_URL };
    }
    const e = entryFor(dataDir);
    return {
      enabled: true,
      installId: e.state.installId,
      lastSentAt: e.state.lastSentAt || null,
      pendingDays: Object.keys(e.state.days).length,
      endpoint: TELEMETRY_URL,
    };
  } catch {
    return { enabled: false, installId: null, lastSentAt: null, pendingDays: 0, endpoint: TELEMETRY_URL };
  }
}

/** Test hook: drop cached state so a fresh read hits disk. */
export function _resetTelemetryCacheForTests() {
  for (const [, e] of cache) if (e.timer) clearTimeout(e.timer);
  cache.clear();
}
