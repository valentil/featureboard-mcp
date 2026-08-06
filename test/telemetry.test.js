// FBMCPF-380 — anonymous opt-out usage telemetry (server/telemetry.js).
// Guards: stable anonymous install id, per-day per-tool counting, both opt-out
// kill switches, 24h batched send with pruning, failure tolerance, and — most
// importantly — that the payload never grows PII fields.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordToolCall,
  maybeSendTelemetry,
  getTelemetryStatus,
  telemetryEnabled,
  TELEMETRY_URL,
  _resetTelemetryCacheForTests,
} from "../server/telemetry.js";

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fb-tel-"));
}
function statePath(dir) {
  return path.join(dir, ".featureboard", "telemetry.json");
}
function readState(dir) {
  return JSON.parse(fs.readFileSync(statePath(dir), "utf8"));
}
function stubFetch({ ok = true, status = 200, throwErr = null } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    if (throwErr) throw throwErr;
    return { ok, status };
  };
  impl.calls = calls;
  return impl;
}
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  _resetTelemetryCacheForTests();
  delete process.env.FEATUREBOARD_TELEMETRY;
});

test("TELEMETRY_URL defaults to the featureboard.ai telemetry listener", () => {
  assert.equal(TELEMETRY_URL, "https://featureboard.ai/api/telemetry");
});

test("recordToolCall mints a stable anonymous install id and counts per day per tool", async () => {
  const dir = tmpDataDir();
  assert.equal(recordToolCall(dir, "get_board").recorded, true);
  recordToolCall(dir, "get_board");
  recordToolCall(dir, "next_task");
  const status1 = getTelemetryStatus(dir);
  assert.ok(/^[0-9a-f-]{36}$/.test(status1.installId), "installId should be a UUID");

  // Debounced flush: force it by waiting past FLUSH_DELAY_MS.
  await new Promise((r) => setTimeout(r, 1700));
  const st = readState(dir);
  assert.equal(st.installId, status1.installId);
  const days = Object.keys(st.days);
  assert.equal(days.length, 1);
  assert.equal(st.days[days[0]].get_board, 2);
  assert.equal(st.days[days[0]].next_task, 1);

  // A fresh cache (new process simulation) reads the SAME install id back.
  _resetTelemetryCacheForTests();
  assert.equal(getTelemetryStatus(dir).installId, status1.installId);
});

test("env kill switch disables counting and sending", async () => {
  const dir = tmpDataDir();
  process.env.FEATUREBOARD_TELEMETRY = "off";
  assert.equal(telemetryEnabled(dir), false);
  assert.equal(recordToolCall(dir, "get_board").recorded, false);
  const impl = stubFetch();
  const r = await maybeSendTelemetry(dir, { fetchImpl: impl });
  assert.equal(r.sent, false);
  assert.equal(impl.calls.length, 0);
  assert.ok(!fs.existsSync(statePath(dir)), "opted-out install should write nothing");
});

test("global-config kill switch (telemetry:false) disables; true/absent enables", () => {
  const dir = tmpDataDir();
  const cfgPath = path.join(dir, ".featureboard.global.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ telemetry: false }));
  assert.equal(telemetryEnabled(dir), false);
  assert.equal(recordToolCall(dir, "get_board").recorded, false);
  fs.writeFileSync(cfgPath, JSON.stringify({ telemetry: true }));
  assert.equal(telemetryEnabled(dir), true);
  fs.writeFileSync(cfgPath, "{not json");
  assert.equal(telemetryEnabled(dir), true, "malformed config falls back to default-enabled");
});

test("maybeSendTelemetry posts the batch, sets lastSentAt, prunes elapsed days, keeps today", async () => {
  const dir = tmpDataDir();
  recordToolCall(dir, "plan_work");
  // Seed an old day directly into the cached state via disk round-trip.
  await new Promise((r) => setTimeout(r, 1700));
  const st = readState(dir);
  st.days["2020-01-01"] = { next_task: 7 };
  fs.writeFileSync(statePath(dir), JSON.stringify(st));
  _resetTelemetryCacheForTests();

  const impl = stubFetch();
  const r = await maybeSendTelemetry(dir, { version: "9.9.9", fetchImpl: impl });
  assert.equal(r.sent, true);
  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].url, TELEMETRY_URL);
  const body = impl.calls[0].body;
  assert.equal(body.version, "9.9.9");
  assert.equal(body.days["2020-01-01"].next_task, 7);
  assert.equal(typeof body.installId, "string");

  const after = readState(dir);
  assert.ok(after.lastSentAt, "lastSentAt recorded");
  assert.equal(after.days["2020-01-01"], undefined, "elapsed day pruned after send");
  const today = Object.keys(after.days);
  assert.equal(today.length, 1, "today's partial counts stay local");
});

test("payload contains only the disclosed fields — no PII", async () => {
  const dir = tmpDataDir();
  recordToolCall(dir, "get_board");
  const impl = stubFetch();
  const r = await maybeSendTelemetry(dir, { fetchImpl: impl });
  assert.equal(r.sent, true);
  const keys = Object.keys(impl.calls[0].body).sort();
  assert.deepEqual(keys, ["days", "installId", "nodeVersion", "platform", "sentAt", "version"]);
  const raw = impl.calls[0].opts.body;
  assert.ok(!raw.includes(os.homedir().replaceAll("\\", "\\\\")), "no user paths in payload");
});

test("send is rate-limited to once per 24h and backs off after failure", async () => {
  const dir = tmpDataDir();
  recordToolCall(dir, "get_board");
  const t0 = Date.now();
  const okImpl = stubFetch();
  assert.equal((await maybeSendTelemetry(dir, { fetchImpl: okImpl, now: t0 })).sent, true);
  recordToolCall(dir, "get_board");
  const r2 = await maybeSendTelemetry(dir, { fetchImpl: okImpl, now: t0 + 60_000 });
  assert.equal(r2.sent, false);
  assert.match(r2.reason, /24h/);
  const r3 = await maybeSendTelemetry(dir, { fetchImpl: okImpl, now: t0 + DAY + 1 });
  assert.equal(r3.sent, true);
  assert.equal(okImpl.calls.length, 2);

  // Failure path: HTTP error → not sent, no throw, and an hour of backoff.
  _resetTelemetryCacheForTests();
  const dir2 = tmpDataDir();
  recordToolCall(dir2, "get_board");
  const badImpl = stubFetch({ ok: false, status: 500 });
  const f1 = await maybeSendTelemetry(dir2, { fetchImpl: badImpl, now: t0 });
  assert.equal(f1.sent, false);
  assert.match(f1.warning, /HTTP 500/);
  const f2 = await maybeSendTelemetry(dir2, { fetchImpl: badImpl, now: t0 + 60_000 });
  assert.match(f2.reason || "", /backing off/);
  assert.equal(badImpl.calls.length, 1, "no hammering a failing listener");

  // Network throw is equally tolerated.
  _resetTelemetryCacheForTests();
  const dir3 = tmpDataDir();
  recordToolCall(dir3, "get_board");
  const throwImpl = stubFetch({ throwErr: new Error("ECONNREFUSED") });
  const f3 = await maybeSendTelemetry(dir3, { fetchImpl: throwImpl, now: t0 });
  assert.equal(f3.sent, false);
  assert.match(f3.warning, /ECONNREFUSED/);
});

test("nothing to send → no network call", async () => {
  const dir = tmpDataDir();
  const impl = stubFetch();
  const r = await maybeSendTelemetry(dir, { fetchImpl: impl });
  assert.equal(r.sent, false);
  assert.match(r.reason, /nothing to send/);
  assert.equal(impl.calls.length, 0);
});

test("getTelemetryStatus reports disabled state without minting an install id", () => {
  const dir = tmpDataDir();
  process.env.FEATUREBOARD_TELEMETRY = "0";
  const s = getTelemetryStatus(dir);
  assert.deepEqual(
    { enabled: s.enabled, installId: s.installId, pendingDays: s.pendingDays },
    { enabled: false, installId: null, pendingDays: 0 }
  );
  assert.ok(!fs.existsSync(statePath(dir)));
});

test("PRIVACY.md discloses the telemetry endpoint and the opt-out switches", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const doc = fs.readFileSync(path.join(root, "docs", "compliance", "PRIVACY.md"), "utf8");
  assert.match(doc, /api\/telemetry/, "PRIVACY.md must disclose the telemetry endpoint");
  assert.match(doc, /FEATUREBOARD_TELEMETRY/, "PRIVACY.md must document the env opt-out");
  assert.ok(!/No analytics or telemetry\./.test(doc), "stale 'No analytics or telemetry' claim must be gone");
});
